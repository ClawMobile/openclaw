import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import { sendMessageTelegram } from "./send.js";

type TaskKeyParams = {
  chatId: number;
  messageId: number;
  threadId?: number;
};

type TelegramBenchmarkNoticeParams = TaskKeyParams & {
  cfg: OpenClawConfig;
  token: string | undefined;
  accountId: string;
  api: Bot["api"];
};

const taskStartTimes = new Map<string, number>();
const MAX_TRACKED_TASKS = 512;
const SCREENSHOT_TIMEOUT_MS = 30_000;

function buildTaskKey(params: TaskKeyParams): string {
  return `${params.chatId}:${params.messageId}:${params.threadId ?? "root"}`;
}

function pruneTrackedTasks(): void {
  while (taskStartTimes.size > MAX_TRACKED_TASKS) {
    const oldestKey = taskStartTimes.keys().next().value;
    if (!oldestKey) {
      return;
    }
    taskStartTimes.delete(oldestKey);
  }
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(2)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = ((durationMs % 60_000) / 1000).toFixed(2);
  return `${minutes} min ${seconds} s`;
}

async function sendBenchmarkText(
  params: TelegramBenchmarkNoticeParams,
  text: string,
): Promise<void> {
  await sendMessageTelegram(String(params.chatId), text, {
    cfg: params.cfg,
    token: params.token,
    accountId: params.accountId,
    api: params.api,
    messageThreadId: params.threadId,
    replyToMessageId: params.messageId,
  });
}

function adbCommandArgs(args: string[]): string[] {
  const serial = process.env.DROIDRUN_SERIAL || process.env.ANDROID_SERIAL || "";
  return serial ? ["-s", serial, ...args] : args;
}

function benchmarkScreenshotPath(): string {
  const dir = resolvePreferredOpenClawTmpDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `telegram-benchmark-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
}

function normalizePngBuffer(buffer: Buffer): Buffer {
  const signature = "89504e470d0a1a0a";
  if (buffer.slice(0, 8).toString("hex") === signature) {
    return buffer;
  }
  const normalized = Buffer.from(buffer.toString("binary").replace(/\r\n/g, "\n"), "binary");
  return normalized.slice(0, 8).toString("hex") === signature ? normalized : buffer;
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const signature = "89504e470d0a1a0a";
  if (!buffer || buffer.length < 24 || buffer.slice(0, 8).toString("hex") !== signature) {
    return { width: 0, height: 0 };
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function runAdbScreenshotAttempt(args: string[], normalizeLineEndings: boolean): Promise<
  | { ok: true; path: string }
  | { ok: false; error: string }
> {
  return await new Promise((resolve) => {
    const child = spawn("adb", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    let done = false;

    const finish = (result: { ok: true; path: string } | { ok: false; error: string }) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({ ok: false, error: "timeout" });
    }, SCREENSHOT_TIMEOUT_MS);

    child.on("error", (error) => {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

    child.stdout.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (done) {
        return;
      }
      if (code !== 0 || chunks.length === 0) {
        finish({ ok: false, error: stderr.trim() || `exit_code_${code ?? -1}` });
        return;
      }

      const raw = Buffer.concat(chunks);
      const buffer = normalizeLineEndings ? normalizePngBuffer(raw) : raw;
      const dims = pngDimensions(buffer);
      if (dims.width <= 0 || dims.height <= 0) {
        finish({ ok: false, error: "invalid_png" });
        return;
      }

      const outPath = benchmarkScreenshotPath();
      try {
        fs.writeFileSync(outPath, buffer);
        finish({ ok: true, path: outPath });
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}

async function captureAdbScreenshot(): Promise<
  { ok: true; path: string } | { ok: false; error: string }
> {
  const attempts: Array<{ args: string[]; normalizeLineEndings: boolean }> = [
    { args: adbCommandArgs(["exec-out", "screencap", "-p"]), normalizeLineEndings: false },
    { args: adbCommandArgs(["shell", "screencap", "-p"]), normalizeLineEndings: true },
  ];

  let lastError = "unknown";
  for (const attempt of attempts) {
    const result = await runAdbScreenshotAttempt(attempt.args, attempt.normalizeLineEndings);
    if (result.ok) {
      return result;
    }
    lastError = result.error;
  }
  return { ok: false, error: lastError };
}

export async function announceTelegramTaskStarted(params: TelegramBenchmarkNoticeParams) {
  taskStartTimes.set(buildTaskKey(params), Date.now());
  pruneTrackedTasks();
  await sendBenchmarkText(params, "[benchmark] inbound_received\nTask started");
}

export async function announceTelegramTaskCompleted(params: TelegramBenchmarkNoticeParams) {
  const taskKey = buildTaskKey(params);
  const startedAtMs = taskStartTimes.get(taskKey);
  taskStartTimes.delete(taskKey);

  await sendBenchmarkText(params, "[benchmark] reply_delivered\nTask completed");

  if (typeof startedAtMs === "number") {
    await sendBenchmarkText(
      params,
      `[benchmark] Execution time: ${formatDurationMs(Math.max(0, Date.now() - startedAtMs))}`,
    );
  }

  const screenshot = await captureAdbScreenshot();
  if (!screenshot.ok) {
    await sendBenchmarkText(params, `[benchmark] Screenshot failed: ${screenshot.error}`);
    return;
  }

  try {
    await sendMessageTelegram(String(params.chatId), "[benchmark] Screenshot after task completion", {
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
      api: params.api,
      messageThreadId: params.threadId,
      replyToMessageId: params.messageId,
      mediaUrl: screenshot.path,
    });
  } finally {
    try {
      fs.unlinkSync(screenshot.path);
    } catch {}
  }
}