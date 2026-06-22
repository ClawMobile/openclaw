export type BenchmarkTarget = {
  runId: string;
};

export function buildBenchmarkTarget(params: BenchmarkTarget): string {
  return `run:${params.runId}`;
}

export function parseBenchmarkTarget(raw: string): BenchmarkTarget {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("run:")) {
    return { runId: trimmed.slice(4) || "default" };
  }
  return { runId: trimmed || "default" };
}
