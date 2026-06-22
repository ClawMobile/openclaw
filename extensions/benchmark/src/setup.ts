import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import type { CoreConfig } from "./types.js";

export function applyBenchmarkSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Record<string, unknown>;
}): OpenClawConfig {
  const nextCfg = structuredClone(params.cfg) as CoreConfig;
  const section = nextCfg.channels?.benchmark ?? {};
  const accounts = { ...section.accounts };
  const target =
    params.accountId === DEFAULT_ACCOUNT_ID ? { ...section } : { ...accounts[params.accountId] };

  target.enabled = true;
  if (typeof params.input.httpHost === "string") {
    target.host = params.input.httpHost;
  }
  if (typeof params.input.httpPort === "string") {
    const parsedPort = Number.parseInt(params.input.httpPort, 10);
    if (Number.isInteger(parsedPort)) {
      target.port = parsedPort;
    }
  }
  if (typeof params.input.token === "string") {
    target.token = params.input.token;
  }

  nextCfg.channels ??= {};
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    nextCfg.channels.benchmark = {
      ...section,
      ...target,
    };
  } else {
    accounts[params.accountId] = target;
    nextCfg.channels.benchmark = {
      ...section,
      accounts,
    };
  }
  return nextCfg as OpenClawConfig;
}
