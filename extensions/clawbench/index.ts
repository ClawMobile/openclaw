import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "clawbench",
  name: "ClawBench",
  description: "Local HTTP ClawBench channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "clawBenchChannelPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setClawBenchChannelRuntime",
  },
});
