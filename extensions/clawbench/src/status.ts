import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import type { ResolvedClawBenchChannelAccount } from "./types.js";

export const clawBenchChannelStatus =
  createComputedAccountStatusAdapter<ResolvedClawBenchChannelAccount>({
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    buildChannelSummary: ({ snapshot }) => ({
      baseUrl: snapshot.baseUrl ?? "[not running]",
    }),
    resolveAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      extra: {
        baseUrl: runtime?.baseUrl ?? account.baseUrl,
        running: runtime?.running ?? false,
        tokenStatus: account.token ? "configured" : "none",
      },
    }),
  });
