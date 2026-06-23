import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  listClawBenchChannelAccountIds,
  resolveClawBenchChannelAccount,
  resolveDefaultClawBenchChannelAccountId,
  type ResolvedClawBenchChannelAccount,
} from "./accounts.js";
import { clawBenchChannelPluginConfigSchema } from "./config-schema.js";
import { applyClawBenchSetup } from "./setup.js";
import type { CoreConfig } from "./types.js";

const CHANNEL_ID = "clawbench" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

export const clawBenchChannelSetupPlugin: ChannelPlugin<ResolvedClawBenchChannelAccount> = {
  id: CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct"],
  },
  reload: { configPrefixes: ["channels.clawbench"] },
  configSchema: clawBenchChannelPluginConfigSchema,
  setup: {
    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyClawBenchSetup({
        cfg,
        accountId,
        input: input as Record<string, unknown>,
      }),
  },
  config: {
    listAccountIds: (cfg) => listClawBenchChannelAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveClawBenchChannelAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultClawBenchChannelAccountId(cfg as CoreConfig),
    isConfigured: (account) => account.configured,
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveClawBenchChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom,
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveClawBenchChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo,
  },
};
