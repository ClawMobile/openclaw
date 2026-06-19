import { randomUUID } from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";

type CompactTrajectoryAttempt = {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  modelId: string;
  prompt?: string;
  taskId?: string;
  instruction?: string;
};

type CompactTrajectoryUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
};

type CompactTrajectoryToolCallInput = {
  toolCallId?: string;
  name: string;
  arguments?: unknown;
  success?: boolean;
  error?: string;
  latencyMs?: number;
  resultText?: string;
};

type CompactTrajectoryRecorder = {
  filePath: string;
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  recordModelStepStarted: (params: { startedAtMs: number }) => void;
  recordModelResponse: (params: {
    usage?: CompactTrajectoryUsage;
    durationMs?: number;
    actionNames?: string[];
    toolCalls?: CompactTrajectoryToolCallInput[];
    errorCount?: number;
    assistantTexts?: string[];
    finalPromptText?: string;
    systemPrompt?: string;
  }) => void;
  flush: () => Promise<void>;
};

type CompactTrajectoryInit = {
  attempt: CompactTrajectoryAttempt;
  cwd: string;
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

type TrajectoryMessage = {
  role: "system" | "user" | "assistant" | "tool";
  text?: string;
  obs_ref?: string;
  tool_call_id?: string;
  thought?: string;
  tool_calls?: TrajectoryToolCall[];
  assistant_text?: string;
};

type TrajectoryToolCall = {
  tool_call_id: string;
  name: string;
  arguments: unknown;
};

type TrajectoryExecution = {
  tool_call_id: string;
  status: "ok" | "error";
  error?: string;
  latency_ms?: number;
  result_ref?: string;
  action?: {
    type:
      | "tap"
      | "long_press"
      | "swipe"
      | "type"
      | "key"
      | "scroll"
      | "open_app"
      | "back"
      | "home"
      | "wait"
      | "shell";
    target?: {
      resource_id?: string;
      bounds?: string;
      text?: string;
      class?: string;
    };
    coord?: {
      px?: {
        x?: number;
        y?: number;
      };
      normalized?: {
        x?: number;
        y?: number;
      };
    };
    input_value?: string;
    input_source_param?: string;
    raw_command?: string;
  };
};

type TrajectoryTurn = {
  turn_index: number;
  duration_ms?: number;
  input: {
    context: string[];
  };
  output_ref: string;
  execution?: TrajectoryExecution[];
  env_events?: unknown[];
  token_usage: TrajectoryTokenUsage;
  annotations?: Record<string, unknown>;
};

type TrajectoryOutcome = {
  success: boolean;
  termination_reason: TrajectoryTerminationReason;
  checker_output?: Record<string, unknown>;
};

type TrajectoryDocument = {
  schema_version: "2.1.0";
  trajectory_id: string;
  started_at?: string;
  user_id?: string;
  task_id: string;
  instruction?: string;
  parsed_params?: Array<Record<string, unknown>>;
  agent: {
    framework?: string;
    framework_version?: string;
    model: string;
    model_version?: string;
    config?: Record<string, unknown>;
  };
  messages: Record<string, TrajectoryMessage>;
  observations: Record<string, Record<string, unknown>>;
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
  annotations?: Record<string, unknown>;
};

type ActiveTurn = {
  turnIndex: number;
  startedAtMs?: number;
  toolCalls: ActiveToolCall[];
  failedToolCallIds: Set<string>;
  anonymousErrorCount: number;
};

type ActiveToolCall = TrajectoryToolCall & {
  success?: boolean;
  error?: string;
  latencyMs?: number;
  resultText?: string;
};

const TRAJECTORY_SCHEMA_VERSION = "2.1.0";
const TRAJECTORY_FILE_MAX_BYTES = 5 * 1024 * 1024;
const VALID_TERMINATION_REASONS = new Set<TrajectoryTerminationReason>([
  "success",
  "max_steps",
  "crash",
  "refused",
  "error",
  "user_abort",
]);
const ACTION_TYPES = new Set([
  "tap",
  "long_press",
  "swipe",
  "type",
  "key",
  "scroll",
  "open_app",
  "back",
  "home",
  "wait",
  "shell",
]);

type CompactTrajectoryOpenFlagConstants = Pick<
  typeof nodeFs.constants,
  "O_CREAT" | "O_TRUNC" | "O_WRONLY"
> &
  Partial<Pick<typeof nodeFs.constants, "O_NOFOLLOW">>;

export function resolveCompactTrajectoryWriteFlags(
  constants: CompactTrajectoryOpenFlagConstants = nodeFs.constants,
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
    throw new Error(`Refusing to write oversized trajectory: ${bytes} bytes`);
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

  const handle = await fs.open(filePath, resolveCompactTrajectoryWriteFlags(), 0o600);
  try {
    const stat = await handle.stat();
    verifyStableOpenedTrajectoryFile({ preOpenStat, postOpenStat: stat, filePath });
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

export function createCompactTrajectoryRecorder(
  params: CompactTrajectoryInit,
): CompactTrajectoryRecorder | null {
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
  const messages: Record<string, TrajectoryMessage> = {};
  const contextRefs: string[] = [];
  let activeTurn: ActiveTurn | undefined;
  let finished = false;
  let queue = Promise.resolve();

  const finishRun = (outcome: TrajectoryOutcome) => {
    if (finished) {
      return;
    }
    finished = true;
    if (activeTurn) {
      turns.push(buildTurnRecord(activeTurn, { messages, contextRefs, instruction }));
      activeTurn = undefined;
    }
    const document: TrajectoryDocument = {
      schema_version: TRAJECTORY_SCHEMA_VERSION,
      trajectory_id: trajectoryId,
      started_at: startedAt.toISOString(),
      ...(readEnvString(env, "CLAWMOBILE_TRAJECTORY_USER_ID")
        ? { user_id: readEnvString(env, "CLAWMOBILE_TRAJECTORY_USER_ID") }
        : {}),
      task_id: taskId,
      ...(instruction ? { instruction } : {}),
      ...(resolveParsedParams(env) ? { parsed_params: resolveParsedParams(env) } : {}),
      agent: resolveAgent(params.attempt, env),
      messages,
      observations: {},
      turns,
      outcome,
      rollups: buildRollups(turns),
      annotations: {},
    };
    const content = `${JSON.stringify(document, null, 2)}\n`;
    queue = queue.then(() => safeWriteTrajectoryFile(filePath, content));
  };

  const ensureActiveTurn = () => {
    activeTurn ??= {
      turnIndex: turns.length,
      toolCalls: [],
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
            const turn = ensureActiveTurn();
            turn.toolCalls.push(toActiveToolCall(data ?? {}, turn));
          }
          break;
        }
        case "tool.timeout":
          recordToolFailure(ensureActiveTurn(), data);
          break;
        case "tool.result":
          recordToolResult(ensureActiveTurn(), data);
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
        turns.push(buildTurnRecord(activeTurn, { messages, contextRefs, instruction }));
      }
      activeTurn = {
        turnIndex: turns.length,
        startedAtMs,
        toolCalls: [],
        failedToolCallIds: new Set(),
        anonymousErrorCount: 0,
      };
    },
    recordModelResponse: ({
      usage,
      durationMs,
      actionNames,
      toolCalls,
      errorCount,
      assistantTexts,
      finalPromptText,
      systemPrompt,
    }) => {
      const turn = ensureActiveTurn();
      const structuredToolCalls =
        toolCalls?.flatMap((call) => {
          const name = call.name.trim();
          return name ? [toActiveToolCallFromInput(call, name, turn)] : [];
        }) ?? [];
      if (turn.toolCalls.length === 0 && structuredToolCalls.length > 0) {
        turn.toolCalls.push(...structuredToolCalls);
      }
      const names = actionNames?.map((name) => name.trim()).filter(Boolean) ?? [];
      if (turn.toolCalls.length === 0 && names.length > 0) {
        turn.toolCalls.push(
          ...names.map((name, index) => ({
            tool_call_id: `c${turn.turnIndex}_${index}`,
            name,
            arguments: {},
          })),
        );
      }
      turn.anonymousErrorCount += normalizeInteger(errorCount) ?? 0;
      const resolvedDurationMs =
        normalizeInteger(durationMs) ??
        (typeof turn.startedAtMs === "number"
          ? Math.max(0, Date.now() - turn.startedAtMs)
          : undefined);
      turns.push(
        buildTurnRecord(turn, {
          messages,
          contextRefs,
          instruction,
          systemPrompt,
          finalPromptText,
          assistantText: assistantTexts?.join("\n\n").trim(),
          tokenUsage: toTrajectoryTokenUsage(usage),
          durationMs: resolvedDurationMs,
        }),
      );
      activeTurn = undefined;
    },
    flush: async () => {
      await queue;
    },
  };
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

function resolveTaskId(attempt: CompactTrajectoryAttempt, env: NodeJS.ProcessEnv): string {
  return (
    readEnvString(env, "CLAWMOBILE_TRAJECTORY_TASK_ID") ??
    readEnvString(env, "OPENCLAW_TRAJECTORY_TASK_ID") ??
    attempt.taskId?.trim() ??
    "unknown_task"
  );
}

function resolveInstruction(
  attempt: CompactTrajectoryAttempt,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return (
    readEnvString(env, "CLAWMOBILE_TRAJECTORY_INSTRUCTION") ??
    readEnvString(env, "OPENCLAW_TRAJECTORY_INSTRUCTION") ??
    attempt.instruction?.trim() ??
    attempt.prompt?.trim() ??
    undefined
  );
}

function resolveAgent(
  attempt: CompactTrajectoryAttempt,
  env: NodeJS.ProcessEnv,
): TrajectoryDocument["agent"] {
  return {
    framework: "openclaw",
    ...(readEnvString(env, "CLAWMOBILE_TRAJECTORY_FRAMEWORK_VERSION")
      ? { framework_version: readEnvString(env, "CLAWMOBILE_TRAJECTORY_FRAMEWORK_VERSION") }
      : {}),
    model: readEnvString(env, "CLAWMOBILE_TRAJECTORY_MODEL") ?? attempt.modelId,
    ...(readEnvString(env, "CLAWMOBILE_TRAJECTORY_MODEL_VERSION")
      ? { model_version: readEnvString(env, "CLAWMOBILE_TRAJECTORY_MODEL_VERSION") }
      : {}),
    ...(parseJsonObject(readEnvString(env, "CLAWMOBILE_TRAJECTORY_AGENT_CONFIG"))
      ? { config: parseJsonObject(readEnvString(env, "CLAWMOBILE_TRAJECTORY_AGENT_CONFIG")) }
      : {}),
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

function resolveParsedParams(env: NodeJS.ProcessEnv): Array<Record<string, unknown>> | undefined {
  const parsed = parseJsonValue(readEnvString(env, "CLAWMOBILE_TRAJECTORY_PARSED_PARAMS"));
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed.flatMap((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? [item as Record<string, unknown>]
      : [],
  );
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
  const promptError = normalizeCompactTrajectoryError(data?.promptError);
  if (data?.aborted === true || data?.externalAbort === true) {
    return "user_abort";
  }
  if (data?.timedOut === true || data?.idleTimedOut === true) {
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

function recordToolResult(turn: ActiveTurn, data: Record<string, unknown> | undefined): void {
  const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId.trim() : "";
  const call = toolCallId
    ? turn.toolCalls.find((entry) => entry.tool_call_id === toolCallId)
    : undefined;
  if (!call) {
    return;
  }
  call.success = data?.success === false ? false : true;
  const errorText = readString(data?.error);
  if (errorText) {
    call.error = errorText;
  }
  const latencyMs = normalizeInteger(data?.latencyMs ?? data?.durationMs);
  if (typeof latencyMs === "number") {
    call.latencyMs = latencyMs;
  }
  const resultText =
    readString(data?.contentPreview) ?? readString(data?.text) ?? readString(data?.result);
  if (resultText) {
    call.resultText = resultText;
  }
}

function toActiveToolCall(data: Record<string, unknown>, turn: ActiveTurn): ActiveToolCall {
  const name = readString(data.name) ?? "tool";
  return {
    tool_call_id:
      readString(data.toolCallId) ??
      readString(data.tool_call_id) ??
      `c${turn.turnIndex}_${turn.toolCalls.length}`,
    name,
    arguments: data.arguments ?? {},
  };
}

function toActiveToolCallFromInput(
  call: CompactTrajectoryToolCallInput,
  name: string,
  turn: ActiveTurn,
): ActiveToolCall {
  const result: ActiveToolCall = {
    tool_call_id: call.toolCallId?.trim() || `c${turn.turnIndex}_${turn.toolCalls.length}`,
    name,
    arguments: call.arguments ?? {},
  };
  if (typeof call.success === "boolean") {
    result.success = call.success;
  }
  const error = call.error?.trim();
  if (error) {
    result.error = error;
  }
  const latencyMs = normalizeInteger(call.latencyMs);
  if (typeof latencyMs === "number") {
    result.latencyMs = latencyMs;
  }
  const resultText = call.resultText?.trim();
  if (resultText) {
    result.resultText = resultText;
  }
  return result;
}

function buildTurnRecord(
  turn: ActiveTurn,
  params: {
    messages: Record<string, TrajectoryMessage>;
    contextRefs: string[];
    instruction?: string;
    systemPrompt?: string;
    finalPromptText?: string;
    assistantText?: string;
    tokenUsage?: TrajectoryTokenUsage;
    durationMs?: number;
  },
): TrajectoryTurn {
  const systemPrompt = params.systemPrompt?.trim();
  if (systemPrompt) {
    params.messages.m_sys ??= { role: "system", text: systemPrompt };
    appendUnique(params.contextRefs, "m_sys");
  }
  const userText = params.finalPromptText?.trim() || params.instruction?.trim();
  if (userText) {
    params.messages.m_task ??= { role: "user", text: userText };
    appendUnique(params.contextRefs, "m_task");
  }
  const context = [...params.contextRefs];
  const outputRef = `m_t${turn.turnIndex}_out`;
  const toolCalls = turn.toolCalls;
  params.messages[outputRef] = {
    role: "assistant",
    ...(params.assistantText ? { assistant_text: params.assistantText } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(toTrajectoryToolCallMessage) } : {}),
  };
  for (let index = 0; index < toolCalls.length; index += 1) {
    writeToolResultMessage({
      call: toolCalls[index],
      turnIndex: turn.turnIndex,
      toolIndex: index,
      messages: params.messages,
    });
  }
  const execution = toolCalls.map((call, index): TrajectoryExecution => {
    const failed =
      call.success === false ||
      turn.failedToolCallIds.has(call.tool_call_id) ||
      index < turn.anonymousErrorCount;
    const resultRef = buildToolResultMessageRef(turn.turnIndex, index);
    const action = toTrajectoryAction(call.name, call.arguments);
    return {
      tool_call_id: call.tool_call_id,
      status: failed ? "error" : "ok",
      ...(failed ? { error: call.error ?? "tool execution failed" } : {}),
      ...(typeof call.latencyMs === "number" ? { latency_ms: call.latencyMs } : {}),
      ...(params.messages[resultRef] ? { result_ref: resultRef } : {}),
      ...(action ? { action } : {}),
    };
  });
  appendUnique(params.contextRefs, outputRef);
  for (let index = 0; index < toolCalls.length; index += 1) {
    const resultRef = buildToolResultMessageRef(turn.turnIndex, index);
    if (params.messages[resultRef]) {
      appendUnique(params.contextRefs, resultRef);
    }
  }
  return {
    turn_index: turn.turnIndex,
    ...(typeof params.durationMs === "number" ? { duration_ms: params.durationMs } : {}),
    input: { context },
    output_ref: outputRef,
    ...(execution.length > 0 ? { execution } : {}),
    token_usage: params.tokenUsage ?? { input: 0, output: 0 },
    annotations: {},
  };
}

function toTrajectoryToolCallMessage(call: ActiveToolCall): TrajectoryToolCall {
  return {
    tool_call_id: call.tool_call_id,
    name: call.name,
    arguments: call.arguments,
  };
}

function writeToolResultMessage(params: {
  call: ActiveToolCall | undefined;
  turnIndex: number;
  toolIndex: number;
  messages: Record<string, TrajectoryMessage>;
}): void {
  const resultText = params.call?.resultText?.trim();
  if (!params.call || !resultText) {
    return;
  }
  const resultRef = buildToolResultMessageRef(params.turnIndex, params.toolIndex);
  params.messages[resultRef] = {
    role: "tool",
    tool_call_id: params.call.tool_call_id,
    text: resultText,
  };
}

function buildToolResultMessageRef(turnIndex: number, toolIndex: number): string {
  return `m_t${turnIndex}_res${toolIndex === 0 ? "" : `_${toolIndex}`}`;
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function toTrajectoryAction(
  name: string,
  args: unknown,
): TrajectoryExecution["action"] | undefined {
  const normalized = name.trim();
  if (!ACTION_TYPES.has(normalized)) {
    return undefined;
  }
  const argRecord = toRecord(args);
  const target = buildTrajectoryTarget(argRecord);
  const coord = buildTrajectoryCoord(argRecord);
  const inputValue =
    readString(argRecord.input_value) ??
    (normalized === "type"
      ? (readString(argRecord.text) ?? readString(argRecord.value) ?? readString(argRecord.input))
      : undefined);
  const inputSourceParam = readString(argRecord.input_source_param);
  const rawCommand =
    readString(argRecord.raw_command) ??
    readString(argRecord.rawCommand) ??
    readString(argRecord.command) ??
    readString(argRecord.adb_command);
  return {
    type: normalized as NonNullable<TrajectoryExecution["action"]>["type"],
    ...(target ? { target } : {}),
    ...(coord ? { coord } : {}),
    ...(inputValue ? { input_value: inputValue } : {}),
    ...(inputSourceParam ? { input_source_param: inputSourceParam } : {}),
    ...(rawCommand ? { raw_command: rawCommand } : {}),
  };
}

function buildTrajectoryTarget(
  args: Record<string, unknown>,
): NonNullable<NonNullable<TrajectoryExecution["action"]>["target"]> | undefined {
  const target = {
    ...(readString(args.resource_id) ? { resource_id: readString(args.resource_id) } : {}),
    ...(readString(args.resourceId) ? { resource_id: readString(args.resourceId) } : {}),
    ...(readString(args.bounds) ? { bounds: readString(args.bounds) } : {}),
    ...(readString(args.text) ? { text: readString(args.text) } : {}),
    ...(readString(args.class) ? { class: readString(args.class) } : {}),
    ...(readString(args.className) ? { class: readString(args.className) } : {}),
  };
  return Object.keys(target).length > 0 ? target : undefined;
}

function buildTrajectoryCoord(
  args: Record<string, unknown>,
): NonNullable<NonNullable<TrajectoryExecution["action"]>["coord"]> | undefined {
  const px = toPoint(args.px) ?? toPointFromKeys(args, "x", "y");
  const normalized =
    toPoint(args.normalized) ??
    toPointFromKeys(args, "normalized_x", "normalized_y") ??
    toPointFromKeys(args, "x_norm", "y_norm");
  const coord = {
    ...(px ? { px } : {}),
    ...(normalized ? { normalized } : {}),
  };
  return Object.keys(coord).length > 0 ? coord : undefined;
}

function toPoint(value: unknown): { x?: number; y?: number } | undefined {
  const record = toRecord(value);
  return toPointFromKeys(record, "x", "y");
}

function toPointFromKeys(
  record: Record<string, unknown>,
  xKey: string,
  yKey: string,
): { x?: number; y?: number } | undefined {
  const x = readNumber(record[xKey]);
  const y = readNumber(record[yKey]);
  const point = {
    ...(typeof x === "number" ? { x } : {}),
    ...(typeof y === "number" ? { y } : {}),
  };
  return Object.keys(point).length > 0 ? point : undefined;
}

function buildRollups(turns: TrajectoryTurn[]): TrajectoryDocument["rollups"] {
  const totalDuration = turns.reduce((sum, turn) => sum + (turn.duration_ms ?? 0), 0);
  return {
    total_turns: turns.length,
    total_actions: turns.reduce((sum, turn) => sum + (turn.execution?.length ?? 0), 0),
    total_errors: turns.reduce(
      (sum, turn) =>
        sum + (turn.execution?.filter((execution) => execution.status === "error").length ?? 0),
      0,
    ),
    total_tokens: {
      input: turns.reduce((sum, turn) => sum + turn.token_usage.input, 0),
      output: turns.reduce((sum, turn) => sum + turn.token_usage.output, 0),
    },
    ...(turns.some((turn) => typeof turn.duration_ms === "number")
      ? { total_duration_ms: totalDuration }
      : {}),
  };
}

function toTrajectoryTokenUsage(usage: CompactTrajectoryUsage | undefined): TrajectoryTokenUsage {
  const cached = normalizeInteger(usage?.cacheRead);
  return {
    input: normalizeInteger(usage?.input) ?? 0,
    output: normalizeInteger(usage?.output) ?? 0,
    ...(typeof cached === "number" ? { cached } : {}),
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readEnvString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
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

function parseJsonValue(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
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

export function normalizeCompactTrajectoryError(value: unknown): string | null {
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
