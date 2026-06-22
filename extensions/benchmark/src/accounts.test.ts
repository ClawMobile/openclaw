import { describe, expect, it } from "vitest";
import { resolveBenchmarkChannelAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

describe("benchmark account resolution", () => {
  it("is unconfigured until the benchmark channel config exists", () => {
    const account = resolveBenchmarkChannelAccount({ cfg: {} });

    expect(account.configured).toBe(false);
    expect(account.enabled).toBe(false);
    expect(account.baseUrl).toBe("http://127.0.0.1:8765");
  });

  it("uses loopback defaults when enabled", () => {
    const cfg: CoreConfig = {
      channels: {
        benchmark: {
          enabled: true,
        },
      },
    };

    const account = resolveBenchmarkChannelAccount({ cfg });

    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(true);
    expect(account.host).toBe("127.0.0.1");
    expect(account.port).toBe(8765);
    expect(account.baseUrl).toBe("http://127.0.0.1:8765");
  });
});
