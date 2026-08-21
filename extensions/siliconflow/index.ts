import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applySiliconFlowConfig, SILICONFLOW_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildSiliconFlowProvider } from "./provider-catalog.js";

const PROVIDER_ID = "siliconflow";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "SiliconFlow Provider",
  description: "Bundled SiliconFlow provider plugin",
  provider: {
    label: "SiliconFlow",
    docsPath: "/providers/siliconflow",
    auth: [
      {
        methodId: "api-key",
        label: "SiliconFlow API key",
        hint: "OpenAI-compatible API",
        optionKey: "siliconflowApiKey",
        flagName: "--siliconflow-api-key",
        envVar: "SILICONFLOW_API_KEY",
        promptMessage: "Enter SiliconFlow API key",
        noteTitle: "SiliconFlow",
        noteMessage: [
          "SiliconFlow provides an OpenAI-compatible API for Qwen, DeepSeek, and other models.",
          "Get your API key at: https://cloud.siliconflow.cn/account/ak",
        ].join("\n"),
        defaultModel: SILICONFLOW_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applySiliconFlowConfig(cfg),
        wizard: {
          choiceId: "siliconflow-api-key",
          choiceLabel: "SiliconFlow API key",
          groupId: PROVIDER_ID,
          groupLabel: "SiliconFlow",
          groupHint: "OpenAI-compatible API",
        },
      },
    ],
    catalog: {
      buildProvider: buildSiliconFlowProvider,
      buildStaticProvider: buildSiliconFlowProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
  },
});
