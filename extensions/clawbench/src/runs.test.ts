import { describe, expect, it } from "vitest";
import {
  completeClawBenchRun,
  createClawBenchRun,
  getClawBenchRunSnapshot,
  markClawBenchRunRunning,
} from "./runs.js";

describe("clawbench run store", () => {
  it("tracks a run through completion", () => {
    createClawBenchRun({
      accountId: "default",
      runId: "run-store-complete",
      instruction: "Set the screen brightness to 50%",
      deviceSerial: "device-1",
    });

    expect(
      markClawBenchRunRunning({
        accountId: "default",
        runId: "run-store-complete",
      })?.status,
    ).toBe("RUNNING");
    expect(
      completeClawBenchRun({
        accountId: "default",
        runId: "run-store-complete",
        replyText: "Done",
        latency: {
          totalMs: 42,
          dispatchMs: 40,
        },
        metrics: {
          replyCount: 1,
        },
        trajectory: [
          {
            event: "run.completed",
            at: 123,
          },
        ],
      })?.status,
    ).toBe("COMPLETED");

    expect(
      getClawBenchRunSnapshot({
        accountId: "default",
        runId: "run-store-complete",
      }),
    ).toMatchObject({
      accountId: "default",
      runId: "run-store-complete",
      instruction: "Set the screen brightness to 50%",
      deviceSerial: "device-1",
      status: "COMPLETED",
      replyText: "Done",
      latency: {
        totalMs: 42,
        dispatchMs: 40,
      },
      metrics: {
        replyCount: 1,
      },
      trajectory: [
        {
          event: "run.completed",
          at: 123,
        },
      ],
    });
  });

  it("rejects duplicate active run ids", () => {
    createClawBenchRun({
      accountId: "default",
      runId: "run-store-duplicate",
      instruction: "First",
    });

    expect(() =>
      createClawBenchRun({
        accountId: "default",
        runId: "run-store-duplicate",
        instruction: "Second",
      }),
    ).toThrow("clawbench run already active");
  });
});
