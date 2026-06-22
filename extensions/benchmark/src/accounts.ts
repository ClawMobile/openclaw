import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  BenchmarkChannelAccountConfig,
  CoreConfig,
  ResolvedBenchmarkChannelAccount,
} from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;

const {
  listAccountIds: listBenchmarkChannelAccountIds,
  resolveDefaultAccountId: resolveDefaultBenchmarkChannelAccountId,
} = createAccountListHelpers("benchmark", { normalizeAccountId });

export { listBenchmarkChannelAccountIds, resolveDefaultBenchmarkChannelAccountId };

function resolveMergedBenchmarkAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): BenchmarkChannelAccountConfig {
  return resolveMergedAccountConfig<BenchmarkChannelAccountConfig>({
    channelConfig: cfg.channels?.benchmark as BenchmarkChannelAccountConfig | undefined,
    accounts: cfg.channels?.benchmark?.accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

export function resolveBenchmarkChannelAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedBenchmarkChannelAccount {
  const accountId = normalizeAccountId(params.accountId);
  const section = params.cfg.channels?.benchmark;
  const merged = resolveMergedBenchmarkAccountConfig(params.cfg, accountId);
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
export type { ResolvedBenchmarkChannelAccount } from "./types.js";
