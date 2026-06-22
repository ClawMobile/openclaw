export type BenchmarkChannelAccountConfig = {
  name?: string;
  enabled?: boolean;
  host?: string;
  port?: number;
  token?: string;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
};

type BenchmarkChannelConfig = BenchmarkChannelAccountConfig & {
  accounts?: Record<string, Partial<BenchmarkChannelAccountConfig>>;
  defaultAccount?: string;
};

export type CoreConfig = {
  channels?: {
    benchmark?: BenchmarkChannelConfig;
  };
  session?: {
    store?: string;
  };
};

export type ResolvedBenchmarkChannelAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  host: string;
  port: number;
  token?: string;
  baseUrl: string;
  config: BenchmarkChannelAccountConfig;
};
