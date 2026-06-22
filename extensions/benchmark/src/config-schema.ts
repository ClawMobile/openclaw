import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

const BenchmarkChannelAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    token: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
  })
  .strict();

const BenchmarkChannelConfigSchema = BenchmarkChannelAccountConfigSchema.extend({
  accounts: z.record(z.string(), BenchmarkChannelAccountConfigSchema.partial()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

export const benchmarkChannelPluginConfigSchema = buildChannelConfigSchema(
  BenchmarkChannelConfigSchema,
);
