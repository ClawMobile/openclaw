import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildSiliconFlowModelDefinition,
  SILICONFLOW_BASE_URL,
  SILICONFLOW_MODEL_CATALOG,
} from "./models.js";

export const SILICONFLOW_DEFAULT_MODEL_REF = "siliconflow/Qwen/Qwen3.6-35B-A3B";

const siliconFlowPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: SILICONFLOW_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "siliconflow",
    api: "openai-completions",
    baseUrl: SILICONFLOW_BASE_URL,
    catalogModels: SILICONFLOW_MODEL_CATALOG.map(buildSiliconFlowModelDefinition),
    aliases: [{ modelRef: SILICONFLOW_DEFAULT_MODEL_REF, alias: "SiliconFlow" }],
  }),
});

export function applySiliconFlowConfig(cfg: OpenClawConfig): OpenClawConfig {
  return siliconFlowPresetAppliers.applyConfig(cfg);
}
