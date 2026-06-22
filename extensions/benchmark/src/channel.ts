import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  DEFAULT_ACCOUNT_ID,
  listBenchmarkChannelAccountIds,
  resolveBenchmarkChannelAccount,
  resolveDefaultBenchmarkChannelAccountId,
} from "./accounts.js";
import { benchmarkChannelPluginConfigSchema } from "./config-schema.js";
import { startBenchmarkGatewayAccount } from "./gateway.js";
import { sendBenchmarkChannelText } from "./outbound.js";
import { applyBenchmarkSetup } from "./setup.js";
import { benchmarkChannelStatus } from "./status.js";
import { buildBenchmarkTarget, parseBenchmarkTarget } from "./target.js";
import type { CoreConfig, ResolvedBenchmarkChannelAccount } from "./types.js";

const CHANNEL_ID = "benchmark" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

export const benchmarkChannelPlugin = createChatChannelPlugin<ResolvedBenchmarkChannelAccount>({
  base: {
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
    messaging: {
      normalizeTarget: (raw) => buildBenchmarkTarget(parseBenchmarkTarget(raw)),
      parseExplicitTarget: ({ raw }) => ({
        to: buildBenchmarkTarget(parseBenchmarkTarget(raw)),
        chatType: "direct",
      }),
      inferTargetChatType: () => "direct",
      targetResolver: {
        looksLikeId: (raw) => raw.trim().length > 0,
        hint: "<run:run_id>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const normalizedTarget = buildBenchmarkTarget(parseBenchmarkTarget(target));
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: CHANNEL_ID,
          accountId,
          peer: {
            kind: "direct",
            id: normalizedTarget,
          },
          chatType: "direct",
          from: `benchmark:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: normalizedTarget,
        });
      },
      resolveSessionConversation: () => null,
    },
    status: benchmarkChannelStatus,
    gateway: {
      startAccount: async (ctx) => {
        await startBenchmarkGatewayAccount(CHANNEL_ID, meta.label, ctx);
      },
    },
  },
  outbound: {
    base: {
      deliveryMode: "direct",
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId }) =>
        await sendBenchmarkChannelText({
          cfg: cfg as CoreConfig,
          accountId,
          to,
          text,
        }),
    },
  },
});
