import { resolveClawBenchChannelAccount } from "./accounts.js";
import { completeClawBenchRun } from "./runs.js";
import { parseClawBenchTarget } from "./target.js";
import type { CoreConfig } from "./types.js";

export async function sendClawBenchChannelText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
}) {
  const account = resolveClawBenchChannelAccount({ cfg: params.cfg, accountId: params.accountId });
  const parsed = parseClawBenchTarget(params.to);
  completeClawBenchRun({
    accountId: account.accountId,
    runId: parsed.runId,
    replyText: params.text,
  });
  return {
    to: params.to,
    messageId: `${parsed.runId}:reply`,
  };
}
