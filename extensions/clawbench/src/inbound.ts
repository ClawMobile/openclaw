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
const DEFAULT_RUNTIME_TRAJECTORY_MAX_STEPS = 200;
const DEFAULT_RUNTIME_TRAJECTORY_TEXT_MAX_CHARS = 4096;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function compactText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function compactJsonValue(value: unknown, maxTextChars: number, depth = 0): ClawBenchJsonValue {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return compactText(value, maxTextChars) ?? "";
  }
  if (depth >= 4) {
    return { truncated: true, reason: "trajectory-depth-limit" };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => compactJsonValue(item, maxTextChars, depth + 1));
    if (value.length > items.length) {
      items.push({
        truncated: true,
        reason: "trajectory-array-limit",
        originalLength: value.length,
      });
    }
    return items;
  }
  if (isRecord(value)) {
    const result: Record<string, ClawBenchJsonValue> = {};
    const entries = Object.entries(value).slice(0, 40);
    for (const [key, item] of entries) {
      result[key] = compactJsonValue(item, maxTextChars, depth + 1);
    }
    if (Object.keys(value).length > entries.length) {
      result._truncated = {
        truncated: true,
        reason: "trajectory-object-key-limit",
        originalKeys: Object.keys(value).length,
      };
    }
    return result;
  }
  return String(value);
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textParts = content.flatMap((item): string[] => {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return [item.text];
    }
    return [];
  });
  return textParts.join("\n") || undefined;
}

function parseJsonText(text: string | undefined): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function summarizeToolResult(content: unknown, maxTextChars: number): ClawBenchJsonValue {
  const text = textFromContent(content);
  const parsed = parseJsonText(text);
  if (!isRecord(parsed)) {
    return { text: compactText(text, maxTextChars) ?? "" };
  }

  const summary: Record<string, ClawBenchJsonValue> = {};
  for (const key of ["ok", "status", "code", "stdout", "stderr", "mode", "stage", "method"]) {
    if (key in parsed) {
      summary[key] = compactJsonValue(parsed[key], maxTextChars);
    }
  }
  const backends = parsed.backends;
  if (isRecord(backends) && isRecord(backends.adb)) {
    summary.adb = {
      ready: compactJsonValue(backends.adb.ready, maxTextChars),
      state: compactJsonValue(backends.adb.state, maxTextChars),
      deviceCount: Array.isArray(backends.adb.devices) ? backends.adb.devices.length : 0,
    };
  }
  return Object.keys(summary).length ? summary : compactJsonValue(parsed, maxTextChars);
}

function compactMessagesSnapshot(messages: unknown, maxTextChars: number): ClawBenchJsonValue[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const steps: ClawBenchJsonValue[] = [];
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const role = typeof message.role === "string" ? message.role : undefined;
    const at = typeof message.timestamp === "number" ? message.timestamp : undefined;
    if (role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!isRecord(item)) {
          continue;
        }
        if (item.type === "toolCall") {
          steps.push({
            type: "tool.call",
            at: at ?? null,
            toolName: typeof item.name === "string" ? item.name : "",
            arguments: compactJsonValue(item.arguments, maxTextChars),
          });
        } else if (item.type === "text" && typeof item.text === "string") {
          steps.push({
            type: "assistant.text",
            at: at ?? null,
            text: compactText(item.text, maxTextChars) ?? "",
          });
        }
      }
    } else if (role === "toolResult") {
      steps.push({
        type: "tool.result",
        at: at ?? null,
        toolName: typeof message.toolName === "string" ? message.toolName : "",
        isError: Boolean(message.isError),
        result: summarizeToolResult(message.content, maxTextChars),
      });
    }
  }
  return steps;
}

function compactRuntimeTrajectoryEvents(params: {
  parsedEvents: ClawBenchJsonValue[];
  maxSteps: number;
  maxTextChars: number;
}): { steps: ClawBenchJsonValue[]; stepsTruncated: boolean; totalSteps: number } {
  const steps: ClawBenchJsonValue[] = [];
  for (const event of params.parsedEvents) {
    if (!isRecord(event)) {
      continue;
    }
    const type = typeof event.type === "string" ? event.type : undefined;
    const data = isRecord(event.data) ? event.data : {};
    const ts = typeof event.ts === "string" ? event.ts : undefined;
    if (type === "session.started") {
      steps.push({
        type,
        ts: ts ?? "",
        provider: compactJsonValue(event.provider, params.maxTextChars),
        modelId: compactJsonValue(event.modelId, params.maxTextChars),
        toolCount: compactJsonValue(data.toolCount, params.maxTextChars),
      });
    } else if (type === "prompt.submitted") {
      steps.push({
        type,
        ts: ts ?? "",
        prompt: compactText(data.prompt, params.maxTextChars) ?? "",
        imagesCount: compactJsonValue(data.imagesCount ?? 0, params.maxTextChars),
      });
    } else if (type === "model.completed") {
      steps.push(...compactMessagesSnapshot(data.messagesSnapshot, params.maxTextChars));
      steps.push({
        type,
        ts: ts ?? "",
        status: data.timedOut ? "timeout" : data.aborted ? "aborted" : "completed",
        usage: compactJsonValue(data.usage, params.maxTextChars),
      });
    } else if (type === "trace.artifacts") {
      steps.push({
        type,
        ts: ts ?? "",
        finalStatus: compactJsonValue(data.finalStatus, params.maxTextChars),
        itemLifecycle: compactJsonValue(data.itemLifecycle, params.maxTextChars),
        toolMetas: compactJsonValue(data.toolMetas, params.maxTextChars),
      });
    } else if (type === "session.ended") {
      steps.push({
        type,
        ts: ts ?? "",
        status: compactJsonValue(data.status, params.maxTextChars),
        timedOut: compactJsonValue(data.timedOut ?? false, params.maxTextChars),
        aborted: compactJsonValue(data.aborted ?? false, params.maxTextChars),
      });
    }
  }
  const returnedSteps = steps.length > params.maxSteps ? steps.slice(-params.maxSteps) : steps;
  return {
    steps: returnedSteps,
    stepsTruncated: steps.length > returnedSteps.length,
    totalSteps: steps.length,
  };
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
    const maxSteps = positiveIntegerEnv(
      "CLAWBENCH_RUNTIME_TRAJECTORY_MAX_STEPS",
      DEFAULT_RUNTIME_TRAJECTORY_MAX_STEPS,
    );
    const maxTextChars = positiveIntegerEnv(
      "CLAWBENCH_RUNTIME_TRAJECTORY_TEXT_MAX_CHARS",
      DEFAULT_RUNTIME_TRAJECTORY_TEXT_MAX_CHARS,
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
    const compact = compactRuntimeTrajectoryEvents({
      parsedEvents,
      maxSteps,
      maxTextChars,
    });
    return {
      event: "runtime.trajectory",
      at: params.at,
      sessionKey: params.sessionKey,
      sessionId: entry.sessionId,
      fileBytes,
      fileTruncated,
      observedEventCount: lines.length,
      parsedEventCount: parsedEvents.length,
      compactStepCount: compact.totalSteps,
      returnedStepCount: compact.steps.length,
      stepsTruncated: compact.stepsTruncated,
      parseErrorCount,
      steps: compact.steps,
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
      compactStepCount: runtimeTrajectory.compactStepCount ?? 0,
      returnedStepCount: runtimeTrajectory.returnedStepCount ?? 0,
      fileBytes: runtimeTrajectory.fileBytes ?? 0,
      fileTruncated: runtimeTrajectory.fileTruncated ?? false,
      stepsTruncated: runtimeTrajectory.stepsTruncated ?? false,
      parseErrorCount: runtimeTrajectory.parseErrorCount ?? 0,
      error: runtimeTrajectory.error ?? null,
    };
  }

  return { replyText, latency, metrics, trajectory };
}
