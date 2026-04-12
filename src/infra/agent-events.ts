import type { VerboseLevel } from "../auto-reply/thinking.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { randomUUID } from "crypto";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

// === Unified Trace Context (NEW) ===
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
  trace?: TraceContext; // NEW: Optional trace context for unified tracing
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /** Whether control UI clients should receive chat/agent updates for this run. */
  isControlUiVisible?: boolean;
};

type AgentEventState = {
  seqByRun: Map<string, number>;
  listeners: Set<(evt: AgentEventPayload) => void>;
  runContextById: Map<string, AgentRunContext>;
  // === NEW: Trace state tracking ===
  toolCallSeqByRun: Map<string, number>;
  currentTraceContextByRun: Map<string, TraceContext>;
};

const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");

const state = resolveGlobalSingleton<AgentEventState>(AGENT_EVENT_STATE_KEY, () => ({
  seqByRun: new Map<string, number>(),
  listeners: new Set<(evt: AgentEventPayload) => void>(),
  runContextById: new Map<string, AgentRunContext>(),
  // === NEW: Initialize trace tracking ===
  toolCallSeqByRun: new Map<string, number>(),
  currentTraceContextByRun: new Map<string, TraceContext>(),
}));

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const existing = state.runContextById.get(runId);
  if (!existing) {
    state.runContextById.set(runId, { ...context });
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
}

export function getAgentRunContext(runId: string) {
  return state.runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  state.runContextById.delete(runId);
}

// === NEW: Trace context management functions ===
export function generateToolCallId(): string {
  return `tc_${randomUUID()}`;
}

export function createTraceContext(
  runId: string,
  sessionId: string,
  toolName: string,
  phase: "start" | "update" | "result" = "start"
): TraceContext {
  const toolCallSeq = (state.toolCallSeqByRun.get(runId) ?? 0) + 1;
  state.toolCallSeqByRun.set(runId, toolCallSeq);

  const toolCallId = generateToolCallId();
  
  const context: TraceContext = {
    openclaw_runId: runId,
    openclaw_sessionId: sessionId,
    openclaw_toolCallId: toolCallId,
    openclaw_toolCallSeq: toolCallSeq,
    openclaw_toolName: toolName,
    openclaw_phase: phase,
    openclaw_timestamp_ms: Date.now(),
  };
  
  // Store current context for retrieval
  state.currentTraceContextByRun.set(runId, context);
  return context;
}

export function getTraceContext(runId: string): TraceContext | undefined {
  return state.currentTraceContextByRun.get(runId);
}

export function updateTraceContextPhase(
  runId: string,
  phase: "start" | "update" | "result"
): TraceContext | undefined {
  const context = state.currentTraceContextByRun.get(runId);
  if (context) {
    context.openclaw_phase = phase;
    context.openclaw_timestamp_ms = Date.now();
  }
  return context;
}

export function clearTraceContext(runId: string) {
  state.currentTraceContextByRun.delete(runId);
}

export function resetAgentRunContextForTest() {
  state.runContextById.clear();
}

export function emitAgentEvent(
  event: Omit<AgentEventPayload, "seq" | "ts">,
  traceContext?: TraceContext // NEW: Optional trace context
) {
  const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
  state.seqByRun.set(event.runId, nextSeq);
  const context = state.runContextById.get(event.runId);
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  const sessionKey = isControlUiVisible ? (eventSessionKey ?? context?.sessionKey) : undefined;
  
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
    ...(traceContext && { trace: traceContext }), // NEW: Include trace if provided
  };
  notifyListeners(state.listeners, enriched);
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  return registerListener(state.listeners, listener);
}

export function resetAgentEventsForTest() {
  state.seqByRun.clear();
  state.listeners.clear();
  state.runContextById.clear();
  // NEW: Also clear trace state
  state.toolCallSeqByRun.clear();
  state.currentTraceContextByRun.clear();
}
