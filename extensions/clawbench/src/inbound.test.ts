import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleClawBenchInbound } from "./inbound.js";
import { setClawBenchChannelRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  dispatchInboundReplyWithBase: vi.fn(async (params: { deliver: (payload: unknown) => void }) => {
    await params.deliver({ text: "Done" });
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: {},
      routeSessionKey: "session-key",
      dispatchResult: {
        queuedFinal: true,
        counts: {
          final: 1,
          block: 0,
          tool: 0,
        },
      },
    };
  }),
}));

vi.mock("openclaw/plugin-sdk/inbound-reply-dispatch", () => ({
  dispatchInboundReplyWithBase: mocks.dispatchInboundReplyWithBase,
}));

describe("clawbench inbound", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns reply, latency, metrics, and runtime trajectory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbench-inbound-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionFile = path.join(tmpDir, "session-1.jsonl");
    const trajectoryFile = path.join(tmpDir, "session-1.trajectory.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf8");
    fs.writeFileSync(
      trajectoryFile,
      [
        JSON.stringify({ type: "session.started", data: { runId: "run-1" } }),
        JSON.stringify({ type: "model.completed", data: { latencyMs: 42 } }),
      ].join("\n") + "\n",
      "utf8",
    );

    setClawBenchChannelRuntime({
      agent: {
        session: {
          loadSessionStore: () => ({
            "session-key": {
              sessionId: "session-1",
              updatedAt: 1,
              sessionFile,
            },
          }),
          resolveSessionFilePath: () => sessionFile,
        },
      },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "session-key",
          }),
        },
        session: {
          resolveStorePath: () => storePath,
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: vi.fn(),
        },
        reply: {
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          resolveEnvelopeFormatOptions: () => ({}),
          finalizeInboundContext: (payload: unknown) => payload,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
      },
    } as never);

    const result = await handleClawBenchInbound({
      channelId: "clawbench",
      channelLabel: "ClawBench",
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        host: "127.0.0.1",
        port: 8765,
        baseUrl: "http://127.0.0.1:8765",
        config: {},
      },
      config: {},
      run: {
        accountId: "default",
        runId: "run-1",
        instruction: "Do it",
        status: "QUEUED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    expect(result.replyText).toBe("Done");
    expect(result.latency.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.replyCount).toBe(1);
    expect(result.metrics.runtimeTrajectory).toMatchObject({
      available: true,
      sessionId: "session-1",
      observedEventCount: 2,
      parsedEventCount: 2,
      returnedEventCount: 2,
      fileTruncated: false,
    });
    expect(result.trajectory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "runtime.trajectory",
          events: expect.arrayContaining([expect.objectContaining({ type: "model.completed" })]),
        }),
      ]),
    );
  });
});
