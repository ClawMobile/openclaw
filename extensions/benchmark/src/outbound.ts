import { resolveBenchmarkChannelAccount } from "./accounts.js";
import { completeBenchmarkRun } from "./runs.js";
import { parseBenchmarkTarget } from "./target.js";
import type { CoreConfig } from "./types.js";

export async function sendBenchmarkChannelText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
}) {
  const account = resolveBenchmarkChannelAccount({ cfg: params.cfg, accountId: params.accountId });
  const parsed = parseBenchmarkTarget(params.to);
  completeBenchmarkRun({
    accountId: account.accountId,
    runId: parsed.runId,
    replyText: params.text,
  });
  return {
    to: params.to,
    messageId: `${parsed.runId}:reply`,
  };
}
