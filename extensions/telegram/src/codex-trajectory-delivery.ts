type PendingCodexTrajectoryDelivery = {
  filePath: string;
  registeredAtMs: number;
  commit: () => Promise<void>;
};

type CodexTrajectoryDeliveryRegistry = {
  pendingByRunId: Map<string, PendingCodexTrajectoryDelivery>;
};

const CODEX_TRAJECTORY_DELIVERY_REGISTRY_KEY = Symbol.for(
  "openclaw.codexTrajectoryDeliveryRegistry.v1",
);

function resolveCodexTrajectoryDeliveryRegistry(): CodexTrajectoryDeliveryRegistry | undefined {
  const globalRecord = globalThis as typeof globalThis &
    Record<symbol, CodexTrajectoryDeliveryRegistry | undefined>;
  return globalRecord[CODEX_TRAJECTORY_DELIVERY_REGISTRY_KEY];
}

export async function flushPendingCodexTrajectoryDeliveryForRun(
  runId: string | undefined,
): Promise<{ flushed: boolean; filePath?: string; error?: unknown }> {
  const normalizedRunId = runId?.trim();
  if (!normalizedRunId) {
    return { flushed: false };
  }
  const registry = resolveCodexTrajectoryDeliveryRegistry();
  const pending = registry?.pendingByRunId.get(normalizedRunId);
  if (!registry || !pending) {
    return { flushed: false };
  }
  registry.pendingByRunId.delete(normalizedRunId);
  try {
    await pending.commit();
    return { flushed: true, filePath: pending.filePath };
  } catch (error) {
    registry.pendingByRunId.set(normalizedRunId, pending);
    return { flushed: false, filePath: pending.filePath, error };
  }
}
