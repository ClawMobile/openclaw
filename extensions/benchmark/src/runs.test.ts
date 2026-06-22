import { describe, expect, it } from "vitest";
import {
  completeBenchmarkRun,
  createBenchmarkRun,
  getBenchmarkRunSnapshot,
  markBenchmarkRunRunning,
} from "./runs.js";

describe("benchmark run store", () => {
  it("tracks a run through completion", () => {
    createBenchmarkRun({
      accountId: "default",
      runId: "run-store-complete",
      instruction: "Set the screen brightness to 50%",
      deviceSerial: "device-1",
    });

    expect(
      markBenchmarkRunRunning({
        accountId: "default",
        runId: "run-store-complete",
      })?.status,
    ).toBe("RUNNING");
    expect(
      completeBenchmarkRun({
        accountId: "default",
        runId: "run-store-complete",
        replyText: "Done",
      })?.status,
    ).toBe("COMPLETED");

    expect(
      getBenchmarkRunSnapshot({
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
    });
  });

  it("rejects duplicate active run ids", () => {
    createBenchmarkRun({
      accountId: "default",
      runId: "run-store-duplicate",
      instruction: "First",
    });

    expect(() =>
      createBenchmarkRun({
        accountId: "default",
        runId: "run-store-duplicate",
        instruction: "Second",
      }),
    ).toThrow("benchmark run already active");
  });
});
