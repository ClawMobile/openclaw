import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexTrajectoryRecorder,
  recordCodexTrajectoryContext,
  recordCodexTrajectoryModelRequest,
  recordCodexTrajectoryModelResponse,
  recordCodexTrajectoryModelStepStarted,
  resolveCodexTrajectoryAppendFlags,
  resolveCodexTrajectoryPointerFlags,
} from "./trajectory.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-trajectory-"));
  tempDirs.push(dir);
  return dir;
}

function readTrajectoryEvents(
  filePath: string,
): Array<{ type: string; data?: Record<string, unknown> }> {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Codex trajectory recorder", () => {
  it("keeps write flags usable when O_NOFOLLOW is unavailable", () => {
    const constants = {
      O_APPEND: 0x01,
      O_CREAT: 0x02,
      O_TRUNC: 0x04,
      O_WRONLY: 0x08,
    };

    expect(resolveCodexTrajectoryAppendFlags(constants)).toBe(0x0b);
    expect(resolveCodexTrajectoryPointerFlags(constants)).toBe(0x0e);
  });

  it("records by default unless explicitly disabled", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile,
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        provider: "codex",
        modelId: "gpt-5.4",
        model: { api: "responses" },
      } as never,
      env: {},
    });

    expect(recorder).not.toBeNull();
    recorder?.recordEvent("session.started", {
      apiKey: "secret",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
    });
    await recorder?.flush();

    const filePath = path.join(tmpDir, "session.trajectory.jsonl");
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain('"type":"session.started"');
    expect(content).not.toContain("secret");
    expect(content).not.toContain("sk-test-secret-token");
    expect(content).not.toContain("sk-other-secret-token");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(tmpDir, "session.trajectory-path.json"))).toBe(true);
  });

  it("sanitizes session ids when resolving an override directory", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "../evil/session",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY_DIR: tmpDir },
    });

    recorder?.recordEvent("session.started");
    await recorder?.flush();

    expect(fs.existsSync(path.join(tmpDir, "___evil_session.jsonl"))).toBe(true);
  });

  it("honors explicit disablement", () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY: "0" },
    });

    expect(recorder).toBeNull();
  });

  it("refuses to append through a symlinked parent directory", async () => {
    const tmpDir = makeTempDir();
    const targetDir = path.join(tmpDir, "target");
    const linkDir = path.join(tmpDir, "link");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir);
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(linkDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: {},
    });

    recorder?.recordEvent("session.started");
    await recorder?.flush();

    expect(fs.existsSync(path.join(targetDir, "session.trajectory.jsonl"))).toBe(false);
  });

  it("truncates events that exceed the runtime event byte limit", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: {},
    });

    recorder?.recordEvent("context.compiled", {
      fields: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`field-${index}`, "x".repeat(3_000)]),
      ),
    });
    await recorder?.flush();

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "session.trajectory.jsonl"), "utf8"),
    ) as { data?: { truncated?: boolean; reason?: string } };
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
    });
  });

  it("records model step request and response even without tool calls", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const attempt = {
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      provider: "codex",
      modelId: "gpt-5.4",
      model: { api: "responses" },
      prompt: "current task",
      images: [],
    } as never;
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt,
      env: {},
    });

    recordCodexTrajectoryContext(recorder, {
      cwd: tmpDir,
      attempt,
      developerInstructions: "system instructions",
      prompt: "current task",
      historyMessages: [{ role: "user", content: "previous task" }],
      tools: [{ name: "shell.exec", inputSchema: { type: "object" } }],
    });
    recordCodexTrajectoryModelStepStarted(recorder, {
      stepId: "step-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.4",
      startedAtMs: 100,
    });
    recordCodexTrajectoryModelRequest(recorder, {
      stepId: "step-1",
      threadId: "thread-1",
      systemPrompt: "system instructions",
      prompt: "current task",
      historyMessages: [{ role: "user", content: "previous task" }],
      imagesCount: 0,
      tools: [{ name: "shell.exec", inputSchema: { type: "object" } }],
      runtimeRequest: { input: [{ type: "text", text: "current task" }] },
    });
    recordCodexTrajectoryModelResponse(recorder, {
      stepId: "step-1",
      threadId: "thread-1",
      turnId: "turn-1",
      timedOut: false,
      aborted: false,
      promptError: null,
      runtimeLatencyMs: 25,
      modelAndRuntimeLatencyMs: 25,
      toolCalls: [],
      result: {
        aborted: false,
        promptError: null,
        messagesSnapshot: [],
        assistantTexts: ["final answer"],
        attemptUsage: { input: 10, output: 5, total: 15, cacheRead: 3 },
      } as never,
    });
    await recorder?.flush();

    const events = readTrajectoryEvents(path.join(tmpDir, "session.trajectory.jsonl"));
    expect(events.map((event) => event.type)).toEqual([
      "context.compiled",
      "model.step.started",
      "model.request",
      "model.response",
    ]);
    expect(events[0]?.data).toMatchObject({
      captureLevel: "openclaw-runtime-request",
      prompt: "current task",
      historyMessages: [{ role: "user", content: "previous task" }],
    });
    expect(events[3]?.data).toMatchObject({
      stepId: "step-1",
      status: "success",
      latencyMs: 25,
      latencyKind: "model-and-runtime-minus-tools",
      assistantText: "final answer",
      toolCalls: [],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 3,
      },
    });
  });
});
