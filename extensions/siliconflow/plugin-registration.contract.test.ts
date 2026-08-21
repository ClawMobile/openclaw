import { describePluginRegistrationContract } from "openclaw/plugin-sdk/plugin-test-contracts";

describePluginRegistrationContract({
  pluginId: "siliconflow",
  providerIds: ["siliconflow"],
  manifestAuthChoice: {
    pluginId: "siliconflow",
    choiceId: "siliconflow-api-key",
    choiceLabel: "SiliconFlow API key",
    groupId: "siliconflow",
    groupLabel: "SiliconFlow",
    groupHint: "OpenAI-compatible API",
  },
});
