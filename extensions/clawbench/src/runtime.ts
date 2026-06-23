import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setClawBenchChannelRuntime, getRuntime: getClawBenchChannelRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "clawbench",
    errorMessage: "ClawBench channel runtime not initialized",
  });

export { getClawBenchChannelRuntime, setClawBenchChannelRuntime };
