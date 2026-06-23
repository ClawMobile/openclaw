export type ClawBenchChannelAccountConfig = {
  name?: string;
  enabled?: boolean;
  host?: string;
  port?: number;
  token?: string;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
};

type ClawBenchChannelConfig = ClawBenchChannelAccountConfig & {
  accounts?: Record<string, Partial<ClawBenchChannelAccountConfig>>;
  defaultAccount?: string;
};

export type CoreConfig = {
  channels?: {
    clawbench?: ClawBenchChannelConfig;
  };
  session?: {
    store?: string;
  };
};

export type ResolvedClawBenchChannelAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  host: string;
  port: number;
  token?: string;
  baseUrl: string;
  config: ClawBenchChannelAccountConfig;
};
