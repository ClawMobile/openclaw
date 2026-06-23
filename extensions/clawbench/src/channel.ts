import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  DEFAULT_ACCOUNT_ID,
  listClawBenchChannelAccountIds,
  resolveClawBenchChannelAccount,
  resolveDefaultClawBenchChannelAccountId,
} from "./accounts.js";
import { clawBenchChannelPluginConfigSchema } from "./config-schema.js";
import { startClawBenchGatewayAccount } from "./gateway.js";
import { sendClawBenchChannelText } from "./outbound.js";
import { applyClawBenchSetup } from "./setup.js";
import { clawBenchChannelStatus } from "./status.js";
import { buildClawBenchTarget, parseClawBenchTarget } from "./target.js";
import type { CoreConfig, ResolvedClawBenchChannelAccount } from "./types.js";

const CHANNEL_ID = "clawbench" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

export const clawBenchChannelPlugin = createChatChannelPlugin<ResolvedClawBenchChannelAccount>({
  base: {
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
    messaging: {
      normalizeTarget: (raw) => buildClawBenchTarget(parseClawBenchTarget(raw)),
      parseExplicitTarget: ({ raw }) => ({
        to: buildClawBenchTarget(parseClawBenchTarget(raw)),
        chatType: "direct",
      }),
      inferTargetChatType: () => "direct",
      targetResolver: {
        looksLikeId: (raw) => raw.trim().length > 0,
        hint: "<run:run_id>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const normalizedTarget = buildClawBenchTarget(parseClawBenchTarget(target));
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
          from: `clawbench:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: normalizedTarget,
        });
      },
      resolveSessionConversation: () => null,
    },
    status: clawBenchChannelStatus,
    gateway: {
      startAccount: async (ctx) => {
        await startClawBenchGatewayAccount(CHANNEL_ID, meta.label, ctx);
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
        await sendClawBenchChannelText({
          cfg: cfg as CoreConfig,
          accountId,
          to,
          text,
        }),
    },
  },
});
