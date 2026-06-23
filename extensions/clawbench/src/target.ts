export type ClawBenchTarget = {
  runId: string;
};

export function buildClawBenchTarget(params: ClawBenchTarget): string {
  return `run:${params.runId}`;
}

export function parseClawBenchTarget(raw: string): ClawBenchTarget {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("run:")) {
    return { runId: trimmed.slice(4) || "default" };
  }
  return { runId: trimmed || "default" };
}
