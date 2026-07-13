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
        JSON.stringify({
          type: "prompt.submitted",
          data: { prompt: "Do it", systemPrompt: "hidden internal prompt" },
        }),
        JSON.stringify({
          type: "model.call.started",
          ts: "2026-07-13T10:00:00.000Z",
          data: { callId: "run-1:model:1" },
        }),
        JSON.stringify({
          type: "model.call.completed",
          ts: "2026-07-13T10:00:01.250Z",
          data: { callId: "run-1:model:1" },
        }),
        JSON.stringify({
          type: "model.completed",
          data: {
            usage: { input: 10, output: 2 },
            messagesSnapshot: [
              {
                role: "assistant",
                timestamp: 100,
                content: [
                  {
                    type: "thinking",
                    thinkingSignature: "do-not-return",
                  },
                  {
                    type: "toolCall",
                    name: "android_shell",
                    arguments: { cmd: "settings put system screen_brightness 128" },
                  },
                ],
              },
              {
                role: "toolResult",
                timestamp: 101,
                toolName: "android_shell",
                isError: false,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ ok: true, code: 0, stdout: "128\n", stderr: "" }),
                  },
                ],
              },
              {
                role: "assistant",
                timestamp: 102,
                content: [{ type: "text", text: "Done" }],
              },
            ],
          },
        }),
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
      observedEventCount: 5,
      parsedEventCount: 5,
      compactStepCount: 6,
      returnedStepCount: 6,
      modelCallEventCount: 2,
      fileTruncated: false,
    });
    const runtimeTrajectory = result.trajectory.find(
      (event) => event.event === "runtime.trajectory",
    );
    expect(runtimeTrajectory).toBeTruthy();
    expect(runtimeTrajectory).not.toHaveProperty("events");
    expect(runtimeTrajectory).toMatchObject({
      modelCallEvents: [
        {
          type: "model.call.started",
          ts: "2026-07-13T10:00:00.000Z",
          callId: "run-1:model:1",
        },
        {
          type: "model.call.completed",
          ts: "2026-07-13T10:00:01.250Z",
          callId: "run-1:model:1",
        },
      ],
      steps: expect.arrayContaining([
        expect.objectContaining({
          type: "tool.call",
          toolName: "android_shell",
          arguments: expect.objectContaining({
            cmd: "settings put system screen_brightness 128",
          }),
        }),
        expect.objectContaining({
          type: "tool.result",
          toolName: "android_shell",
          result: expect.objectContaining({
            ok: true,
            stdout: "128\n",
          }),
        }),
        expect.objectContaining({
          type: "assistant.text",
          text: "Done",
        }),
      ]),
    });
    expect(JSON.stringify(result.trajectory)).not.toContain("hidden internal prompt");
    expect(JSON.stringify(result.trajectory)).not.toContain("do-not-return");
  });
});
