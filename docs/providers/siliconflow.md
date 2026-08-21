---
summary: "SiliconFlow setup (auth + model selection)"
title: "SiliconFlow"
read_when:
  - You want to use SiliconFlow with OpenClaw
  - You need the SiliconFlow API key env var or CLI auth choice
---

# SiliconFlow

[SiliconFlow](https://www.siliconflow.cn) provides an OpenAI-compatible API for
Qwen, DeepSeek, and other models.

| Property | Value                              |
| -------- | ---------------------------------- |
| Provider | `siliconflow`                      |
| Auth     | `SILICONFLOW_API_KEY`              |
| API      | OpenAI-compatible Chat Completions |
| Base URL | `https://api.siliconflow.cn/v1`    |

## Getting Started

<Steps>
  <Step title="Get an API key">
    Create an API key in the [SiliconFlow console](https://cloud.siliconflow.cn/account/ak).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice siliconflow-api-key
    ```

    The base URL is built in; onboarding only asks for the API key.

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider siliconflow
    ```
  </Step>
</Steps>

### Non-Interactive Setup

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice siliconflow-api-key \
  --siliconflow-api-key "$SILICONFLOW_API_KEY"
```

## Built-In Catalog

OpenClaw ships a focused catalog of SiliconFlow chat models that support tool
calling. SiliconFlow changes model availability and pricing over time, so check
the [SiliconFlow model catalog](https://www.siliconflow.cn/models) before relying
on a particular model in production.

| Model ref                                   | Input        | Notes         |
| ------------------------------------------- | ------------ | ------------- |
| `siliconflow/Qwen/Qwen3.6-35B-A3B`          | Text + image | Default model |
| `siliconflow/Qwen/Qwen3.6-27B`              | Text + image |               |
| `siliconflow/deepseek-ai/DeepSeek-V3.2`     | Text         |               |
| `siliconflow/Pro/deepseek-ai/DeepSeek-V3.2` | Text         | Pro route     |
| `siliconflow/deepseek-ai/DeepSeek-V4-Flash` | Text         |               |

## Manual Config

The bundled plugin normally means you only need the API key. Use explicit
`models.providers.siliconflow` config when you want to add another SiliconFlow
model or override its metadata:

```json5
{
  env: { SILICONFLOW_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "siliconflow/Qwen/Qwen3.6-35B-A3B" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      siliconflow: {
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKey: "${SILICONFLOW_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "Qwen/Qwen3.6-35B-A3B",
            name: "Qwen 3.6 35B A3B",
            input: ["text", "image"],
          },
        ],
      },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon (launchd/systemd), make sure
`SILICONFLOW_API_KEY` is available to that process, for example in
`~/.openclaw/.env` or through `env.shellEnv`.
</Note>
