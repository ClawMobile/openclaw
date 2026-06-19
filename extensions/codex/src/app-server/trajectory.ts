import { randomUUID } from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness";
import { resolveUserPath } from "openclaw/plugin-sdk/agent-harness";

export type CodexTrajectoryToolCallSummary = {
  toolCallId: string;
  name: string;
  arguments?: unknown;
};

type CodexTrajectoryRecorder = {
  filePath: string;
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  recordModelStepStarted: (params: { startedAtMs: number }) => void;
  recordModelResponse: (params: {
    result: EmbeddedRunAttemptResult;
    runtimeLatencyMs?: number;
    modelAndRuntimeLatencyMs?: number;
    toolCalls: CodexTrajectoryToolCallSummary[];
  }) => void;
  flush: () => Promise<void>;
};

type CodexTrajectoryInit = {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  developerInstructions?: string;
  prompt?: string;
  historyMessages?: unknown[];
  tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
  env?: NodeJS.ProcessEnv;
};

type TrajectoryTerminationReason =
  | "success"
  | "max_steps"
  | "crash"
  | "refused"
  | "error"
  | "user_abort";

type TrajectoryTokenUsage = {
  input: number;
  output: number;
  cached?: number;
};

type TrajectoryTurn = {
  turn_index: number;
  actions: string[];
  error_count: number;
  token_usage: TrajectoryTokenUsage;
  duration_ms?: number;
};

type TrajectoryOutcome = {
  success: boolean;
  termination_reason: TrajectoryTerminationReason;
  checker_output?: Record<string, unknown>;
};

type TrajectoryDocument = {
  schema_version: "1.0.0-v1";
  trajectory_id: string;
  started_at?: string;
  task_id: string;
  instruction?: string;
  agent: {
    framework?: string;
    model: string;
    model_version?: string;
  };
  turns: TrajectoryTurn[];
  outcome: TrajectoryOutcome;
  rollups: {
    total_turns: number;
    total_actions: number;
    total_errors: number;
    total_tokens: {
      input: number;
      output: number;
    };
    total_duration_ms?: number;
  };
};

type ActiveTurn = {
  turnIndex: number;
  startedAtMs?: number;
  actions: string[];
  failedToolCallIds: Set<string>;
  anonymousErrorCount: number;
};

const TRAJECTORY_SCHEMA_VERSION = "1.0.0-v1";
const TRAJECTORY_FILE_MAX_BYTES = 5 * 1024 * 1024;
const VALID_TERMINATION_REASONS = new Set<TrajectoryTerminationReason>([
  "success",
  "max_steps",
  "crash",
  "refused",
  "error",
  "user_abort",
]);

type CodexTrajectoryOpenFlagConstants = Pick<
  typeof nodeFs.constants,
  "O_CREAT" | "O_TRUNC" | "O_WRONLY"
> &
  Partial<Pick<typeof nodeFs.constants, "O_NOFOLLOW">>;

export function resolveCodexTrajectoryWriteFlags(
  constants: CodexTrajectoryOpenFlagConstants = nodeFs.constants,
): number {
  const noFollow = constants.O_NOFOLLOW;
  return (
    constants.O_CREAT |
    constants.O_TRUNC |
    constants.O_WRONLY |
    (typeof noFollow === "number" ? noFollow : 0)
  );
}

async function assertNoSymlinkParents(filePath: string): Promise<void> {
  const resolvedDir = path.resolve(path.dirname(filePath));
  const parsed = path.parse(resolvedDir);
  const relativeParts = path.relative(parsed.root, resolvedDir).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      if (path.dirname(current) === parsed.root) {
        continue;
      }
      throw new Error(`Refusing to write trajectory under symlinked directory: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Refusing to write trajectory under non-directory: ${current}`);
    }
  }
}

function verifyStableOpenedTrajectoryFile(params: {
  preOpenStat?: nodeFs.Stats;
  postOpenStat: nodeFs.Stats;
  filePath: string;
}): void {
  if (!params.postOpenStat.isFile()) {
    throw new Error(`Refusing to write trajectory to non-file: ${params.filePath}`);
  }
  if (params.postOpenStat.nlink > 1) {
    throw new Error(`Refusing to write trajectory to hardlinked file: ${params.filePath}`);
  }
  const pre = params.preOpenStat;
  if (pre && (pre.dev !== params.postOpenStat.dev || pre.ino !== params.postOpenStat.ino)) {
    throw new Error(`Refusing to write trajectory after file changed: ${params.filePath}`);
  }
}

async function safeWriteTrajectoryFile(filePath: string, content: string): Promise<void> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > TRAJECTORY_FILE_MAX_BYTES) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await assertNoSymlinkParents(filePath);

  let preOpenStat: nodeFs.Stats | undefined;
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write trajectory through symlink: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Refusing to write trajectory to non-file: ${filePath}`);
    }
    preOpenStat = stat;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const handle = await fs.open(filePath, resolveCodexTrajectoryWriteFlags(), 0o600);
  try {
    const stat = await handle.stat();
    verifyStableOpenedTrajectoryFile({ preOpenStat, postOpenStat: stat, filePath });
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

export function createCodexTrajectoryRecorder(
  params: CodexTrajectoryInit,
): CodexTrajectoryRecorder | null {
  const env = params.env ?? process.env;
  if (!parseTrajectoryEnabled(env)) {
    return null;
  }

  const startedAt = new Date();
  const taskId = resolveTaskId(params.attempt, env);
  const trajectoryId = resolveTrajectoryId({
    env,
    taskId,
    sessionId: params.attempt.sessionId,
    runId: params.attempt.runId,
    startedAt,
  });
  const filePath = resolveTrajectoryFilePath({
    env,
    cwd: params.cwd,
    trajectoryId,
  });
  const instruction = resolveInstruction(params.attempt, env);
  const turns: TrajectoryTurn[] = [];
  let activeTurn: ActiveTurn | undefined;
  let finished = false;
  let queue = Promise.resolve();

  const finishRun = (outcome: TrajectoryOutcome) => {
    if (finished) {
      return;
    }
    finished = true;
    if (activeTurn) {
      turns.push(buildTurnRecord(activeTurn, undefined, undefined));
      activeTurn = undefined;
    }
    const document: TrajectoryDocument = {
      schema_version: TRAJECTORY_SCHEMA_VERSION,
      trajectory_id: trajectoryId,
      started_at: startedAt.toISOString(),
      task_id: taskId,
      ...(instruction ? { instruction } : {}),
      agent: resolveAgent(params.attempt, env),
      turns,
      outcome,
      rollups: buildRollups(turns),
    };
    const content = `${JSON.stringify(document, null, 2)}\n`;
    queue = queue.then(() => safeWriteTrajectoryFile(filePath, content)).catch(() => undefined);
  };

  const ensureActiveTurn = () => {
    activeTurn ??= {
      turnIndex: turns.length,
      actions: [],
      failedToolCallIds: new Set(),
      anonymousErrorCount: 0,
    };
    return activeTurn;
  };

  return {
    filePath,
    recordEvent: (type, data) => {
      switch (type) {
        case "tool.call": {
          const name = typeof data?.name === "string" ? data.name.trim() : "";
          if (name) {
            ensureActiveTurn().actions.push(name);
          }
          break;
        }
        case "tool.timeout":
          recordToolFailure(ensureActiveTurn(), data);
          break;
        case "tool.result":
          if (data?.success === false) {
            recordToolFailure(ensureActiveTurn(), data);
          }
          break;
        case "session.ended":
          finishRun(resolveOutcome(data, env));
          break;
        default:
          break;
      }
    },
    recordModelStepStarted: ({ startedAtMs }) => {
      if (activeTurn) {
        turns.push(buildTurnRecord(activeTurn, undefined, undefined));
      }
      activeTurn = {
        turnIndex: turns.length,
        startedAtMs,
        actions: [],
        failedToolCallIds: new Set(),
        anonymousErrorCount: 0,
      };
    },
    recordModelResponse: ({ result, runtimeLatencyMs, modelAndRuntimeLatencyMs, toolCalls }) => {
      const turn = ensureActiveTurn();
      if (turn.actions.length === 0) {
        turn.actions.push(...toolCalls.map((call) => call.name).filter(Boolean));
      }
      const durationMs =
        normalizeInteger(runtimeLatencyMs) ??
        normalizeInteger(modelAndRuntimeLatencyMs) ??
        (typeof turn.startedAtMs === "number"
          ? Math.max(0, Date.now() - turn.startedAtMs)
          : undefined);
      turns.push(buildTurnRecord(turn, toTrajectoryTokenUsage(result.attemptUsage), durationMs));
      activeTurn = undefined;
    },
    flush: async () => {
      await queue;
    },
  };
}

export function recordCodexTrajectoryModelStepStarted(
  recorder: CodexTrajectoryRecorder | null,
  params: {
    stepId: string;
    threadId: string;
    turnId?: string;
    provider: string;
    model: string;
    startedAtMs: number;
  },
): void {
  recorder?.recordModelStepStarted({ startedAtMs: params.startedAtMs });
}

export function recordCodexTrajectoryModelRequest(
  recorder: CodexTrajectoryRecorder | null,
  params: {
    stepId: string;
    threadId: string;
    turnId?: string;
    captureLevel?: string;
    systemPrompt?: string;
    prompt: string;
    historyMessages?: unknown[];
    imagesCount: number;
    tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
  },
): void {
  void recorder;
  void params;
}

export function recordCodexTrajectoryModelResponse(
  recorder: CodexTrajectoryRecorder | null,
  params: {
    stepId: string;
    threadId: string;
    turnId: string;
    result: EmbeddedRunAttemptResult;
    timedOut: boolean;
    aborted: boolean;
    promptError: unknown;
    runtimeLatencyMs?: number;
    modelAndRuntimeLatencyMs?: number;
    toolCalls: CodexTrajectoryToolCallSummary[];
    yieldDetected?: boolean;
  },
): void {
  recorder?.recordModelResponse({
    result: params.result,
    runtimeLatencyMs: params.runtimeLatencyMs,
    modelAndRuntimeLatencyMs: params.modelAndRuntimeLatencyMs,
    toolCalls: params.toolCalls,
  });
}

export function recordCodexTrajectoryCompletion(
  recorder: CodexTrajectoryRecorder | null,
  params: {
    attempt: EmbeddedRunAttemptParams;
    result: EmbeddedRunAttemptResult;
    threadId: string;
    turnId: string;
    timedOut: boolean;
    yieldDetected?: boolean;
  },
): void {
  void recorder;
  void params;
}

function parseTrajectoryEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = (env.CLAWMOBILE_COLLECT_TRAJECTORY ?? env.OPENCLAW_TRAJECTORY)
    ?.trim()
    .toLowerCase();
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return true;
}

function resolveTrajectoryFilePath(params: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  trajectoryId: string;
}): string {
  const dirOverride =
    params.env.CLAWMOBILE_TRAJECTORY_DIR?.trim() ?? params.env.OPENCLAW_TRAJECTORY_DIR?.trim();
  const baseDir = dirOverride
    ? resolveUserPath(dirOverride)
    : path.join(params.cwd, "recordings", "trajectories");
  return resolveContainedPath(baseDir, `${safeTrajectoryFileName(params.trajectoryId)}.json`);
}

function resolveTaskId(attempt: EmbeddedRunAttemptParams, env: NodeJS.ProcessEnv): string {
  return (
    readEnvString(env, "CLAWMOBILE_TRAJECTORY_TASK_ID") ??
    readEnvString(env, "OPENCLAW_TRAJECTORY_TASK_ID") ??
    readAttemptString(attempt, "task_id") ??
    readAttemptString(attempt, "taskId") ??
    "unknown_task"
  );
}

function resolveInstruction(
  attempt: EmbeddedRunAttemptParams,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return (
    readEnvString(env, "CLAWMOBILE_TRAJECTORY_INSTRUCTION") ??
    readEnvString(env, "OPENCLAW_TRAJECTORY_INSTRUCTION") ??
    readAttemptString(attempt, "instruction") ??
    readAttemptString(attempt, "prompt")
  );
}

function resolveAgent(
  attempt: EmbeddedRunAttemptParams,
  env: NodeJS.ProcessEnv,
): TrajectoryDocument["agent"] {
  const modelVersion = readEnvString(env, "CLAWMOBILE_TRAJECTORY_MODEL_VERSION");
  return {
    framework: "openclaw",
    model: readEnvString(env, "CLAWMOBILE_TRAJECTORY_MODEL") ?? attempt.modelId,
    ...(modelVersion ? { model_version: modelVersion } : {}),
  };
}

function resolveTrajectoryId(params: {
  env: NodeJS.ProcessEnv;
  taskId: string;
  sessionId?: string;
  runId?: string;
  startedAt: Date;
}): string {
  const override =
    readEnvString(params.env, "CLAWMOBILE_TRAJECTORY_ID") ??
    readEnvString(params.env, "OPENCLAW_TRAJECTORY_ID");
  if (override) {
    return override;
  }
  const date = params.startedAt.toISOString().slice(0, 10).replaceAll("-", "");
  const shortId = safeTrajectoryFileName(params.runId ?? params.sessionId ?? randomUUID()).slice(
    0,
    8,
  );
  return `traj_${date}_${safeTrajectoryFileName(params.taskId).slice(0, 32)}_${shortId}`;
}

function resolveOutcome(
  data: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
): TrajectoryOutcome {
  const terminationReason =
    parseTerminationReason(readEnvString(env, "CLAWMOBILE_TRAJECTORY_TERMINATION_REASON")) ??
    parseTerminationReason(readEnvString(env, "OPENCLAW_TRAJECTORY_TERMINATION_REASON")) ??
    inferTerminationReason(data);
  const success =
    parseBoolean(readEnvString(env, "CLAWMOBILE_TRAJECTORY_SUCCESS")) ??
    parseBoolean(readEnvString(env, "OPENCLAW_TRAJECTORY_SUCCESS")) ??
    terminationReason === "success";
  const checkerOutput = parseJsonObject(readEnvString(env, "CLAWMOBILE_TRAJECTORY_CHECKER_OUTPUT"));
  return {
    success,
    termination_reason: terminationReason,
    ...(checkerOutput ? { checker_output: checkerOutput } : {}),
  };
}

function inferTerminationReason(
  data: Record<string, unknown> | undefined,
): TrajectoryTerminationReason {
  const promptError = normalizeCodexTrajectoryError(data?.promptError);
  if (data?.aborted === true) {
    return "user_abort";
  }
  if (data?.timedOut === true) {
    return "max_steps";
  }
  if (promptError) {
    return "error";
  }
  return data?.status === "success" ? "success" : "error";
}

function recordToolFailure(turn: ActiveTurn, data: Record<string, unknown> | undefined): void {
  const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId.trim() : "";
  if (toolCallId) {
    turn.failedToolCallIds.add(toolCallId);
  } else {
    turn.anonymousErrorCount += 1;
  }
}

function buildTurnRecord(
  turn: ActiveTurn,
  tokenUsage?: TrajectoryTokenUsage,
  durationMs?: number,
): TrajectoryTurn {
  return {
    turn_index: turn.turnIndex,
    actions: turn.actions,
    error_count: turn.failedToolCallIds.size + turn.anonymousErrorCount,
    token_usage: tokenUsage ?? { input: 0, output: 0 },
    ...(typeof durationMs === "number" ? { duration_ms: durationMs } : {}),
  };
}

function buildRollups(turns: TrajectoryTurn[]): TrajectoryDocument["rollups"] {
  const totalDuration = turns.reduce((sum, turn) => sum + (turn.duration_ms ?? 0), 0);
  return {
    total_turns: turns.length,
    total_actions: turns.reduce((sum, turn) => sum + turn.actions.length, 0),
    total_errors: turns.reduce((sum, turn) => sum + turn.error_count, 0),
    total_tokens: {
      input: turns.reduce((sum, turn) => sum + turn.token_usage.input, 0),
      output: turns.reduce((sum, turn) => sum + turn.token_usage.output, 0),
    },
    ...(turns.some((turn) => typeof turn.duration_ms === "number")
      ? { total_duration_ms: totalDuration }
      : {}),
  };
}

function toTrajectoryTokenUsage(
  usage: EmbeddedRunAttemptResult["attemptUsage"],
): TrajectoryTokenUsage {
  const cached = normalizeInteger(usage?.cacheRead);
  return {
    input: normalizeInteger(usage?.input) ?? 0,
    output: normalizeInteger(usage?.output) ?? 0,
    ...(typeof cached === "number" ? { cached } : {}),
  };
}

function readEnvString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readAttemptString(attempt: EmbeddedRunAttemptParams, key: string): string | undefined {
  const value = (attempt as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  switch (value?.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function parseTerminationReason(
  value: string | undefined,
): TrajectoryTerminationReason | undefined {
  return value && VALID_TERMINATION_REASONS.has(value as TrajectoryTerminationReason)
    ? (value as TrajectoryTerminationReason)
    : undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : undefined;
}

function safeTrajectoryFileName(value: string): string {
  const safe = value.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return /[A-Za-z0-9]/u.test(safe) ? safe : "trajectory";
}

function resolveContainedPath(baseDir: string, fileName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(resolvedBase, fileName);
  const relative = path.relative(resolvedBase, resolvedFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Trajectory file path escaped its configured directory");
  }
  return resolvedFile;
}

export function normalizeCodexTrajectoryError(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown error";
  }
}
