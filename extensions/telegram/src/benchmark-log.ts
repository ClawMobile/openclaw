import { createSubsystemLogger } from "../../../src/logging/subsystem.js";

const benchmarkLogger = createSubsystemLogger("gateway/channels/telegram/benchmark");

function formatBenchmarkValue(value: unknown) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function logTelegramBenchmarkEvent(
  event:
    | "inbound_received"
    | "dispatch_started"
    | "reply_delivered"
    | "tool_started"
    | "tool_finished"
    | "tool_failed"
    | "tool_blocked",
  payload: Record<string, unknown>,
) {
  const ts = new Date().toISOString();
  const detail = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatBenchmarkValue(value)}`)
    .join(" ");
  const message = detail ? `ts=${ts} event=${event} ${detail}` : `ts=${ts} event=${event}`;
  benchmarkLogger.info(message, { ts, event, ...payload });
}
