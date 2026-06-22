import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  listBenchmarkChannelAccountIds,
  resolveBenchmarkChannelAccount,
  resolveDefaultBenchmarkChannelAccountId,
  type ResolvedBenchmarkChannelAccount,
} from "./accounts.js";
import { benchmarkChannelPluginConfigSchema } from "./config-schema.js";
import { applyBenchmarkSetup } from "./setup.js";
import type { CoreConfig } from "./types.js";

const CHANNEL_ID = "benchmark" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

export const benchmarkChannelSetupPlugin: ChannelPlugin<ResolvedBenchmarkChannelAccount> = {
  id: CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct"],
  },
  reload: { configPrefixes: ["channels.benchmark"] },
  configSchema: benchmarkChannelPluginConfigSchema,
  setup: {
    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyBenchmarkSetup({
        cfg,
        accountId,
        input: input as Record<string, unknown>,
      }),
  },
  config: {
    listAccountIds: (cfg) => listBenchmarkChannelAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveBenchmarkChannelAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultBenchmarkChannelAccountId(cfg as CoreConfig),
    isConfigured: (account) => account.configured,
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveBenchmarkChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom,
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveBenchmarkChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo,
  },
};
