import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleClawBenchInbound } from "./inbound.js";
import {
  completeClawBenchRun,
  createClawBenchRun,
  failClawBenchRun,
  getClawBenchRunSnapshot,
  markClawBenchRunRunning,
} from "./runs.js";
import type { CoreConfig, ResolvedClawBenchChannelAccount } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;

type StartClawBenchHttpServerParams = {
  channelId: string;
  channelLabel: string;
  account: ResolvedClawBenchChannelAccount;
  config: CoreConfig;
  signal: AbortSignal;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
};

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isAuthorized(req: IncomingMessage, token?: string): boolean {
  if (!token) {
    return true;
  }
  const authorization = req.headers.authorization;
  if (authorization === `Bearer ${token}`) {
    return true;
  }
  return req.headers["x-openclaw-clawbench-token"] === token;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function routePath(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://clawbench.local");
}

async function handlePostRun(params: StartClawBenchHttpServerParams, req: IncomingMessage) {
  const body = await readJsonBody(req);
  const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  const deviceSerial =
    typeof body.device_serial === "string" && body.device_serial.trim()
      ? body.device_serial.trim()
      : undefined;
  if (!runId || !instruction) {
    return { statusCode: 400, body: { error: "run_id and instruction are required" } };
  }
  const run = createClawBenchRun({
    accountId: params.account.accountId,
    runId,
    instruction,
    deviceSerial,
  });
  queueMicrotask(() => {
    markClawBenchRunRunning({ accountId: params.account.accountId, runId });
    handleClawBenchInbound({
      channelId: params.channelId,
      channelLabel: params.channelLabel,
      account: params.account,
      config: params.config,
      run,
    })
      .then((result) => {
        completeClawBenchRun({
          accountId: params.account.accountId,
          runId,
          replyText: result.replyText,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        params.log?.error?.(
          `[${params.account.accountId}] clawbench run ${runId} failed: ${message}`,
        );
        failClawBenchRun({
          accountId: params.account.accountId,
          runId,
          error: message,
        });
      });
  });
  return { statusCode: 202, body: { run } };
}

async function requestHandler(
  params: StartClawBenchHttpServerParams,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (!isAuthorized(req, params.account.token)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const url = routePath(req);
    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, {
        ok: true,
        channel: params.channelId,
        accountId: params.account.accountId,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/runs") {
      const result = await handlePostRun(params, req);
      writeJson(res, result.statusCode, result.body);
      return;
    }
    const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/u);
    if (req.method === "GET" && runMatch) {
      const runId = decodeURIComponent(runMatch[1] ?? "");
      const run = getClawBenchRunSnapshot({
        accountId: params.account.accountId,
        runId,
      });
      if (!run) {
        writeJson(res, 404, { error: "run not found" });
        return;
      }
      writeJson(res, 200, { run });
      return;
    }
    writeJson(res, 404, { error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(res, 400, { error: message });
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startClawBenchHttpServer(
  params: StartClawBenchHttpServerParams,
): Promise<void> {
  const server = createServer((req, res) => {
    void requestHandler(params, req, res);
  });
  params.signal.addEventListener(
    "abort",
    () => {
      void close(server).catch(() => {});
    },
    { once: true },
  );
  await listen(server, params.account.host, params.account.port);
  params.log?.info?.(
    `[${params.account.accountId}] clawbench channel listening on ${params.account.baseUrl}`,
  );
  await new Promise<void>((resolve) => {
    server.once("close", resolve);
  });
}
