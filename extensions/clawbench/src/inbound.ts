import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type {
  ClawBenchJsonValue,
  ClawBenchRunLatency,
  ClawBenchRunMetrics,
  ClawBenchRunRecord,
  ClawBenchRunTrajectory,
  ClawBenchRunTrajectoryEvent,
} from "./runs.js";
import { getClawBenchChannelRuntime } from "./runtime.js";
import { buildClawBenchTarget } from "./target.js";
import type { CoreConfig, ResolvedClawBenchChannelAccount } from "./types.js";

export type ClawBenchInboundResult = {
  replyText?: string;
  latency: ClawBenchRunLatency;
  metrics: ClawBenchRunMetrics;
  trajectory: ClawBenchRunTrajectory;
};

const DEFAULT_RUNTIME_TRAJECTORY_MAX_BYTES = 1024 * 1024;
const DEFAULT_RUNTIME_TRAJECTORY_MAX_EVENTS = 200;

function elapsedMs(startAt: number, endAt: number): number {
  return Math.max(0, endAt - startAt);
}

function compactNumberRecord(
  value: Record<string, number | undefined> | undefined,
): Record<string, number> | undefined {
  if (!value) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, number] => {
    return typeof entry[1] === "number";
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTrajectoryPointerFilePath(sessionFile: string): string {
  return sessionFile.endsWith(".jsonl")
    ? `${sessionFile.slice(0, -".jsonl".length)}.trajectory-path.json`
    : `${sessionFile}.trajectory-path.json`;
}

function resolveAdjacentTrajectoryFilePath(sessionFile: string): string {
  return sessionFile.endsWith(".jsonl")
    ? `${sessionFile.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : `${sessionFile}.trajectory.jsonl`;
}

function readPointerRuntimeFile(sessionFile: string): string | undefined {
  try {
    const pointer = JSON.parse(
      fs.readFileSync(resolveTrajectoryPointerFilePath(sessionFile), "utf8"),
    ) as unknown;
    if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) {
      return undefined;
    }
    const runtimeFile = (pointer as { runtimeFile?: unknown }).runtimeFile;
    return typeof runtimeFile === "string" && runtimeFile.trim() ? runtimeFile : undefined;
  } catch {
    return undefined;
  }
}

function resolveRuntimeTrajectoryFile(sessionFile: string): string | undefined {
  const candidates = [
    readPointerRuntimeFile(sessionFile),
    resolveAdjacentTrajectoryFilePath(sessionFile),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function readFileTail(params: { filePath: string; maxBytes: number }): {
  text: string;
  fileBytes: number;
  fileTruncated: boolean;
} {
  const stats = fs.statSync(params.filePath);
  if (stats.size <= params.maxBytes) {
    return {
      text: fs.readFileSync(params.filePath, "utf8"),
      fileBytes: stats.size,
      fileTruncated: false,
    };
  }

  const fd = fs.openSync(params.filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(params.maxBytes);
    fs.readSync(fd, buffer, 0, params.maxBytes, stats.size - params.maxBytes);
    const tail = buffer.toString("utf8");
    const firstNewline = tail.indexOf("\n");
    return {
      text: firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail,
      fileBytes: stats.size,
      fileTruncated: true,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readRuntimeTrajectorySnapshot(params: {
  runtime: ReturnType<typeof getClawBenchChannelRuntime>;
  storePath: string;
  sessionKey: string;
  agentId: string;
  at: number;
}): ClawBenchRunTrajectoryEvent | undefined {
  try {
    const store = params.runtime.agent.session.loadSessionStore(params.storePath, {
      skipCache: true,
    });
    const entry = store[params.sessionKey];
    if (!entry?.sessionId) {
      return undefined;
    }
    const sessionFile = params.runtime.agent.session.resolveSessionFilePath(
      entry.sessionId,
      entry,
      {
        agentId: params.agentId,
        sessionsDir: path.dirname(path.resolve(params.storePath)),
      },
    );
    const runtimeFile = resolveRuntimeTrajectoryFile(sessionFile);
    if (!runtimeFile) {
      return undefined;
    }

    const maxBytes = positiveIntegerEnv(
      "CLAWBENCH_RUNTIME_TRAJECTORY_MAX_BYTES",
      DEFAULT_RUNTIME_TRAJECTORY_MAX_BYTES,
    );
    const maxEvents = positiveIntegerEnv(
      "CLAWBENCH_RUNTIME_TRAJECTORY_MAX_EVENTS",
      DEFAULT_RUNTIME_TRAJECTORY_MAX_EVENTS,
    );
    const { text, fileBytes, fileTruncated } = readFileTail({
      filePath: runtimeFile,
      maxBytes,
    });
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    let parseErrorCount = 0;
    const parsedEvents = lines.flatMap((line): ClawBenchJsonValue[] => {
      try {
        return [JSON.parse(line) as ClawBenchJsonValue];
      } catch {
        parseErrorCount += 1;
        return [];
      }
    });
    const returnedEvents =
      parsedEvents.length > maxEvents ? parsedEvents.slice(-maxEvents) : parsedEvents;
    return {
      event: "runtime.trajectory",
      at: params.at,
      sessionKey: params.sessionKey,
      sessionId: entry.sessionId,
      sessionFile,
      runtimeFile,
      fileBytes,
      fileTruncated,
      observedEventCount: lines.length,
      parsedEventCount: parsedEvents.length,
      returnedEventCount: returnedEvents.length,
      eventsTruncated: parsedEvents.length > returnedEvents.length,
      parseErrorCount,
      events: returnedEvents,
    };
  } catch (error) {
    return {
      event: "runtime.trajectory.unavailable",
      at: params.at,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleClawBenchInbound(params: {
  channelId: string;
  channelLabel: string;
  account: ResolvedClawBenchChannelAccount;
  config: CoreConfig;
  run: ClawBenchRunRecord;
}): Promise<ClawBenchInboundResult> {
  const runningStartedAt = Date.now();
  const trajectory: ClawBenchRunTrajectory = [
    {
      event: "run.created",
      at: params.run.createdAt,
      status: "QUEUED",
    },
    {
      event: "run.running",
      at: runningStartedAt,
      status: "RUNNING",
    },
  ];
  const runtime = getClawBenchChannelRuntime();
  const target = buildClawBenchTarget({ runId: params.run.runId });
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    peer: {
      kind: "direct",
      id: target,
    },
  });
  const storePath = runtime.channel.session.resolveStorePath(params.config.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: params.channelLabel,
    from: "ClawBench",
    timestamp: params.run.createdAt,
    previousTimestamp,
    envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(params.config as OpenClawConfig),
    body: params.run.instruction,
  });
  const replies: string[] = [];
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.run.instruction,
    RawBody: params.run.instruction,
    CommandBody: params.run.instruction,
    From: target,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.account.accountId,
    ChatType: "direct",
    ConversationLabel: `ClawBench ${params.run.runId}`,
    SenderName: "ClawBench",
    SenderId: "clawbench",
    Provider: params.channelId,
    Surface: params.channelId,
    MessageSid: params.run.runId,
    MessageSidFull: params.run.runId,
    Timestamp: params.run.createdAt,
    OriginatingChannel: params.channelId,
    OriginatingTo: target,
    CommandAuthorized: true,
  });

  const dispatchStartedAt = Date.now();
  trajectory.push({
    event: "dispatch.started",
    at: dispatchStartedAt,
    routeSessionKey: route.sessionKey,
    agentId: route.agentId,
  });
  const dispatchResult = await dispatchInboundReplyWithBase({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    route,
    storePath,
    ctxPayload,
    core: runtime,
    deliver: async (payload) => {
      const text =
        payload && typeof payload === "object" && "text" in payload
          ? ((payload as { text?: string }).text ?? "")
          : "";
      if (text.trim()) {
        replies.push(text);
        trajectory.push({
          event: "reply.delivered",
          at: Date.now(),
          index: replies.length,
          text,
        });
      }
    },
    onRecordError: (error) => {
      throw error instanceof Error
        ? error
        : new Error(`clawbench session record failed: ${String(error)}`);
    },
    onDispatchError: (error) => {
      throw error instanceof Error
        ? error
        : new Error(`clawbench dispatch failed: ${String(error)}`);
    },
  });

  const dispatchCompletedAt = Date.now();
  const failedDispatchCounts = compactNumberRecord(dispatchResult.dispatchResult.failedCounts);
  const dispatchSummary: ClawBenchRunMetrics = {
    admission: dispatchResult.admission.kind,
    queuedFinal: dispatchResult.dispatchResult.queuedFinal,
    dispatchCounts: dispatchResult.dispatchResult.counts,
  };
  if (failedDispatchCounts) {
    dispatchSummary.failedDispatchCounts = failedDispatchCounts;
  }
  if (dispatchResult.dispatchResult.sourceReplyDeliveryMode) {
    dispatchSummary.sourceReplyDeliveryMode = dispatchResult.dispatchResult.sourceReplyDeliveryMode;
  }
  const runtimeTrajectory = readRuntimeTrajectorySnapshot({
    runtime,
    storePath,
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    at: dispatchCompletedAt,
  });
  trajectory.push({
    event: "dispatch.completed",
    at: dispatchCompletedAt,
    ...dispatchSummary,
  });
  if (runtimeTrajectory) {
    trajectory.push(runtimeTrajectory);
  }

  const replyText = replies.join("\n\n") || undefined;
  const completedAt = Date.now();
  trajectory.push({
    event: "run.completed",
    at: completedAt,
    status: "COMPLETED",
  });

  const latency: ClawBenchRunLatency = {
    queueMs: elapsedMs(params.run.createdAt, runningStartedAt),
    dispatchMs: elapsedMs(dispatchStartedAt, dispatchCompletedAt),
    totalMs: elapsedMs(params.run.createdAt, completedAt),
  };
  const metrics: ClawBenchRunMetrics = {
    replyCount: replies.length,
    replyTextChars: replyText?.length ?? 0,
    ...dispatchSummary,
  };
  if (runtimeTrajectory) {
    metrics.runtimeTrajectory = {
      available: runtimeTrajectory.event === "runtime.trajectory",
      sessionId: runtimeTrajectory.sessionId ?? null,
      observedEventCount: runtimeTrajectory.observedEventCount ?? 0,
      parsedEventCount: runtimeTrajectory.parsedEventCount ?? 0,
      returnedEventCount: runtimeTrajectory.returnedEventCount ?? 0,
      fileBytes: runtimeTrajectory.fileBytes ?? 0,
      fileTruncated: runtimeTrajectory.fileTruncated ?? false,
      eventsTruncated: runtimeTrajectory.eventsTruncated ?? false,
      parseErrorCount: runtimeTrajectory.parseErrorCount ?? 0,
      error: runtimeTrajectory.error ?? null,
    };
  }

  return { replyText, latency, metrics, trajectory };
}
