import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  presentationToInteractiveReply,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/outbound-send-deps";
import {
  getReplyPayloadMetadata,
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { markdownToTelegramHtmlChunks } from "./format.js";
import { resolveTelegramInteractiveTextFallback } from "./interactive-fallback.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import { pinMessageTelegram } from "./send.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;
const replyRouteLogger = createSubsystemLogger("telegram/reply-route");

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];

function normalizeTimingStartedAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function formatElapsedTelegramText(text: string, startedAtMs: number | undefined): string {
  if (!startedAtMs || !text.trim() || /^\[Time: \d+(?:\.\d+)? s\]/u.test(text.trimStart())) {
    return text;
  }
  const seconds = Math.max(0, Date.now() - startedAtMs) / 1000;
  return `[Time: ${seconds.toFixed(2)} s]\n\n${text}`;
}

function resolvePayloadTimingStartedAt(payload: ReplyPayload): number | undefined {
  return normalizeTimingStartedAt(getReplyPayloadMetadata(payload)?.sourceRunStartedAtMs);
}

function hasElapsedTimePrefix(text: string): boolean {
  return /^\[Time: \d+(?:\.\d+)? s\]/u.test(text.trimStart());
}

let telegramSendModulePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendModule() {
  telegramSendModulePromise ??= import("./send.js");
  return await telegramSendModulePromise;
}

async function resolveTelegramSendContext(params: {
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  gatewayClientScopes?: readonly string[];
}): Promise<{
  send: TelegramSendFn;
  baseOpts: {
    cfg: NonNullable<TelegramSendOpts>["cfg"];
    verbose: false;
    textMode: "html";
    messageThreadId?: number;
    replyToMessageId?: number;
    accountId?: string;
    gatewayClientScopes?: readonly string[];
  };
}> {
  const send =
    resolveOutboundSendDep<TelegramSendFn>(params.deps, "telegram") ??
    (await loadTelegramSendModule()).sendMessageTelegram;
  return {
    send,
    baseOpts: {
      verbose: false,
      textMode: "html",
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      accountId: params.accountId ?? undefined,
      gatewayClientScopes: params.gatewayClientScopes,
    },
  };
}

export async function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
  sourceRunStartedAtMs?: number;
}): Promise<Awaited<ReturnType<TelegramSendFn>>> {
  const telegramData = params.payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons; quoteText?: string }
    | undefined;
  const quoteText =
    typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
  const text =
    resolveTelegramInteractiveTextFallback({
      text: params.payload.text,
      interactive: params.payload.interactive,
    }) ?? "";
  const textWithTiming = formatElapsedTelegramText(
    text,
    params.sourceRunStartedAtMs ?? resolvePayloadTimingStartedAt(params.payload),
  );
  const mediaUrls = resolvePayloadMediaUrls(params.payload);
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    interactive: params.payload.interactive,
  });
  const payloadOpts = {
    ...params.baseOpts,
    quoteText,
    ...(params.payload.audioAsVoice === true ? { asVoice: true } : {}),
  };
  replyRouteLogger.info("outbound-adapter.sendTelegramPayloadMessages", {
    to: params.to,
    accountId: params.baseOpts.accountId,
    threadId: params.baseOpts.messageThreadId,
    textLength: text.length,
    mediaCount: mediaUrls.length,
    hasSourceTiming:
      params.sourceRunStartedAtMs !== undefined ||
      resolvePayloadTimingStartedAt(params.payload) !== undefined,
    addsTimePrefix: !hasElapsedTimePrefix(text) && hasElapsedTimePrefix(textWithTiming),
    payloadIsError: params.payload.isError === true,
    payloadIsReasoning: params.payload.isReasoning === true,
  });

  // Telegram allows reply_markup on media; attach buttons only to the first send.
  return await sendPayloadMediaSequenceOrFallback({
    text,
    mediaUrls,
    fallbackResult: { messageId: "unknown", chatId: params.to },
    sendNoMedia: async () =>
      await params.send(params.to, textWithTiming, {
        ...payloadOpts,
        buttons,
      }),
    send: async ({ text, mediaUrl, isFirst }) =>
      await params.send(params.to, isFirst ? textWithTiming : text, {
        ...payloadOpts,
        mediaUrl,
        ...(isFirst ? { buttons } : {}),
      }),
  });
}

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  extractMarkdownImages: true,
  textChunkLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
  sanitizeText: ({ text }) => sanitizeForPlainText(text),
  shouldSkipPlainTextSanitization: ({ payload }) => Boolean(payload.channelData),
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: true,
    context: true,
    divider: false,
  },
  deliveryCapabilities: {
    pin: true,
  },
  renderPresentation: ({ payload, presentation }) => ({
    ...payload,
    text: renderMessagePresentationFallbackText({ text: payload.text, presentation }),
    interactive: presentationToInteractiveReply(presentation),
  }),
  pinDeliveredMessage: async ({ cfg, target, messageId, pin }) => {
    await pinMessageTelegram(target.to, messageId, {
      cfg,
      accountId: target.accountId ?? undefined,
      notify: pin.notify,
      verbose: false,
    });
  },
  resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
    typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
  ...createAttachedChannelResultAdapter({
    channel: "telegram",
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      deps,
      replyToId,
      threadId,
      gatewayClientScopes,
      sourceRunStartedAtMs,
    }) => {
      const { send, baseOpts } = await resolveTelegramSendContext({
        cfg,
        deps,
        accountId,
        replyToId,
        threadId,
        gatewayClientScopes,
      });
      replyRouteLogger.info("outbound-adapter.sendText", {
        to,
        accountId,
        threadId,
        textLength: text.length,
        hasSourceTiming: sourceRunStartedAtMs !== undefined,
      });
      return await send(to, formatElapsedTelegramText(text, sourceRunStartedAtMs), {
        ...baseOpts,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
      forceDocument,
      gatewayClientScopes,
      sourceRunStartedAtMs,
    }) => {
      const { send, baseOpts } = await resolveTelegramSendContext({
        cfg,
        deps,
        accountId,
        replyToId,
        threadId,
        gatewayClientScopes,
      });
      replyRouteLogger.info("outbound-adapter.sendMedia", {
        to,
        accountId,
        threadId,
        textLength: text.length,
        mediaUrl: Boolean(mediaUrl),
        hasSourceTiming: sourceRunStartedAtMs !== undefined,
      });
      return await send(to, formatElapsedTelegramText(text, sourceRunStartedAtMs), {
        ...baseOpts,
        mediaUrl,
        mediaLocalRoots,
        mediaReadFile,
        forceDocument: forceDocument ?? false,
      });
    },
  }),
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
    replyToId,
    threadId,
    forceDocument,
    gatewayClientScopes,
    sourceRunStartedAtMs,
  }) => {
    const { send, baseOpts } = await resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
      gatewayClientScopes,
    });
    replyRouteLogger.info("outbound-adapter.sendPayload", {
      to,
      accountId,
      threadId,
      textLength: payload.text?.length ?? 0,
      hasSourceTiming: sourceRunStartedAtMs !== undefined,
    });
    const result = await sendTelegramPayloadMessages({
      send,
      to,
      payload,
      sourceRunStartedAtMs,
      baseOpts: {
        ...baseOpts,
        mediaLocalRoots,
        mediaReadFile,
        forceDocument: forceDocument ?? false,
      },
    });
    return attachChannelToResult("telegram", result);
  },
};
