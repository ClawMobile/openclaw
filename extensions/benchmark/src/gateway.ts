import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { startBenchmarkHttpServer } from "./http-server.js";
import type { CoreConfig, ResolvedBenchmarkChannelAccount } from "./types.js";

export async function startBenchmarkGatewayAccount(
  channelId: string,
  channelLabel: string,
  ctx: ChannelGatewayContext<ResolvedBenchmarkChannelAccount>,
): Promise<void> {
  const account = ctx.account;
  if (!account.configured) {
    throw new Error(`Benchmark channel is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  try {
    await startBenchmarkHttpServer({
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
