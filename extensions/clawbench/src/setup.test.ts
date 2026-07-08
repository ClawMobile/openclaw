import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { applyClawBenchSetup } from "./setup.js";
import type { CoreConfig } from "./types.js";

describe("clawbench setup", () => {
  it("materializes loopback host and port defaults", () => {
    const next = applyClawBenchSetup({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      input: {},
    }) as CoreConfig;

    expect(next.channels?.clawbench).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 8765,
    });
  });

  it("uses explicit httpHost and httpPort setup input", () => {
    const next = applyClawBenchSetup({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      input: {
        httpHost: "0.0.0.0",
        httpPort: "9999",
      },
    }) as CoreConfig;

    expect(next.channels?.clawbench).toMatchObject({
      enabled: true,
      host: "0.0.0.0",
      port: 9999,
    });
  });

  it("preserves existing host and port when setup input omits them", () => {
    const cfg: CoreConfig = {
      channels: {
        clawbench: {
          enabled: true,
          host: "127.0.0.2",
          port: 9000,
        },
      },
    };

    const next = applyClawBenchSetup({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      input: {},
    }) as CoreConfig;

    expect(next.channels?.clawbench).toMatchObject({
      enabled: true,
      host: "127.0.0.2",
      port: 9000,
    });
  });

  it("materializes inherited host and port for named accounts", () => {
    const cfg: CoreConfig = {
      channels: {
        clawbench: {
          enabled: true,
          host: "0.0.0.0",
          port: 9001,
        },
      },
    };

    const next = applyClawBenchSetup({
      cfg,
      accountId: "phone",
      input: {},
    }) as CoreConfig;

    expect(next.channels?.clawbench?.accounts?.phone).toMatchObject({
      enabled: true,
      host: "0.0.0.0",
      port: 9001,
    });
  });
});
