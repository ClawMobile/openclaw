import { randomUUID } from "node:crypto";
import type { VerboseLevel } from "../auto-reply/thinking.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type AgentEventStream =
  | "lifecycle"
  | "tool"
  | "assistant"
  | "error"
  | "item"
  | "plan"
  | "approval"
  | "command_output"
  | "patch"
  | "compaction"
  | "thinking"
  | (string & {});

export type AgentItemEventPhase = "start" | "update" | "end";
export type AgentItemEventStatus = "running" | "completed" | "failed" | "blocked";
export type AgentItemEventKind =
  | "tool"
  | "command"
  | "patch"
  | "search"
  | "analysis"
  | (string & {});

export type AgentItemEventData = {
  itemId: string;
  phase: AgentItemEventPhase;
  kind: AgentItemEventKind;
  title: string;
  status: AgentItemEventStatus;
  name?: string;
  meta?: string;
  toolCallId?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  summary?: string;
  progressText?: string;
  /** Preserve item telemetry while letting channel progress render a sibling tool event instead. */
  suppressChannelProgress?: boolean;
  approvalId?: string;
  approvalSlug?: string;
};

export type AgentPlanEventData = {
  phase: "update";
  title: string;
  explanation?: string;
  steps?: string[];
  source?: string;
};

export type AgentApprovalEventPhase = "requested" | "resolved";
export type AgentApprovalEventStatus = "pending" | "unavailable" | "approved" | "denied" | "failed";
export type AgentApprovalEventKind = "exec" | "plugin" | "unknown";

export type AgentApprovalEventData = {
  phase: AgentApprovalEventPhase;
  kind: AgentApprovalEventKind;
  status: AgentApprovalEventStatus;
  title: string;
  itemId?: string;
  toolCallId?: string;
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  host?: string;
  reason?: string;
  scope?: "turn" | "session";
  message?: string;
};

export type AgentCommandOutputEventData = {
  itemId: string;
  phase: "delta" | "end";
  title: string;
  toolCallId: string;
  name?: string;
  output?: string;
  status?: AgentItemEventStatus | "running";
  exitCode?: number | null;
  durationMs?: number;
  cwd?: string;
};

export type AgentPatchSummaryEventData = {
  itemId: string;
  phase: "end";
  title: string;
  toolCallId: string;
  name?: string;
  added: string[];
  modified: string[];
  deleted: string[];
  summary: string;
};

export type TraceContext = {
  openclaw_runId: string;
  openclaw_sessionId: string;
  openclaw_toolCallId: string;
  openclaw_toolCallSeq: number;
  openclaw_toolName: string;
  openclaw_phase: "start" | "update" | "result";
  openclaw_timestamp_ms: number;
};

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
  trace?: TraceContext;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /** Whether control UI clients should receive chat/agent updates for this run. */
  isControlUiVisible?: boolean;
  /** Timestamp when this context was first registered (for TTL-based cleanup). */
  registeredAt?: number;
  /** Timestamp of last activity (updated on every emitAgentEvent). */
  lastActiveAt?: number;
};

type AgentEventState = {
  seqByRun: Map<string, number>;
  listeners: Set<(evt: AgentEventPayload) => void>;
  runContextById: Map<string, AgentRunContext>;
  toolCallSeqByRun: Map<string, number>;
  currentTraceContextByRun: Map<string, TraceContext>;
};

const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");

function getAgentEventState(): AgentEventState {
  return resolveGlobalSingleton<AgentEventState>(AGENT_EVENT_STATE_KEY, () => ({
    seqByRun: new Map<string, number>(),
    listeners: new Set<(evt: AgentEventPayload) => void>(),
    runContextById: new Map<string, AgentRunContext>(),
    toolCallSeqByRun: new Map<string, number>(),
    currentTraceContextByRun: new Map<string, TraceContext>(),
  }));
}

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const state = getAgentEventState();
  const existing = state.runContextById.get(runId);
  if (!existing) {
    state.runContextById.set(runId, {
      ...context,
      registeredAt: context.registeredAt ?? Date.now(),
    });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isControlUiVisible !== undefined) {
    existing.isControlUiVisible = context.isControlUiVisible;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
  if (context.registeredAt !== undefined) {
    existing.registeredAt = context.registeredAt;
  }
  if (context.lastActiveAt !== undefined) {
    existing.lastActiveAt = context.lastActiveAt;
  }
}

export function getAgentRunContext(runId: string) {
  return getAgentEventState().runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  const state = getAgentEventState();
  state.runContextById.delete(runId);
  state.seqByRun.delete(runId);
  state.toolCallSeqByRun.delete(runId);
  state.currentTraceContextByRun.delete(runId);
}

/**
 * Sweep stale run contexts that exceeded the given TTL.
 * Guards against orphaned entries when lifecycle "end"/"error" events are missed.
 */
export function sweepStaleRunContexts(maxAgeMs = 30 * 60 * 1000): number {
  const state = getAgentEventState();
  const now = Date.now();
  let swept = 0;
  for (const [runId, ctx] of state.runContextById.entries()) {
    // Use lastActiveAt (refreshed on every event) to avoid sweeping active runs.
    // Fall back to registeredAt, then treat missing timestamps as infinitely old.
    const lastSeen = ctx.lastActiveAt ?? ctx.registeredAt;
    const age = lastSeen ? now - lastSeen : Infinity;
    if (age > maxAgeMs) {
      state.runContextById.delete(runId);
      state.seqByRun.delete(runId);
      state.toolCallSeqByRun.delete(runId);
      state.currentTraceContextByRun.delete(runId);
      swept++;
    }
  }
  return swept;
}

export function generateToolCallId(): string {
  return `tc_${randomUUID()}`;
}

export function createTraceContext(
  runId: string,
  sessionId: string,
  toolName: string,
  phase: "start" | "update" | "result" = "start",
  toolCallId = generateToolCallId(),
): TraceContext {
  const state = getAgentEventState();
  const toolCallSeq = (state.toolCallSeqByRun.get(runId) ?? 0) + 1;
  state.toolCallSeqByRun.set(runId, toolCallSeq);

  const context: TraceContext = {
    openclaw_runId: runId,
    openclaw_sessionId: sessionId,
    openclaw_toolCallId: toolCallId,
    openclaw_toolCallSeq: toolCallSeq,
    openclaw_toolName: toolName,
    openclaw_phase: phase,
    openclaw_timestamp_ms: Date.now(),
  };
  state.currentTraceContextByRun.set(runId, context);
  return context;
}

export function getTraceContext(runId: string): TraceContext | undefined {
  return getAgentEventState().currentTraceContextByRun.get(runId);
}

export function updateTraceContextPhase(
  runId: string,
  phase: "start" | "update" | "result",
): TraceContext | undefined {
  const context = getTraceContext(runId);
  if (context) {
    context.openclaw_phase = phase;
    context.openclaw_timestamp_ms = Date.now();
  }
  return context;
}

export function clearTraceContext(runId: string) {
  getAgentEventState().currentTraceContextByRun.delete(runId);
}

export function resetAgentRunContextForTest() {
  const state = getAgentEventState();
  state.runContextById.clear();
  state.seqByRun.clear();
  state.toolCallSeqByRun.clear();
  state.currentTraceContextByRun.clear();
}

export function emitAgentEvent(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  traceContext?: TraceContext,
) {
  const state = getAgentEventState();
  const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
  state.seqByRun.set(event.runId, nextSeq);
  const context = state.runContextById.get(event.runId);
  if (context) {
    context.lastActiveAt = Date.now();
  }
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  // Hidden channel-routed runs should not leak live assistant/tool traffic into
  // Control UI, but lifecycle events still need the session key so gateway
  // listeners can persist terminal session state even if run-context lookup is
  // unavailable by the time the terminal event arrives. Terminal failures are
  // emitted on the lifecycle stream with `phase: "error"`; the separate error
  // stream remains redacted for hidden runs because it is observational only.
  const preserveSessionKey = isControlUiVisible || event.stream === "lifecycle";
  const sessionKey = preserveSessionKey ? (eventSessionKey ?? context?.sessionKey) : undefined;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
    ...(traceContext ? { trace: traceContext } : {}),
  };
  notifyListeners(state.listeners, enriched);
}

export function emitAgentItemEvent(params: {
  runId: string;
  data: AgentItemEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "item",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentPlanEvent(params: {
  runId: string;
  data: AgentPlanEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "plan",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentApprovalEvent(params: {
  runId: string;
  data: AgentApprovalEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "approval",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentCommandOutputEvent(params: {
  runId: string;
  data: AgentCommandOutputEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "command_output",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentPatchSummaryEvent(params: {
  runId: string;
  data: AgentPatchSummaryEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "patch",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  const state = getAgentEventState();
  return registerListener(state.listeners, listener);
}

export function resetAgentEventsForTest() {
  const state = getAgentEventState();
  state.seqByRun.clear();
  state.listeners.clear();
  state.runContextById.clear();
  state.toolCallSeqByRun.clear();
  state.currentTraceContextByRun.clear();
}
