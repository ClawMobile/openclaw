import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { startClawBenchHttpServer } from "./http-server.js";
import type { CoreConfig, ResolvedClawBenchChannelAccount } from "./types.js";

export async function startClawBenchGatewayAccount(
  channelId: string,
  channelLabel: string,
  ctx: ChannelGatewayContext<ResolvedClawBenchChannelAccount>,
): Promise<void> {
  const account = ctx.account;
  if (!account.configured) {
    throw new Error(`ClawBench channel is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  try {
    await startClawBenchHttpServer({
      channelId,
      channelLabel,
      account,
      config: ctx.cfg as CoreConfig,
      signal: ctx.abortSignal,
      log: ctx.log,
    });
  } finally {
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
    });
  }
}
