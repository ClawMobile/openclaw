type PendingTrajectoryDelivery = {
  filePath: string;
  registeredAtMs: number;
  commit: () => Promise<void>;
};

type TrajectoryDeliveryRegistry = {
  pendingByRunId: Map<string, PendingTrajectoryDelivery>;
};

const TRAJECTORY_DELIVERY_REGISTRY_KEY = Symbol.for("openclaw.trajectoryDeliveryRegistry.v1");

function resolveTrajectoryDeliveryRegistry(): TrajectoryDeliveryRegistry | undefined {
  const globalRecord = globalThis as typeof globalThis &
    Record<symbol, TrajectoryDeliveryRegistry | undefined>;
  return globalRecord[TRAJECTORY_DELIVERY_REGISTRY_KEY];
}

export async function flushPendingTrajectoryDeliveryForRun(
  runId: string | undefined,
): Promise<{ flushed: boolean; filePath?: string; error?: unknown }> {
  const normalizedRunId = runId?.trim();
  if (!normalizedRunId) {
    return { flushed: false };
  }
  const registry = resolveTrajectoryDeliveryRegistry();
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
