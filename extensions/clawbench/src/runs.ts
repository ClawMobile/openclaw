export type ClawBenchRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export type ClawBenchRunRecord = {
  accountId: string;
  runId: string;
  instruction: string;
  deviceSerial?: string;
  status: ClawBenchRunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  replyText?: string;
  error?: string;
};

const runsByAccount = new Map<string, Map<string, ClawBenchRunRecord>>();

function accountRuns(accountId: string): Map<string, ClawBenchRunRecord> {
  let runs = runsByAccount.get(accountId);
  if (!runs) {
    runs = new Map();
    runsByAccount.set(accountId, runs);
  }
  return runs;
}

export function createClawBenchRun(params: {
  accountId: string;
  runId: string;
  instruction: string;
  deviceSerial?: string;
}): ClawBenchRunRecord {
  const runs = accountRuns(params.accountId);
  const existing = runs.get(params.runId);
  if (existing && existing.status !== "COMPLETED" && existing.status !== "FAILED") {
    throw new Error(`clawbench run already active: ${params.runId}`);
  }
  const now = Date.now();
  const record: ClawBenchRunRecord = {
    accountId: params.accountId,
    runId: params.runId,
    instruction: params.instruction,
    deviceSerial: params.deviceSerial,
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
  };
  runs.set(params.runId, record);
  return { ...record };
}

export function markClawBenchRunRunning(params: {
  accountId: string;
  runId: string;
}): ClawBenchRunRecord | null {
  const record = accountRuns(params.accountId).get(params.runId);
  if (!record) {
    return null;
  }
  record.status = "RUNNING";
  record.updatedAt = Date.now();
  return { ...record };
}

export function completeClawBenchRun(params: {
  accountId: string;
  runId: string;
  replyText?: string;
}): ClawBenchRunRecord | null {
  const record = accountRuns(params.accountId).get(params.runId);
  if (!record) {
    return null;
  }
  const now = Date.now();
  record.status = "COMPLETED";
  record.updatedAt = now;
  record.completedAt = now;
  record.replyText = params.replyText;
  record.error = undefined;
  return { ...record };
}

export function failClawBenchRun(params: {
  accountId: string;
  runId: string;
  error: string;
}): ClawBenchRunRecord | null {
  const record = accountRuns(params.accountId).get(params.runId);
  if (!record) {
    return null;
  }
  const now = Date.now();
  record.status = "FAILED";
  record.updatedAt = now;
  record.completedAt = now;
  record.error = params.error;
  return { ...record };
}

export function getClawBenchRunSnapshot(params: {
  accountId?: string | null;
  runId: string;
}): ClawBenchRunRecord | null {
  const accountId = params.accountId ?? "default";
  const record = accountRuns(accountId).get(params.runId);
  return record ? { ...record } : null;
}
