import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { BenchmarkRunRecord } from "./runs.js";
import { getBenchmarkChannelRuntime } from "./runtime.js";
import { buildBenchmarkTarget } from "./target.js";
import type { CoreConfig, ResolvedBenchmarkChannelAccount } from "./types.js";

export async function handleBenchmarkInbound(params: {
  channelId: string;
  channelLabel: string;
  account: ResolvedBenchmarkChannelAccount;
  config: CoreConfig;
  run: BenchmarkRunRecord;
}): Promise<{ replyText?: string }> {
  const runtime = getBenchmarkChannelRuntime();
  const target = buildBenchmarkTarget({ runId: params.run.runId });
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
    ConversationLabel: `Benchmark ${params.run.runId}`,
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
        : new Error(`benchmark session record failed: ${String(error)}`);
    },
    onDispatchError: (error) => {
      throw error instanceof Error
        ? error
        : new Error(`benchmark dispatch failed: ${String(error)}`);
    },
  });

  return { replyText: replies.join("\n\n") || undefined };
}
