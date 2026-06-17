import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InputFile, type Bot, type Context } from "grammy";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-streaming";
import {
  resolveCommandAuthorization,
  resolveCommandAuthorizedFromAuthorizers,
  resolveNativeCommandSessionTargets,
} from "openclaw/plugin-sdk/command-auth-native";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  parseCommandArgs,
  resolveCommandArgMenu,
  resolveStoredModelOverride,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-types";
import type {
  ReplyToMode,
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-types";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  loadSessionStore,
  resolveAndPersistSessionFile,
  resolveSessionStoreEntry,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveTelegramAccount } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  expandTelegramAllowFromWithAccessGroups,
  isSenderAllowed,
  normalizeDmAllowFromWithStore,
} from "./bot-access.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import {
  defaultTelegramNativeCommandDeps,
  type TelegramNativeCommandDeps,
} from "./bot-native-command-deps.runtime.js";
import {
  buildCappedTelegramMenuCommands,
  buildPluginTelegramMenuCommands,
  syncTelegramMenuCommands as syncTelegramMenuCommandsRuntime,
} from "./bot-native-command-menu.js";
import { TelegramUpdateKeyContext } from "./bot-updates.js";
import type { TelegramBotOptions } from "./bot.types.js";
import {
  buildTelegramRoutingTarget,
  buildTelegramThreadParams,
  buildSenderName,
  buildTelegramGroupFrom,
  extractTelegramForumFlag,
  resolveTelegramForumFlag,
  resolveTelegramGroupAllowFromContext,
  resolveTelegramThreadSpec,
  shouldUseTelegramDmThreadSession,
} from "./bot/helpers.js";
import type { TelegramContext, TelegramGetChat } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import {
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
  TELEGRAM_COMMAND_NAME_PATTERN,
} from "./command-config.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import type { TelegramTransport } from "./fetch.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import { resolveTelegramGroupPromptSettings } from "./group-config-helpers.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { recordSentMessage } from "./sent-message-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX = "tgcmd:";

type TelegramNativeCommandContext = Context & { match?: string };
type TelegramChunkMode = ReturnType<
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").resolveChunkMode
>;
type TelegramNativeReplyPayload = import("openclaw/plugin-sdk/reply-dispatch-runtime").ReplyPayload;
type TelegramNativeReplyChannelData = {
  buttons?: TelegramInlineButtons;
  pin?: boolean;
};
type TelegramResolvedGroupConfig = {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
};

type TelegramCommandAuthResult = {
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  resolvedThreadId?: number;
  senderId: string;
  senderUsername: string;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  commandAuthorized: boolean;
  senderIsOwner: boolean;
};

type TelegramNativeCommandThreadContext = {
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  messageThreadId: number | undefined;
  threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
  threadParams: ReturnType<typeof buildTelegramThreadParams>;
};

type ClawMobileTraceEvent = {
  scope?: string;
  phase?: string;
  invocation_id?: string;
  tool?: string;
  ok?: boolean;
  timestamp?: string;
  backend?: string;
  action?: string;
  action_parameters?: unknown;
  input?: Record<string, unknown>;
};

type ClawMobileTraceRunFile = {
  file: string;
  stat: Stats;
};

type ClawMobileTraceSummary = {
  actions: number;
  startedAt?: string;
  tool?: string;
  backend?: string;
  firstAction?: string;
  lastAction?: string;
  label?: string;
};

type ClawMobileTraceListEntry = ClawMobileTraceSummary & {
  index: number;
  path: string;
  filename: string;
  bytes: number;
  modifiedAt: string;
};

const CLAWMOBILE_LEGACY_TRACE_FILENAME = "clawmobile-trace.jsonl";
const CLAWMOBILE_TRACE_RUN_FILENAME_RE = /^clawmobile-trace-(.+)-\d+-\1_\d+_\d+\.jsonl$/i;
const CLAWMOBILE_TRACE_ARTIFACT_FILENAME_RE = /^clawmobile-trace.*\.jsonl$/i;
const CLAWMOBILE_TRACE_LIST_LIMIT = 50;
const CLAWMOBILE_TRACE_COMMAND = "clawmobile_trace";
const CLAWMOBILE_TRACE_LIST_COMMAND = "clawmobile_trace_list";
const CLAWMOBILE_TRACE_CLEAR_COMMAND = "clawmobile_trace_clear";
const CLAWMOBILE_TRACE_NATIVE_COMMANDS = new Set([
  CLAWMOBILE_TRACE_COMMAND,
  CLAWMOBILE_TRACE_LIST_COMMAND,
  CLAWMOBILE_TRACE_CLEAR_COMMAND,
]);

let telegramNativeCommandDeliveryRuntimePromise:
  | Promise<typeof import("./bot-native-commands.delivery.runtime.js")>
  | undefined;

async function loadTelegramNativeCommandDeliveryRuntime() {
  telegramNativeCommandDeliveryRuntimePromise ??=
    import("./bot-native-commands.delivery.runtime.js");
  return await telegramNativeCommandDeliveryRuntimePromise;
}

let telegramNativeCommandRuntimePromise:
  | Promise<typeof import("./bot-native-commands.runtime.js")>
  | undefined;

async function loadTelegramNativeCommandRuntime() {
  telegramNativeCommandRuntimePromise ??= import("./bot-native-commands.runtime.js");
  return await telegramNativeCommandRuntimePromise;
}

function resolveTelegramProgressPlaceholder(command: {
  nativeProgressMessages?: Partial<Record<string, string>> & { default?: string };
}): string | null {
  const text =
    command.nativeProgressMessages?.telegram?.trim() ??
    command.nativeProgressMessages?.default?.trim();
  return text ? text : null;
}

function resolveClawMobileWorkspaceDir(): string {
  const explicit = normalizeOptionalString(process.env.OPENCLAW_WORKSPACE);
  if (explicit) {
    return explicit;
  }
  return path.join(resolveStateDir(process.env, os.homedir), "workspace");
}

function resolveClawMobileLogsDir(): string {
  return path.join(resolveClawMobileWorkspaceDir(), "logs");
}

function resolveClawMobileLegacyTracePath(): string {
  return path.join(resolveClawMobileLogsDir(), CLAWMOBILE_LEGACY_TRACE_FILENAME);
}

function isClawMobileTraceRunFilename(name: string): boolean {
  return name === CLAWMOBILE_LEGACY_TRACE_FILENAME || CLAWMOBILE_TRACE_RUN_FILENAME_RE.test(name);
}

function isClawMobileTraceArtifactFilename(name: string): boolean {
  return CLAWMOBILE_TRACE_ARTIFACT_FILENAME_RE.test(name);
}

function sanitizeTraceLabel(label?: string): string {
  const trimmed = (label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return trimmed || "trace";
}

function formatTraceBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function collectClawMobileTraceFiles(
  predicate: (name: string) => boolean,
): Promise<ClawMobileTraceRunFile[]> {
  const dir = resolveClawMobileLogsDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const files: ClawMobileTraceRunFile[] = [];
  for (const name of names) {
    if (!predicate(name)) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) {
        files.push({ file, stat });
      }
    } catch {
      // Ignore files that disappear while listing.
    }
  }
  return files.toSorted((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

function summarizeTraceInput(tool?: string, input?: Record<string, unknown>): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  if (tool === "android_agent_task") {
    const goal = typeof input.goal === "string" ? input.goal.trim() : "";
    return goal || null;
  }
  if (tool === "android_type") {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    return text ? `type ${text}` : null;
  }
  if (tool === "android_tap") {
    const x = typeof input.x === "number" ? input.x : null;
    const y = typeof input.y === "number" ? input.y : null;
    return x != null && y != null ? `tap ${x} ${y}` : null;
  }
  if (tool === "android_swipe") {
    return "swipe";
  }
  if (tool === "android_screenshot") {
    return "screenshot";
  }
  if (tool === "android_ui_dump") {
    return "ui dump";
  }
  return typeof tool === "string" && tool.trim() ? tool : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function summarizeTraceAction(event: ClawMobileTraceEvent): string | null {
  const action = typeof event.action === "string" ? event.action.trim() : "";
  const params = asRecord(event.action_parameters);

  if (action === "android_agent_task") {
    const goal = typeof params?.goal === "string" ? params.goal.trim() : "";
    return goal || null;
  }
  if (action === "android_type" || action === "input") {
    const text = typeof params?.text === "string" ? params.text.trim() : "";
    return text ? `type ${text}` : action;
  }
  if (action === "android_tap" || action === "tap") {
    const x = typeof params?.x === "number" ? params.x : null;
    const y = typeof params?.y === "number" ? params.y : null;
    return x != null && y != null ? `tap ${x} ${y}` : action;
  }
  if (action === "android_swipe" || action === "scroll") {
    return "swipe";
  }
  if (action) {
    return action;
  }
  return summarizeTraceInput(event.tool, event.input);
}

async function summarizeClawMobileTraceFile(file: string): Promise<ClawMobileTraceSummary> {
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return { actions: 0 };
  }

  let actions = 0;
  let first: ClawMobileTraceEvent | null = null;
  let last: ClawMobileTraceEvent | null = null;
  const legacyEvents: ClawMobileTraceEvent[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    actions += 1;
    try {
      const event = JSON.parse(line) as ClawMobileTraceEvent;
      legacyEvents.push(event);
      if (event.action) {
        if (!first) {
          first = event;
        }
        last = event;
      }
    } catch {
      // Ignore malformed trace lines and keep scanning the rest.
    }
  }

  if (!first && legacyEvents.length > 0) {
    for (let i = legacyEvents.length - 1; i >= 0; i -= 1) {
      const event = legacyEvents[i];
      if (event.scope === "tool" && event.phase === "start") {
        first = event;
        last = last ?? event;
        break;
      }
    }
  }

  const label = first ? summarizeTraceAction(first) : null;
  const lastAction = last?.action ?? (last ? (summarizeTraceAction(last) ?? undefined) : undefined);
  return {
    actions,
    startedAt: first?.timestamp,
    tool: first?.tool,
    backend: first?.backend,
    firstAction: first?.action ?? label ?? undefined,
    lastAction,
    label: label ?? first?.tool ?? undefined,
  };
}

async function buildClawMobileTraceEntry(
  item: ClawMobileTraceRunFile,
  index: number,
): Promise<ClawMobileTraceListEntry> {
  const summary = await summarizeClawMobileTraceFile(item.file);
  return {
    index,
    path: item.file,
    filename: path.basename(item.file),
    bytes: item.stat.size,
    modifiedAt: new Date(item.stat.mtimeMs).toISOString(),
    ...summary,
  };
}

function formatClawMobileTraceList(traces: ClawMobileTraceListEntry[], count: number): string {
  if (!traces.length) {
    return "No ClawMobile traces found.";
  }

  const lines = traces.map((trace) => {
    const time = trace.startedAt || trace.modifiedAt;
    const label = trace.tool || "trace";
    const backend = trace.backend ? `/${trace.backend}` : "";
    const lastAction = trace.lastAction ? ` last=${trace.lastAction}` : "";
    return `${trace.index}. ${time} ${label}${backend} ${trace.actions} actions ${formatTraceBytes(
      trace.bytes,
    )}${lastAction}`;
  });

  if (traces.length < count) {
    lines.push(`... ${count - traces.length} more traces not shown`);
  }

  return lines.join("\n");
}

async function listClawMobileTracesForTelegram(limit = CLAWMOBILE_TRACE_LIST_LIMIT) {
  const files = await collectClawMobileTraceFiles(isClawMobileTraceRunFilename);
  const cappedLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
  const traces = await Promise.all(
    files.slice(0, cappedLimit).map((item, i) => buildClawMobileTraceEntry(item, i + 1)),
  );

  return {
    ok: true as const,
    count: files.length,
    returned: traces.length,
    traces,
    text: formatClawMobileTraceList(traces, files.length),
  };
}

async function getClawMobileTraceByIndex(index: number) {
  const normalized = Math.trunc(index);
  const files = await collectClawMobileTraceFiles(isClawMobileTraceRunFilename);
  const preview = await listClawMobileTracesForTelegram(CLAWMOBILE_TRACE_LIST_LIMIT);

  if (!Number.isFinite(normalized) || normalized < 1) {
    return {
      ok: false as const,
      error: "invalid_trace_index",
      index,
      count: files.length,
      text: preview.text,
    };
  }

  const item = files[normalized - 1];
  if (!item) {
    return {
      ok: false as const,
      error: "trace_index_not_found",
      index: normalized,
      count: files.length,
      text: preview.text,
    };
  }

  return { ok: true as const, trace: await buildClawMobileTraceEntry(item, normalized) };
}

async function clearClawMobileTracesForTelegram() {
  const files = await collectClawMobileTraceFiles(isClawMobileTraceArtifactFilename);
  let deleted = 0;
  let bytes = 0;
  const errors: Array<{ path: string; error: string }> = [];

  for (const item of files) {
    try {
      await fs.unlink(item.file);
      deleted += 1;
      bytes += item.stat.size;
    } catch (error) {
      errors.push({
        path: item.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: errors.length === 0,
    deleted,
    bytes,
    errors,
    text: errors.length
      ? `Deleted ${deleted} trace file(s), failed to delete ${errors.length}.`
      : `Deleted ${deleted} trace file(s), freed ${formatTraceBytes(bytes)}.`,
  };
}

async function exportSelectedClawMobileTraceSnapshotForTelegram(input?: {
  index?: number;
  label?: string;
}): Promise<
  | { ok: true; path: string; label: string; source: string; index?: number }
  | { ok: false; error: string; path: string; text?: string }
> {
  let source = "";
  let selectedTrace: ClawMobileTraceListEntry | undefined;
  if (input?.index !== undefined) {
    const selected = await getClawMobileTraceByIndex(input.index);
    if (!selected.ok) {
      return {
        ok: false,
        error: selected.error,
        path: "",
        text: selected.text,
      };
    }
    selectedTrace = selected.trace;
    source = selected.trace.path;
  } else {
    const files = await collectClawMobileTraceFiles(isClawMobileTraceRunFilename);
    source = files[0]?.file ?? resolveClawMobileLegacyTracePath();
    if (files[0]) {
      selectedTrace = await buildClawMobileTraceEntry(files[0], 1);
    }
  }

  let content: string;
  try {
    content = await fs.readFile(source, "utf-8");
  } catch {
    return { ok: false, error: "trace_not_found", path: source };
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const events: ClawMobileTraceEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as ClawMobileTraceEvent);
    } catch {
      // Ignore malformed trace lines and keep scanning the rest.
    }
  }

  let invocationId: string | undefined;
  let tool: string | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.scope === "tool" && event.phase === "end") {
      invocationId = event.invocation_id;
      tool = event.tool;
      break;
    }
    if (!tool && event.tool) {
      tool = event.tool;
    }
  }

  let summary: string | null = null;
  if (invocationId) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (
        event.scope === "tool" &&
        event.phase === "start" &&
        event.invocation_id === invocationId
      ) {
        summary = summarizeTraceInput(event.tool, event.input);
        tool = event.tool ?? tool;
        break;
      }
    }
  }
  if (!summary && events.length > 0) {
    summary = summarizeTraceAction(events[0]);
    tool = events[0]?.tool ?? tool;
  }

  const fallbackLabel = sanitizeTraceLabel(summary ?? tool ?? "trace");
  const label = sanitizeTraceLabel(input?.label ?? selectedTrace?.label ?? fallbackLabel);
  const snapshotPath = path.join(
    path.dirname(source),
    `clawmobile-trace-${label}-${Date.now()}-${randomUUID()}.jsonl`,
  );
  await fs.copyFile(source, snapshotPath);
  return {
    ok: true,
    path: snapshotPath,
    label,
    source,
    ...(selectedTrace ? { index: selectedTrace.index } : {}),
  };
}

async function resolveTelegramCommandSessionFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  threadId?: string | number;
}): Promise<{ sessionId?: string; sessionFile?: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return {};
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const store = loadSessionStore(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const sessionId = resolved.existing?.sessionId?.trim() || randomUUID();
    const sessionsDir = path.dirname(storePath);
    const fallbackSessionFile = resolveSessionTranscriptPathInDir(
      sessionId,
      sessionsDir,
      params.threadId,
    );
    const persisted = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey: resolved.normalizedKey,
      sessionStore: store,
      storePath,
      sessionEntry: resolved.existing,
      agentId: params.agentId,
      sessionsDir,
      fallbackSessionFile,
    });
    return { sessionId, sessionFile: persisted.sessionFile };
  } catch {
    return {};
  }
}

function resolveTelegramCommandMenuModelContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): { provider?: string; model?: string } {
  if (!params.sessionKey.trim()) {
    return {};
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const defaultModel = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    const store = loadSessionStore(storePath);
    const entry = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey }).existing;
    if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) {
      return { provider: defaultModel.provider, model: defaultModel.model };
    }
    const override = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey: params.sessionKey,
      defaultProvider: defaultModel.provider,
    });
    if (override?.model) {
      return {
        provider: override.provider || defaultModel.provider,
        model: override.model,
      };
    }
    const provider =
      normalizeOptionalString(entry?.providerOverride) ??
      normalizeOptionalString(entry?.modelProvider);
    const model =
      normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model);
    return {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    };
  } catch {
    return {};
  }
}

function resolveTelegramNativeReplyChannelData(
  result: TelegramNativeReplyPayload,
): TelegramNativeReplyChannelData | undefined {
  return result.channelData?.telegram as TelegramNativeReplyChannelData | undefined;
}

function normalizeTelegramNativeReplyPayload(
  result: TelegramNativeReplyPayload | null | undefined,
): TelegramNativeReplyPayload {
  return result && typeof result === "object" ? result : {};
}

function hasRenderableTelegramNativeReplyPayload(result: TelegramNativeReplyPayload): boolean {
  return resolveSendableOutboundReplyParts(result).hasContent;
}

function isEditableTelegramProgressResult(result: TelegramNativeReplyPayload): boolean {
  const telegramData = resolveTelegramNativeReplyChannelData(result);
  return Boolean(
    typeof result.text === "string" &&
    result.text.trim() &&
    !result.mediaUrl &&
    (!result.mediaUrls || result.mediaUrls.length === 0) &&
    !result.interactive &&
    !result.btw &&
    telegramData?.pin !== true,
  );
}

async function cleanupTelegramProgressPlaceholder(params: {
  bot: Bot;
  chatId: number;
  progressMessageId?: number;
  runtime: RuntimeEnv;
}): Promise<void> {
  const progressMessageId = params.progressMessageId;
  if (progressMessageId == null) {
    return;
  }
  try {
    await withTelegramApiErrorLogging({
      operation: "deleteMessage",
      runtime: params.runtime,
      fn: () => params.bot.api.deleteMessage(params.chatId, progressMessageId),
    });
  } catch {
    // Best-effort cleanup before fallback or suppression exits.
  }
}

async function resolveTelegramNativeCommandThreadContext(params: {
  msg: NonNullable<TelegramNativeCommandContext["message"]>;
  bot: Bot;
}): Promise<TelegramNativeCommandThreadContext> {
  const { msg, bot } = params;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const getChat =
    typeof bot.api.getChat === "function"
      ? (bot.api.getChat.bind(bot.api) as TelegramGetChat)
      : undefined;
  const isForum = await resolveTelegramForumFlag({
    chatId,
    chatType: msg.chat.type,
    isGroup,
    isForum: extractTelegramForumFlag(msg.chat),
    getChat,
  });
  const threadSpec = resolveTelegramThreadSpec({
    isGroup,
    isForum,
    messageThreadId,
  });
  return {
    chatId,
    isGroup,
    isForum,
    messageThreadId,
    threadSpec,
    threadParams: buildTelegramThreadParams(threadSpec),
  };
}

export type RegisterTelegramHandlerParams = {
  cfg: OpenClawConfig;
  accountId: string;
  bot: Bot;
  mediaMaxBytes: number;
  opts: TelegramBotOptions;
  telegramTransport?: TelegramTransport;
  runtime: RuntimeEnv;
  telegramCfg: TelegramAccountConfig;
  telegramDeps: TelegramBotDeps;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => TelegramResolvedGroupConfig;
  shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
  processMessage: (
    ctx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: TelegramMessageContextOptions,
    replyMedia?: TelegramMediaRef[],
  ) => Promise<void>;
  logger: ReturnType<typeof getChildLogger>;
};

export function buildTelegramNativeCommandCallbackData(commandText: string): string {
  return `${TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX}${commandText}`;
}

export function parseTelegramNativeCommandCallbackData(data?: string | null): string | null {
  if (!data) {
    return null;
  }
  const trimmed = data.trim();
  if (!trimmed.startsWith(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX)) {
    return null;
  }
  const commandText = trimmed.slice(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX.length).trim();
  return commandText.startsWith("/") ? commandText : null;
}

export function resolveTelegramNativeCommandDisableBlockStreaming(
  telegramCfg: TelegramAccountConfig,
): boolean | undefined {
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
  return typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined;
}

export type RegisterTelegramNativeCommandsParams = {
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  replyToMode: ReplyToMode;
  textLimit: number;
  useAccessGroups: boolean;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  nativeDisabledExplicit: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => TelegramResolvedGroupConfig;
  shouldSkipUpdate: (ctx: TelegramUpdateKeyContext) => boolean;
  telegramDeps?: TelegramNativeCommandDeps;
  opts: { token: string };
};

async function resolveTelegramCommandAuth(params: {
  msg: NonNullable<TelegramNativeCommandContext["message"]>;
  bot: Bot;
  cfg: OpenClawConfig;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  readChannelAllowFromStore: TelegramBotDeps["readChannelAllowFromStore"];
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => TelegramResolvedGroupConfig;
  requireAuth: boolean;
}): Promise<TelegramCommandAuthResult | null> {
  const {
    msg,
    bot,
    cfg,
    accountId,
    telegramCfg,
    readChannelAllowFromStore,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    requireAuth,
  } = params;
  const { chatId, isGroup, isForum, messageThreadId, threadParams } =
    await resolveTelegramNativeCommandThreadContext({ msg, bot });
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const senderUsername = msg.from?.username ?? "";
  const groupAllowContext = await resolveTelegramGroupAllowFromContext({
    cfg,
    chatId,
    accountId,
    senderId,
    isGroup,
    isForum,
    messageThreadId,
    groupAllowFrom,
    readChannelAllowFromStore,
    resolveTelegramGroupConfig,
  });
  const {
    resolvedThreadId,
    dmThreadId,
    storeAllowFrom,
    groupConfig,
    topicConfig,
    groupAllowOverride,
    effectiveGroupAllow,
    hasGroupAllowOverride,
  } = groupAllowContext;
  // Use direct config dmPolicy override if available for DMs
  const effectiveDmPolicy =
    !isGroup && groupConfig && "dmPolicy" in groupConfig
      ? (groupConfig.dmPolicy ?? telegramCfg.dmPolicy ?? "pairing")
      : (telegramCfg.dmPolicy ?? "pairing");
  const requireTopic =
    !isGroup && groupConfig && "requireTopic" in groupConfig ? groupConfig.requireTopic : undefined;
  if (!isGroup && requireTopic === true && dmThreadId == null) {
    logVerbose(`Blocked telegram command in DM ${chatId}: requireTopic=true but no topic present`);
    return null;
  }
  // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
  const dmAllowFrom = groupAllowOverride ?? allowFrom;
  const expandedDmAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg,
    allowFrom: dmAllowFrom,
    accountId,
    senderId,
  });
  const commandsAllowFrom = cfg.commands?.allowFrom;
  const commandsAllowFromConfigured =
    commandsAllowFrom != null &&
    typeof commandsAllowFrom === "object" &&
    (Array.isArray(commandsAllowFrom.telegram) || Array.isArray(commandsAllowFrom["*"]));
  const commandsAllowFromAccess = commandsAllowFromConfigured
    ? resolveCommandAuthorization({
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          OriginatingChannel: "telegram",
          AccountId: accountId,
          ChatType: isGroup ? "group" : "direct",
          From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
          SenderId: senderId || undefined,
          SenderUsername: senderUsername || undefined,
        },
        cfg,
        // commands.allowFrom is the only auth source when configured.
        commandAuthorized: false,
      })
    : null;
  const ownerAccess = resolveCommandAuthorization({
    ctx: {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      AccountId: accountId,
      ChatType: isGroup ? "group" : "direct",
      From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
      SenderId: senderId || undefined,
      SenderUsername: senderUsername || undefined,
    },
    cfg,
    commandAuthorized: false,
  });

  const sendAuthMessage = async (text: string) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => bot.api.sendMessage(chatId, text, threadParams ?? {}),
    });
    return null;
  };
  const rejectNotAuthorized = async () => {
    return await sendAuthMessage("You are not authorized to use this command.");
  };

  const baseAccess = evaluateTelegramGroupBaseAccess({
    isGroup,
    groupConfig,
    topicConfig,
    hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    enforceAllowOverride: requireAuth,
    requireSenderForAllowOverride: true,
  });
  if (!baseAccess.allowed) {
    if (baseAccess.reason === "group-disabled") {
      return await sendAuthMessage("This group is disabled.");
    }
    if (baseAccess.reason === "topic-disabled") {
      return await sendAuthMessage("This topic is disabled.");
    }
    return await rejectNotAuthorized();
  }

  const policyAccess = evaluateTelegramGroupPolicyAccess({
    isGroup,
    chatId,
    cfg,
    telegramCfg,
    topicConfig,
    groupConfig,
    effectiveGroupAllow,
    senderId,
    senderUsername,
    resolveGroupPolicy,
    enforcePolicy: useAccessGroups,
    useTopicAndGroupOverrides: false,
    enforceAllowlistAuthorization: requireAuth && !commandsAllowFromConfigured,
    allowEmptyAllowlistEntries: true,
    requireSenderForAllowlistAuthorization: true,
    checkChatAllowlist: useAccessGroups,
  });
  if (!policyAccess.allowed) {
    if (policyAccess.reason === "group-policy-disabled") {
      return await sendAuthMessage("Telegram group commands are disabled.");
    }
    if (
      policyAccess.reason === "group-policy-allowlist-no-sender" ||
      policyAccess.reason === "group-policy-allowlist-unauthorized"
    ) {
      return await rejectNotAuthorized();
    }
    if (policyAccess.reason === "group-chat-not-allowed") {
      return await sendAuthMessage("This group is not allowed.");
    }
  }

  const dmAllow = normalizeDmAllowFromWithStore({
    allowFrom: expandedDmAllowFrom,
    storeAllowFrom: isGroup ? [] : storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  const senderAllowed = isSenderAllowed({
    allow: dmAllow,
    senderId,
    senderUsername,
  });
  const groupSenderAllowed = isGroup
    ? isSenderAllowed({ allow: effectiveGroupAllow, senderId, senderUsername })
    : false;
  const ownerAuthorizerConfigured = ownerAccess.senderIsOwner || ownerAccess.ownerList.length > 0;
  const commandAuthorized = commandsAllowFromConfigured
    ? Boolean(commandsAllowFromAccess?.isAuthorizedSender)
    : resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: dmAllow.hasEntries, allowed: senderAllowed },
          ...(isGroup
            ? [{ configured: effectiveGroupAllow.hasEntries, allowed: groupSenderAllowed }]
            : []),
          {
            configured: ownerAuthorizerConfigured,
            allowed: ownerAccess.senderIsOwner,
          },
        ],
        modeWhenAccessGroupsOff: "configured",
      });
  if (requireAuth && !commandAuthorized) {
    return await rejectNotAuthorized();
  }

  return {
    chatId,
    isGroup,
    isForum,
    resolvedThreadId,
    senderId,
    senderUsername,
    groupConfig,
    topicConfig,
    commandAuthorized,
    senderIsOwner: ownerAccess.senderIsOwner,
  };
}

export const registerTelegramNativeCommands = ({
  bot,
  cfg,
  runtime,
  accountId,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  replyToMode,
  textLimit,
  useAccessGroups,
  nativeEnabled,
  nativeSkillsEnabled,
  nativeDisabledExplicit,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  telegramDeps = defaultTelegramNativeCommandDeps,
  opts,
}: RegisterTelegramNativeCommandsParams) => {
  const boundRoute =
    nativeEnabled && nativeSkillsEnabled
      ? resolveAgentRoute({ cfg, channel: "telegram", accountId })
      : null;
  if (nativeEnabled && nativeSkillsEnabled && !boundRoute) {
    runtime.log?.(
      "nativeSkillsEnabled is true but no agent route is bound for this Telegram account; skill commands will not appear in the native menu.",
    );
  }
  const skillCommands =
    nativeEnabled && nativeSkillsEnabled && boundRoute
      ? telegramDeps.listSkillCommandsForAgents({
          cfg,
          agentIds: [boundRoute.agentId],
        })
      : [];
  const nativeCommands = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, {
        skillCommands,
        provider: "telegram",
      })
    : [];
  const reservedCommands = new Set(
    listNativeCommandSpecs().map((command) => normalizeTelegramCommandName(command.name)),
  );
  for (const command of skillCommands) {
    reservedCommands.add(normalizeLowercaseStringOrEmpty(command.name));
  }
  const customResolution = resolveTelegramCustomCommands({
    commands: telegramCfg.customCommands,
    reservedCommands,
  });
  for (const issue of customResolution.issues) {
    runtime.error?.(danger(issue.message));
  }
  const customCommands = customResolution.commands;
  const pluginCommandSpecs =
    (
      telegramDeps.getPluginCommandSpecs ?? defaultTelegramNativeCommandDeps.getPluginCommandSpecs
    )?.("telegram") ?? [];
  const existingCommands = new Set(
    [
      ...nativeCommands.map((command) => normalizeTelegramCommandName(command.name)),
      ...customCommands.map((command) => command.command),
    ].map((command) => normalizeLowercaseStringOrEmpty(command)),
  );
  const pluginCatalog = buildPluginTelegramMenuCommands({
    specs: pluginCommandSpecs,
    existingCommands,
  });
  for (const issue of pluginCatalog.issues) {
    runtime.error?.(danger(issue));
  }
  const loadFreshRuntimeConfig = (): OpenClawConfig => telegramDeps.getRuntimeConfig();
  const resolveFreshTelegramConfig = (runtimeCfg: OpenClawConfig): TelegramAccountConfig => {
    try {
      return resolveTelegramAccount({
        cfg: runtimeCfg,
        accountId,
      }).config;
    } catch (error) {
      logVerbose(
        `telegram native command: failed to load fresh account config for ${accountId}; using startup snapshot: ${String(error)}`,
      );
      return telegramCfg;
    }
  };
  const allCommandsFull: Array<{ command: string; description: string }> = [
    ...nativeCommands
      .map((command) => {
        const normalized = normalizeTelegramCommandName(command.name);
        if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
          runtime.error?.(
            danger(
              `Native command "${command.name}" is invalid for Telegram (resolved to "${normalized}"). Skipping.`,
            ),
          );
          return null;
        }
        return {
          command: normalized,
          description: command.description,
        };
      })
      .filter((cmd): cmd is { command: string; description: string } => cmd !== null),
    ...(nativeEnabled ? pluginCatalog.commands : []),
    ...customCommands,
  ];
  const {
    commandsToRegister,
    totalCommands,
    maxCommands,
    overflowCount,
    maxTotalChars,
    descriptionTrimmed,
    textBudgetDropCount,
  } = buildCappedTelegramMenuCommands({
    allCommands: allCommandsFull,
  });
  if (overflowCount > 0) {
    runtime.log?.(
      `Telegram limits bots to ${maxCommands} commands. ` +
        `${totalCommands} configured; registering first ${maxCommands}. ` +
        `Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.`,
    );
  }
  if (descriptionTrimmed) {
    runtime.log?.(
      `Telegram menu text exceeded the conservative ${maxTotalChars}-character payload budget; shortening descriptions to keep ${commandsToRegister.length} commands visible.`,
    );
  }
  if (textBudgetDropCount > 0) {
    runtime.log?.(
      `Telegram menu text still exceeded the conservative ${maxTotalChars}-character payload budget after shortening descriptions; registering first ${commandsToRegister.length} commands.`,
    );
  }
  const syncTelegramMenuCommands =
    telegramDeps.syncTelegramMenuCommands ?? syncTelegramMenuCommandsRuntime;
  // Telegram only limits the setMyCommands payload (menu entries).
  // Keep hidden commands callable by registering handlers for the full catalog.
  syncTelegramMenuCommands({
    bot,
    runtime,
    commandsToRegister,
    accountId,
    botIdentity: opts.token,
  });

  const resolveCommandRuntimeContext = async (params: {
    msg: NonNullable<TelegramNativeCommandContext["message"]>;
    runtimeCfg: OpenClawConfig;
    isGroup: boolean;
    isForum: boolean;
    resolvedThreadId?: number;
    senderId?: string;
    topicAgentId?: string;
  }): Promise<{
    chatId: number;
    threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
    route: ReturnType<typeof resolveTelegramConversationRoute>["route"];
    mediaLocalRoots: readonly string[] | undefined;
    tableMode: ReturnType<typeof resolveMarkdownTableMode>;
    chunkMode: TelegramChunkMode;
  } | null> => {
    const { msg, runtimeCfg, isGroup, isForum, resolvedThreadId, senderId, topicAgentId } = params;
    const chatId = msg.chat.id;
    const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
    const threadSpec = resolveTelegramThreadSpec({
      isGroup,
      isForum,
      messageThreadId: resolvedThreadId ?? messageThreadId,
    });
    let { route, configuredBinding } = resolveTelegramConversationRoute({
      cfg: runtimeCfg,
      accountId,
      chatId,
      isGroup,
      resolvedThreadId,
      replyThreadId: threadSpec.id,
      senderId,
      topicAgentId,
    });
    const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
    if (configuredBinding) {
      const ensured = await nativeCommandRuntime.ensureConfiguredBindingRouteReady({
        cfg: runtimeCfg,
        bindingResolution: configuredBinding,
      });
      if (!ensured.ok) {
        logVerbose(
          `telegram native command: configured ACP binding unavailable for topic ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`,
        );
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              chatId,
              "Configured ACP binding is unavailable right now. Please try again.",
              buildTelegramThreadParams(threadSpec) ?? {},
            ),
        });
        return null;
      }
    }
    const mediaLocalRoots = nativeCommandRuntime.getAgentScopedMediaLocalRoots(
      runtimeCfg,
      route.agentId,
    );
    const tableMode = resolveMarkdownTableMode({
      cfg: runtimeCfg,
      channel: "telegram",
      accountId: route.accountId,
    });
    const chunkMode = nativeCommandRuntime.resolveChunkMode(
      runtimeCfg,
      "telegram",
      route.accountId,
    );
    return { chatId, threadSpec, route, mediaLocalRoots, tableMode, chunkMode };
  };
  const buildCommandDeliveryBaseOptions = (params: {
    cfg: OpenClawConfig;
    chatId: string | number;
    accountId: string;
    sessionKeyForInternalHooks?: string;
    policySessionKey?: string;
    mirrorIsGroup?: boolean;
    mirrorGroupId?: string;
    mediaLocalRoots?: readonly string[];
    threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
    tableMode: ReturnType<typeof resolveMarkdownTableMode>;
    chunkMode: TelegramChunkMode;
    linkPreview?: boolean;
  }) => ({
    cfg: params.cfg,
    chatId: String(params.chatId),
    accountId: params.accountId,
    sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
    policySessionKey: params.policySessionKey,
    mirrorIsGroup: params.mirrorIsGroup,
    mirrorGroupId: params.mirrorGroupId,
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots: params.mediaLocalRoots,
    replyToMode,
    textLimit,
    thread: params.threadSpec,
    tableMode: params.tableMode,
    chunkMode: params.chunkMode,
    linkPreview: params.linkPreview,
  });

  const resolveTraceCommandContext = async (ctx: TelegramNativeCommandContext) => {
    const msg = ctx.message;
    if (!msg) {
      return null;
    }
    if (shouldSkipUpdate(ctx)) {
      return null;
    }

    const runtimeCfg = loadFreshRuntimeConfig();
    const runtimeTelegramCfg = resolveFreshTelegramConfig(runtimeCfg);
    const auth = await resolveTelegramCommandAuth({
      msg,
      bot,
      cfg: runtimeCfg,
      accountId,
      telegramCfg: runtimeTelegramCfg,
      readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
      allowFrom,
      groupAllowFrom,
      useAccessGroups,
      resolveGroupPolicy,
      resolveTelegramGroupConfig,
      requireAuth: true,
    });
    if (!auth) {
      return null;
    }
    const threadContext = await resolveTelegramNativeCommandThreadContext({ msg, bot });
    return { auth, threadParams: threadContext.threadParams ?? {} };
  };

  const sendTraceCommandText = async (
    auth: TelegramCommandAuthResult,
    threadParams: Record<string, unknown>,
    text: string,
  ) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () => bot.api.sendMessage(auth.chatId, text, threadParams),
    });
  };

  const registerClawMobileTraceCommands = () => {
    bot.command(CLAWMOBILE_TRACE_LIST_COMMAND, async (ctx: TelegramNativeCommandContext) => {
      const resolved = await resolveTraceCommandContext(ctx);
      if (!resolved) {
        return;
      }
      const listed = await listClawMobileTracesForTelegram(CLAWMOBILE_TRACE_LIST_LIMIT);
      await sendTraceCommandText(resolved.auth, resolved.threadParams, listed.text);
    });

    bot.command(CLAWMOBILE_TRACE_CLEAR_COMMAND, async (ctx: TelegramNativeCommandContext) => {
      const resolved = await resolveTraceCommandContext(ctx);
      if (!resolved) {
        return;
      }
      const cleared = await clearClawMobileTracesForTelegram();
      await sendTraceCommandText(resolved.auth, resolved.threadParams, cleared.text);
    });

    bot.command(CLAWMOBILE_TRACE_COMMAND, async (ctx: TelegramNativeCommandContext) => {
      const rawText = normalizeOptionalString(ctx.match) ?? "";
      const index = rawText ? Number.parseInt(rawText, 10) : undefined;
      const hasInvalidArgs = rawText.length > 0 && !/^\d+$/.test(rawText);
      const resolved = await resolveTraceCommandContext(ctx);
      if (!resolved) {
        return;
      }
      if (hasInvalidArgs) {
        await sendTraceCommandText(
          resolved.auth,
          resolved.threadParams,
          "Use /clawmobile_trace or /clawmobile_trace <number>.",
        );
        return;
      }

      const exported = await exportSelectedClawMobileTraceSnapshotForTelegram(
        index !== undefined ? { index, label: `trace-${index}` } : undefined,
      );
      if (!exported.ok) {
        const text = exported.text ?? `ClawMobile trace file was not found yet: ${exported.path}`;
        await sendTraceCommandText(resolved.auth, resolved.threadParams, text);
        return;
      }

      const file = new InputFile(exported.path, path.basename(exported.path));
      await withTelegramApiErrorLogging({
        operation: "sendDocument",
        runtime,
        fn: () =>
          bot.api.sendDocument(resolved.auth.chatId, file, {
            caption: `ClawMobile trace: ${exported.label}`,
            ...resolved.threadParams,
          }),
      });
    });
  };

  if (commandsToRegister.length > 0 || pluginCatalog.commands.length > 0) {
    for (const command of nativeCommands) {
      const normalizedCommandName = normalizeTelegramCommandName(command.name);
      if (CLAWMOBILE_TRACE_NATIVE_COMMANDS.has(normalizedCommandName)) {
        continue;
      }
      bot.command(normalizedCommandName, async (ctx: TelegramNativeCommandContext) => {
        const msg = ctx.message;
        if (!msg) {
          return;
        }
        if (shouldSkipUpdate(ctx)) {
          return;
        }
        const runtimeCfg = loadFreshRuntimeConfig();
        const runtimeTelegramCfg = resolveFreshTelegramConfig(runtimeCfg);
        const auth = await resolveTelegramCommandAuth({
          msg,
          bot,
          cfg: runtimeCfg,
          accountId,
          telegramCfg: runtimeTelegramCfg,
          readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
          allowFrom,
          groupAllowFrom,
          useAccessGroups,
          resolveGroupPolicy,
          resolveTelegramGroupConfig,
          requireAuth: true,
        });
        if (!auth) {
          return;
        }
        const {
          chatId,
          isGroup,
          isForum,
          resolvedThreadId,
          senderId,
          senderUsername,
          groupConfig,
          topicConfig,
          commandAuthorized,
        } = auth;
        const runtimeContext = await resolveCommandRuntimeContext({
          msg,
          runtimeCfg,
          isGroup,
          isForum,
          resolvedThreadId,
          senderId,
          topicAgentId: topicConfig?.agentId,
        });
        if (!runtimeContext) {
          return;
        }
        const { threadSpec, route, mediaLocalRoots, tableMode, chunkMode } = runtimeContext;
        const threadParams = buildTelegramThreadParams(threadSpec) ?? {};
        const originatingTo = buildTelegramRoutingTarget(chatId, threadSpec);
        const executionCfg = getRuntimeConfigSnapshot() ?? cfg;

        const commandDefinition = findCommandByNativeName(command.name, "telegram");
        const rawText = ctx.match?.trim() ?? "";
        const commandArgs = commandDefinition
          ? parseCommandArgs(commandDefinition, rawText)
          : rawText
            ? ({ raw: rawText } satisfies CommandArgs)
            : undefined;
        const prompt = commandDefinition
          ? buildCommandTextFromArgs(commandDefinition, commandArgs)
          : rawText
            ? `/${command.name} ${rawText}`
            : `/${command.name}`;
        let cachedTargetSessionKey: string | undefined;
        let cachedNativeCommandRuntime:
          | Awaited<ReturnType<typeof loadTelegramNativeCommandRuntime>>
          | undefined;
        const resolveNativeCommandRuntime = async () => {
          cachedNativeCommandRuntime ??= await loadTelegramNativeCommandRuntime();
          return cachedNativeCommandRuntime;
        };
        const resolveTargetSessionKey = async (): Promise<string> => {
          if (cachedTargetSessionKey) {
            return cachedTargetSessionKey;
          }
          const baseSessionKey = resolveTelegramConversationBaseSessionKey({
            cfg: runtimeCfg,
            route,
            chatId,
            isGroup,
            senderId,
          });
          const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
          const directConfig = !isGroup
            ? (groupConfig as TelegramDirectConfig | undefined)
            : undefined;
          const threadKeys =
            shouldUseTelegramDmThreadSession({
              dmThreadId,
              accountConfig: runtimeTelegramCfg,
              directConfig,
              topicConfig,
            }) && dmThreadId != null
              ? (await resolveNativeCommandRuntime()).resolveThreadSessionKeys({
                  baseSessionKey,
                  threadId: `${chatId}:${dmThreadId}`,
                })
              : null;
          cachedTargetSessionKey = threadKeys?.sessionKey ?? baseSessionKey;
          return cachedTargetSessionKey;
        };
        const menuNeedsModelContext =
          commandDefinition?.argsMenu &&
          !(commandArgs?.raw && !commandArgs.values) &&
          commandDefinition.args?.some(
            (arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null,
          );
        const menuModelContext =
          commandDefinition && menuNeedsModelContext
            ? resolveTelegramCommandMenuModelContext({
                cfg: runtimeCfg,
                agentId: route.agentId,
                sessionKey: await resolveTargetSessionKey(),
              })
            : {};
        const menu = commandDefinition
          ? resolveCommandArgMenu({
              command: commandDefinition,
              args: commandArgs,
              cfg: runtimeCfg,
              ...menuModelContext,
            })
          : null;
        if (menu && commandDefinition) {
          const title = formatCommandArgMenuTitle({ command: commandDefinition, menu });
          const rows: Array<Array<{ text: string; callback_data: string }>> = [];
          for (let i = 0; i < menu.choices.length; i += 2) {
            const slice = menu.choices.slice(i, i + 2);
            rows.push(
              slice.map((choice) => {
                const args: CommandArgs = {
                  values: { [menu.arg.name]: choice.value },
                };
                return {
                  text: choice.label,
                  callback_data: buildTelegramNativeCommandCallbackData(
                    buildCommandTextFromArgs(commandDefinition, args),
                  ),
                };
              }),
            );
          }
          const replyMarkup = buildInlineKeyboard(rows);
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, title, {
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                ...threadParams,
              }),
          });
          return;
        }
        const nativeCommandRuntime = await resolveNativeCommandRuntime();
        const sessionKey = await resolveTargetSessionKey();
        const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
          groupConfig,
          topicConfig,
        });
        const { sessionKey: commandSessionKey, commandTargetSessionKey } =
          resolveNativeCommandSessionTargets({
            agentId: route.agentId,
            sessionPrefix: "telegram:slash",
            userId: String(senderId || chatId),
            targetSessionKey: sessionKey,
          });
        const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
          cfg: executionCfg,
          chatId,
          accountId: route.accountId,
          sessionKeyForInternalHooks: commandSessionKey,
          policySessionKey: commandTargetSessionKey,
          mirrorIsGroup: isGroup,
          mirrorGroupId: isGroup ? String(chatId) : undefined,
          mediaLocalRoots,
          threadSpec,
          tableMode,
          chunkMode,
          linkPreview: runtimeTelegramCfg.linkPreview,
        });
        const conversationLabel = isGroup
          ? msg.chat.title
            ? `${msg.chat.title} id:${chatId}`
            : `group:${chatId}`
          : (buildSenderName(msg) ?? String(senderId || chatId));
        const ctxPayload = nativeCommandRuntime.finalizeInboundContext({
          Body: prompt,
          BodyForAgent: prompt,
          RawBody: prompt,
          CommandBody: prompt,
          CommandArgs: commandArgs,
          From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
          To: `slash:${senderId || chatId}`,
          ChatType: isGroup ? "group" : "direct",
          ConversationLabel: conversationLabel,
          GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
          GroupSystemPrompt: isGroup || (!isGroup && groupConfig) ? groupSystemPrompt : undefined,
          SenderName: buildSenderName(msg),
          SenderId: senderId || undefined,
          SenderUsername: senderUsername || undefined,
          Surface: "telegram",
          Provider: "telegram",
          MessageSid: String(msg.message_id),
          Timestamp: msg.date ? msg.date * 1000 : undefined,
          WasMentioned: true,
          CommandAuthorized: commandAuthorized,
          CommandSource: "native" as const,
          SessionKey: commandSessionKey,
          AccountId: route.accountId,
          CommandTargetSessionKey: commandTargetSessionKey,
          MessageThreadId: threadSpec.id,
          IsForum: isForum,
          // Originating context for sub-agent announce routing
          OriginatingChannel: "telegram" as const,
          OriginatingTo: originatingTo,
        });
        await nativeCommandRuntime.recordInboundSessionMetaSafe({
          cfg: executionCfg,
          agentId: route.agentId,
          sessionKey: commandTargetSessionKey,
          ctx: ctxPayload,
          onError: (err) =>
            runtime.error?.(danger(`telegram slash: failed updating session meta: ${String(err)}`)),
        });

        const disableBlockStreaming =
          resolveTelegramNativeCommandDisableBlockStreaming(runtimeTelegramCfg);
        const deliveryState = {
          delivered: false,
          skippedNonSilent: 0,
        };

        const { createChannelReplyPipeline, deliverReplies } =
          await loadTelegramNativeCommandDeliveryRuntime();
        const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
          cfg: executionCfg,
          agentId: route.agentId,
          channel: "telegram",
          accountId: route.accountId,
        });

        await telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: executionCfg,
          dispatcherOptions: {
            ...replyPipeline,
            beforeDeliver: async (payload) => payload,
            deliver: async (payload, _info) => {
              if (
                shouldSuppressLocalTelegramExecApprovalPrompt({
                  cfg: executionCfg,
                  accountId: route.accountId,
                  payload,
                })
              ) {
                deliveryState.delivered = true;
                return;
              }
              const result = await deliverReplies({
                replies: [
                  payload.replyToId
                    ? payload
                    : {
                        ...payload,
                        replyToId: String(msg.message_id),
                      },
                ],
                ...deliveryBaseOptions,
                silent: runtimeTelegramCfg.silentErrorReplies === true && payload.isError === true,
              });
              if (result.delivered) {
                deliveryState.delivered = true;
              }
            },
            onSkip: (_payload, info) => {
              if (info.reason !== "silent") {
                deliveryState.skippedNonSilent += 1;
              }
            },
            onError: (err, info) => {
              runtime.error?.(danger(`telegram slash ${info.kind} reply failed: ${String(err)}`));
            },
          },
          replyOptions: {
            skillFilter,
            disableBlockStreaming,
            onModelSelected,
          },
        });
        if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
          await deliverReplies({
            replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
            ...deliveryBaseOptions,
          });
        }
      });
    }

    for (const pluginCommand of pluginCatalog.commands) {
      bot.command(pluginCommand.command, async (ctx: TelegramNativeCommandContext) => {
        const msg = ctx.message;
        if (!msg) {
          return;
        }
        if (shouldSkipUpdate(ctx)) {
          return;
        }
        const chatId = msg.chat.id;
        const runtimeCfg = loadFreshRuntimeConfig();
        const runtimeTelegramCfg = resolveFreshTelegramConfig(runtimeCfg);
        const { threadParams } = await resolveTelegramNativeCommandThreadContext({ msg, bot });
        const rawText = ctx.match?.trim() ?? "";
        const commandBody = `/${pluginCommand.command}${rawText ? ` ${rawText}` : ""}`;
        const nativeCommandRuntime = await loadTelegramNativeCommandRuntime();
        const match = nativeCommandRuntime.matchPluginCommand(commandBody);
        if (!match) {
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () => bot.api.sendMessage(chatId, "Command not found.", threadParams ?? {}),
          });
          return;
        }
        const auth = await resolveTelegramCommandAuth({
          msg,
          bot,
          cfg: runtimeCfg,
          accountId,
          telegramCfg: runtimeTelegramCfg,
          readChannelAllowFromStore: telegramDeps.readChannelAllowFromStore,
          allowFrom,
          groupAllowFrom,
          useAccessGroups,
          resolveGroupPolicy,
          resolveTelegramGroupConfig,
          requireAuth: match.command.requireAuth !== false,
        });
        if (!auth) {
          return;
        }
        const { senderId, commandAuthorized, senderIsOwner, isGroup, isForum, resolvedThreadId } =
          auth;
        const runtimeContext = await resolveCommandRuntimeContext({
          msg,
          runtimeCfg,
          isGroup,
          isForum,
          resolvedThreadId,
          senderId,
          topicAgentId: auth.topicConfig?.agentId,
        });
        if (!runtimeContext) {
          return;
        }
        const { threadSpec, route, mediaLocalRoots, tableMode, chunkMode } = runtimeContext;
        const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
          cfg: runtimeCfg,
          chatId,
          accountId: route.accountId,
          sessionKeyForInternalHooks: route.sessionKey,
          policySessionKey: route.sessionKey,
          mirrorIsGroup: isGroup,
          mirrorGroupId: isGroup ? String(chatId) : undefined,
          mediaLocalRoots,
          threadSpec,
          tableMode,
          chunkMode,
          linkPreview: runtimeTelegramCfg.linkPreview,
        });
        const from = isGroup ? buildTelegramGroupFrom(chatId, threadSpec.id) : `telegram:${chatId}`;
        const to = `telegram:${chatId}`;
        const { deliverReplies, emitTelegramMessageSentHooks } =
          await loadTelegramNativeCommandDeliveryRuntime();
        let progressMessageId: number | undefined;
        const progressPlaceholder = resolveTelegramProgressPlaceholder(match.command);

        if (progressPlaceholder) {
          try {
            const sent = await withTelegramApiErrorLogging({
              operation: "sendMessage",
              runtime,
              fn: () =>
                bot.api.sendMessage(
                  chatId,
                  progressPlaceholder,
                  buildTelegramThreadParams(threadSpec),
                ),
            });
            const maybeMessageId = (sent as { message_id?: unknown } | undefined)?.message_id;
            if (typeof maybeMessageId === "number") {
              progressMessageId = maybeMessageId;
            }
          } catch {
            // Fall back to the normal final reply path if the placeholder send fails.
          }
        }

        const sessionFileContext = await resolveTelegramCommandSessionFile({
          cfg: runtimeCfg,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          threadId: threadSpec.id,
        });

        const result = normalizeTelegramNativeReplyPayload(
          await nativeCommandRuntime.executePluginCommand({
            command: match.command,
            args: match.args,
            senderId,
            channel: "telegram",
            isAuthorizedSender: commandAuthorized,
            senderIsOwner,
            sessionKey: route.sessionKey,
            sessionId: sessionFileContext.sessionId,
            sessionFile: sessionFileContext.sessionFile,
            commandBody,
            config: runtimeCfg,
            from,
            to,
            accountId,
            messageThreadId: threadSpec.id,
          }),
        );

        if (
          shouldSuppressLocalTelegramExecApprovalPrompt({
            cfg: runtimeCfg,
            accountId: route.accountId,
            payload: result,
          })
        ) {
          await cleanupTelegramProgressPlaceholder({
            bot,
            chatId,
            progressMessageId,
            runtime,
          });
          return;
        }

        const deliverableResult = hasRenderableTelegramNativeReplyPayload(result)
          ? result
          : { text: EMPTY_RESPONSE_FALLBACK };
        const progressResultText =
          typeof deliverableResult.text === "string" && deliverableResult.text.trim().length > 0
            ? deliverableResult.text
            : null;
        const telegramResultData = resolveTelegramNativeReplyChannelData(deliverableResult);
        if (
          progressMessageId != null &&
          telegramDeps.editMessageTelegram &&
          progressResultText &&
          isEditableTelegramProgressResult(deliverableResult)
        ) {
          try {
            await telegramDeps.editMessageTelegram(chatId, progressMessageId, progressResultText, {
              cfg: runtimeCfg,
              accountId: route.accountId,
              textMode: "markdown",
              linkPreview: runtimeTelegramCfg.linkPreview,
              buttons: telegramResultData?.buttons,
            });
            recordSentMessage(chatId, progressMessageId, runtimeCfg);
            emitTelegramMessageSentHooks({
              sessionKeyForInternalHooks: route.sessionKey,
              chatId: String(chatId),
              accountId: route.accountId,
              content: progressResultText,
              success: true,
              messageId: progressMessageId,
              isGroup,
              groupId: isGroup ? String(chatId) : undefined,
            });
            return;
          } catch {
            // Fall through to cleanup + normal delivered reply if editing fails.
          }
        }
        await cleanupTelegramProgressPlaceholder({
          bot,
          chatId,
          progressMessageId,
          runtime,
        });
        await deliverReplies({
          replies: [deliverableResult],
          ...deliveryBaseOptions,
          silent:
            runtimeTelegramCfg.silentErrorReplies === true && deliverableResult.isError === true,
        });
      });
    }
  } else if (nativeDisabledExplicit) {
    withTelegramApiErrorLogging({
      operation: "setMyCommands",
      runtime,
      fn: () => bot.api.setMyCommands([]),
    }).catch(() => {});
    withTelegramApiErrorLogging({
      operation: "setMyCommands(all_group_chats)",
      runtime,
      fn: () => bot.api.setMyCommands([], { scope: { type: "all_group_chats" } }),
    }).catch(() => {});
  }

  registerClawMobileTraceCommands();
};
