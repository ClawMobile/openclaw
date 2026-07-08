import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  ClawBenchChannelAccountConfig,
  CoreConfig,
  ResolvedClawBenchChannelAccount,
} from "./types.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8765;

const {
  listAccountIds: listClawBenchChannelAccountIds,
  resolveDefaultAccountId: resolveDefaultClawBenchChannelAccountId,
} = createAccountListHelpers("clawbench", { normalizeAccountId });

export { listClawBenchChannelAccountIds, resolveDefaultClawBenchChannelAccountId };

function resolveMergedClawBenchAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): ClawBenchChannelAccountConfig {
  return resolveMergedAccountConfig<ClawBenchChannelAccountConfig>({
    channelConfig: cfg.channels?.clawbench as ClawBenchChannelAccountConfig | undefined,
    accounts: cfg.channels?.clawbench?.accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

export function resolveClawBenchChannelAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedClawBenchChannelAccount {
  const accountId = normalizeAccountId(params.accountId);
  const section = params.cfg.channels?.clawbench;
  const merged = resolveMergedClawBenchAccountConfig(params.cfg, accountId);
  const baseEnabled = section?.enabled === true;
  const enabled = baseEnabled && merged.enabled !== false;
  const host = merged.host?.trim() || DEFAULT_HOST;
  const port = merged.port ?? DEFAULT_PORT;
  return {
    accountId,
    enabled,
    configured: Boolean(section) && enabled,
    name: normalizeOptionalString(merged.name),
    host,
    port,
    token: normalizeOptionalString(merged.token),
    baseUrl: `http://${host}:${port}`,
    config: {
      ...merged,
      allowFrom: merged.allowFrom ?? ["*"],
      defaultTo: merged.defaultTo ?? "run:default",
    },
  };
}

export { DEFAULT_ACCOUNT_ID };
export type { ResolvedClawBenchChannelAccount } from "./types.js";
