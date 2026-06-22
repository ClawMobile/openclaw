export type BenchmarkRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export type BenchmarkRunRecord = {
  accountId: string;
  runId: string;
  instruction: string;
  deviceSerial?: string;
  status: BenchmarkRunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  replyText?: string;
  error?: string;
};

const runsByAccount = new Map<string, Map<string, BenchmarkRunRecord>>();

function accountRuns(accountId: string): Map<string, BenchmarkRunRecord> {
  let runs = runsByAccount.get(accountId);
  if (!runs) {
    runs = new Map();
    runsByAccount.set(accountId, runs);
  }
  return runs;
}

export function createBenchmarkRun(params: {
  accountId: string;
  runId: string;
  instruction: string;
  deviceSerial?: string;
}): BenchmarkRunRecord {
  const runs = accountRuns(params.accountId);
  const existing = runs.get(params.runId);
  if (existing && existing.status !== "COMPLETED" && existing.status !== "FAILED") {
    throw new Error(`benchmark run already active: ${params.runId}`);
  }
  const now = Date.now();
  const record: BenchmarkRunRecord = {
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

export function markBenchmarkRunRunning(params: {
  accountId: string;
  runId: string;
}): BenchmarkRunRecord | null {
  const record = accountRuns(params.accountId).get(params.runId);
  if (!record) {
    return null;
  }
  record.status = "RUNNING";
  record.updatedAt = Date.now();
  return { ...record };
}

export function completeBenchmarkRun(params: {
  accountId: string;
  runId: string;
  replyText?: string;
}): BenchmarkRunRecord | null {
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

export function failBenchmarkRun(params: {
  accountId: string;
  runId: string;
  error: string;
}): BenchmarkRunRecord | null {
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

export function getBenchmarkRunSnapshot(params: {
  accountId?: string | null;
  runId: string;
}): BenchmarkRunRecord | null {
  const accountId = params.accountId ?? "default";
  const record = accountRuns(accountId).get(params.runId);
  return record ? { ...record } : null;
}
