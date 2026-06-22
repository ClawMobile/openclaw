import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "benchmark",
  name: "Benchmark",
  description: "Local HTTP benchmark channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "benchmarkChannelPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setBenchmarkChannelRuntime",
  },
});
