import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AjvPkg from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPendingTrajectoryDeliveriesForTesting,
  createCompactTrajectoryRecorder,
  flushPendingTrajectoryForRunId,
  resolveCompactTrajectoryWriteFlags,
} from "./compact.js";

const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pi-trajectory-"));
  tempDirs.push(dir);
  return dir;
}

function makeAttempt(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    modelId: "gpt-5.5",
    prompt: "hidden runtime prompt",
    ...overrides,
  } as never;
}

function readTrajectory(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function expectSchemaValid(document: unknown): void {
  const schema = JSON.parse(
    fs.readFileSync(new URL("./trajectory.schema.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  delete schema.$schema;
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);
  expect(validate(document), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

afterEach(() => {
  clearPendingTrajectoryDeliveriesForTesting();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PI benchmark trajectory collector", () => {
  it("keeps write flags usable when O_NOFOLLOW is unavailable", () => {
    expect(
      resolveCompactTrajectoryWriteFlags({
        O_CREAT: 0x01,
        O_TRUNC: 0x02,
        O_WRONLY: 0x04,
      }),
    ).toBe(0x07);
  });

  it("is enabled by default", () => {
    const tmpDir = makeTempDir();
    const recorder = createCompactTrajectoryRecorder({
      cwd: tmpDir,
      attempt: makeAttempt(),
      env: {},
    });

    expect(recorder).not.toBeNull();
    expect(recorder?.filePath).toContain(path.join(tmpDir, "recordings", "trajectories"));
  });

  it("honors explicit disablement", () => {
    const recorder = createCompactTrajectoryRecorder({
      cwd: makeTempDir(),
      attempt: makeAttempt(),
      env: { CLAWMOBILE_COLLECT_TRAJECTORY: "0" },
    });

    expect(recorder).toBeNull();
  });

  it("writes a schema-valid v1 trajectory with turn rollups", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCompactTrajectoryRecorder({
      cwd: tmpDir,
      attempt: makeAttempt(),
      env: {
        CLAWMOBILE_COLLECT_TRAJECTORY: "1",
        CLAWMOBILE_TRAJECTORY_DIR: tmpDir,
        CLAWMOBILE_TRAJECTORY_ID: "traj_test_run",
        CLAWMOBILE_TRAJECTORY_TASK_ID: "keep_create_note_titled",
        CLAWMOBILE_TRAJECTORY_INSTRUCTION: "benchmark instruction",
        CLAWMOBILE_TRAJECTORY_SUCCESS: "true",
        CLAWMOBILE_TRAJECTORY_CHECKER_OUTPUT: JSON.stringify({
          passed_subconditions: ["note exists"],
          failed_subconditions: [],
          evidence: "checker evidence",
        }),
      },
    });

    expect(recorder).not.toBeNull();
    recorder?.recordModelStepStarted({ startedAtMs: 100 });
    recorder?.recordEvent("tool.call", {
      toolCallId: "call-1",
      name: "tap",
      arguments: { text: "must not be written" },
    });
    recorder?.recordEvent("tool.timeout", {
      toolCallId: "call-1",
      name: "tap",
    });
    recorder?.recordEvent("tool.result", {
      toolCallId: "call-1",
      success: false,
      contentPreview: "must not be written",
    });
    recorder?.recordModelResponse({
      durationMs: 25,
      usage: { input: 10, output: 5, cacheRead: 3 },
    });
    recorder?.recordEvent("session.ended", {
      status: "success",
      finalAssistantText: "must not be written",
    });
    await recorder?.flush();

    const filePath = path.join(tmpDir, "traj_test_run.json");
    expect(fs.existsSync(filePath)).toBe(false);
    await expect(flushPendingTrajectoryForRunId("run-1")).resolves.toMatchObject({
      flushed: true,
      filePath,
    });
    const content = fs.readFileSync(filePath, "utf8");
    const trajectory = JSON.parse(content) as {
      schema_version: string;
      trajectory_id: string;
      task_id: string;
      instruction: string;
      agent: { framework: string; model: string };
      turns: Array<{
        turn_index: number;
        actions: string[];
        error_count: number;
        token_usage: { input: number; output: number; cached?: number };
        duration_ms?: number;
      }>;
      outcome: { success: boolean; termination_reason: string; checker_output?: unknown };
      rollups: {
        total_turns: number;
        total_actions: number;
        total_errors: number;
        total_tokens: { input: number; output: number };
        total_duration_ms?: number;
      };
    };
    expectSchemaValid(trajectory);
    expect(trajectory).toMatchObject({
      schema_version: "1.0.0-v1",
      trajectory_id: "traj_test_run",
      task_id: "keep_create_note_titled",
      instruction: "benchmark instruction",
      agent: { framework: "openclaw", model: "gpt-5.5" },
      turns: [
        {
          turn_index: 0,
          actions: ["tap"],
          error_count: 1,
          token_usage: { input: 10, output: 5, cached: 3 },
          duration_ms: 25,
        },
      ],
      outcome: {
        success: true,
        termination_reason: "success",
      },
      rollups: {
        total_turns: 1,
        total_actions: 1,
        total_errors: 1,
        total_tokens: { input: 10, output: 5 },
        total_duration_ms: 25,
      },
    });
    expect(content).not.toContain("must not be written");
  });

  it("records thinking-only turns with an empty action list", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCompactTrajectoryRecorder({
      cwd: tmpDir,
      attempt: makeAttempt(),
      env: {
        CLAWMOBILE_COLLECT_TRAJECTORY: "1",
        CLAWMOBILE_TRAJECTORY_DIR: tmpDir,
        CLAWMOBILE_TRAJECTORY_ID: "traj_no_action",
      },
    });

    recorder?.recordModelStepStarted({ startedAtMs: 100 });
    recorder?.recordModelResponse({
      durationMs: 50,
      usage: { input: 7, output: 2 },
    });
    recorder?.recordEvent("session.ended", { status: "success" });
    await recorder?.flush();
    await expect(flushPendingTrajectoryForRunId("run-1")).resolves.toMatchObject({
      flushed: true,
    });

    const trajectory = readTrajectory(path.join(tmpDir, "traj_no_action.json")) as {
      turns: Array<{ actions: string[] }>;
      rollups: { total_actions: number };
    };
    expectSchemaValid(trajectory);
    expect(trajectory.turns[0]?.actions).toEqual([]);
    expect(trajectory.rollups.total_actions).toBe(0);
  });

  it("maps interrupted runs to user_abort and allows checker overrides", async () => {
    const tmpDir = makeTempDir();
    const recorder = createCompactTrajectoryRecorder({
      cwd: tmpDir,
      attempt: makeAttempt(),
      env: {
        CLAWMOBILE_COLLECT_TRAJECTORY: "1",
        CLAWMOBILE_TRAJECTORY_DIR: tmpDir,
        CLAWMOBILE_TRAJECTORY_ID: "traj_abort",
        CLAWMOBILE_TRAJECTORY_SUCCESS: "false",
      },
    });

    recorder?.recordEvent("session.ended", { aborted: true });
    await recorder?.flush();
    await expect(flushPendingTrajectoryForRunId("run-1")).resolves.toMatchObject({
      flushed: true,
    });

    const trajectory = readTrajectory(path.join(tmpDir, "traj_abort.json")) as {
      outcome: { success: boolean; termination_reason: string };
    };
    expectSchemaValid(trajectory);
    expect(trajectory.outcome).toEqual({ success: false, termination_reason: "user_abort" });
  });

  it("refuses to write under a symlinked trajectory directory", async () => {
    const tmpDir = makeTempDir();
    const targetDir = path.join(tmpDir, "target");
    const linkDir = path.join(tmpDir, "link");
    fs.mkdirSync(targetDir);
    fs.symlinkSync(targetDir, linkDir);
    const recorder = createCompactTrajectoryRecorder({
      cwd: tmpDir,
      attempt: makeAttempt(),
      env: {
        CLAWMOBILE_COLLECT_TRAJECTORY: "1",
        CLAWMOBILE_TRAJECTORY_DIR: linkDir,
        CLAWMOBILE_TRAJECTORY_ID: "traj_symlink",
      },
    });

    recorder?.recordEvent("session.ended", { status: "success" });
    await recorder?.flush();

    expect(fs.existsSync(path.join(targetDir, "traj_symlink.json"))).toBe(false);
  });
});
