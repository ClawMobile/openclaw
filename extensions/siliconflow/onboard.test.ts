import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryModel,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { applySiliconFlowConfig, SILICONFLOW_DEFAULT_MODEL_REF } from "./onboard.js";

describe("siliconflow onboard", () => {
  it("adds the fixed SiliconFlow endpoint and catalog", () => {
    const cfg = applySiliconFlowConfig({});
    expect(cfg.models?.providers?.siliconflow).toMatchObject({
      baseUrl: "https://api.siliconflow.cn/v1",
      api: "openai-completions",
    });
    expect(cfg.models?.providers?.siliconflow?.models.map((model) => model.id)).toEqual([
      "Qwen/Qwen3.6-35B-A3B",
      "Qwen/Qwen3.6-27B",
      "deepseek-ai/DeepSeek-V3.2",
      "Pro/deepseek-ai/DeepSeek-V3.2",
      "deepseek-ai/DeepSeek-V4-Flash",
    ]);
    expectProviderOnboardPrimaryModel({
      applyConfig: applySiliconFlowConfig,
      modelRef: SILICONFLOW_DEFAULT_MODEL_REF,
    });
  });

  it("merges catalog models with existing provider overrides", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applySiliconFlowConfig,
      providerId: "siliconflow",
      providerApi: "openai-completions",
      baseUrl: "https://api.siliconflow.cn/v1",
      legacyApi: "openai-completions",
      legacyModelId: "custom-model",
      legacyModelName: "Custom",
    });
    expect(provider?.models.map((model) => model.id)).toContain("custom-model");
    expect(provider?.models.map((model) => model.id)).toContain("Qwen/Qwen3.6-35B-A3B");
  });
});
