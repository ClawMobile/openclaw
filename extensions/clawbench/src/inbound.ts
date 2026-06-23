import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { ClawBenchRunRecord } from "./runs.js";
import { getClawBenchChannelRuntime } from "./runtime.js";
import { buildClawBenchTarget } from "./target.js";
import type { CoreConfig, ResolvedClawBenchChannelAccount } from "./types.js";

export async function handleClawBenchInbound(params: {
  channelId: string;
  channelLabel: string;
  account: ResolvedClawBenchChannelAccount;
  config: CoreConfig;
  run: ClawBenchRunRecord;
}): Promise<{ replyText?: string }> {
  const runtime = getClawBenchChannelRuntime();
  const target = buildClawBenchTarget({ runId: params.run.runId });
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    peer: {
      kind: "direct",
      id: target,
    },
  });
  const storePath = runtime.channel.session.resolveStorePath(params.config.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: params.channelLabel,
    from: "ClawBench",
    timestamp: params.run.createdAt,
    previousTimestamp,
    envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(params.config as OpenClawConfig),
    body: params.run.instruction,
  });
  const replies: string[] = [];
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.run.instruction,
    RawBody: params.run.instruction,
    CommandBody: params.run.instruction,
    From: target,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.account.accountId,
    ChatType: "direct",
    ConversationLabel: `ClawBench ${params.run.runId}`,
    SenderName: "ClawBench",
    SenderId: "clawbench",
    Provider: params.channelId,
    Surface: params.channelId,
    MessageSid: params.run.runId,
    MessageSidFull: params.run.runId,
    Timestamp: params.run.createdAt,
    OriginatingChannel: params.channelId,
    OriginatingTo: target,
    CommandAuthorized: true,
  });

  await dispatchInboundReplyWithBase({
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    accountId: params.account.accountId,
    route,
    storePath,
    ctxPayload,
    core: runtime,
    deliver: async (payload) => {
      const text =
        payload && typeof payload === "object" && "text" in payload
          ? ((payload as { text?: string }).text ?? "")
          : "";
      if (text.trim()) {
        replies.push(text);
      }
    },
    onRecordError: (error) => {
      throw error instanceof Error
        ? error
        : new Error(`clawbench session record failed: ${String(error)}`);
    },
    onDispatchError: (error) => {
      throw error instanceof Error
        ? error
        : new Error(`clawbench dispatch failed: ${String(error)}`);
    },
  });

  return { replyText: replies.join("\n\n") || undefined };
}
