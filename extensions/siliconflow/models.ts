import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const SILICONFLOW_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "siliconflow",
  catalog: manifest.modelCatalog.providers.siliconflow,
});

export const SILICONFLOW_BASE_URL = SILICONFLOW_MANIFEST_PROVIDER.baseUrl;

export const SILICONFLOW_MODEL_CATALOG: ModelDefinitionConfig[] =
  SILICONFLOW_MANIFEST_PROVIDER.models;

export function buildSiliconFlowModelDefinition(
  model: (typeof SILICONFLOW_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
