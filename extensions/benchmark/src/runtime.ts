import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setBenchmarkChannelRuntime, getRuntime: getBenchmarkChannelRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "benchmark",
    errorMessage: "Benchmark channel runtime not initialized",
  });

export { getBenchmarkChannelRuntime, setBenchmarkChannelRuntime };
