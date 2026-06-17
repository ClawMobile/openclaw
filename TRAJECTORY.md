# OpenClaw Trajectory Format

This file defines the trajectory shape we want for end-to-end debugging and
latency analysis. A trajectory should let us replay what happened from the
moment a user sends an instruction until OpenClaw emits the final assistant
response.

## Goals

A trajectory must answer these questions:

- What did the user ask?
- What prompt/context was submitted to the model?
- What did the model return at each model step?
- Which function/tool calls did the model request, with what arguments?
- What did each function/tool call return?
- What final response was sent back to the user?
- How much time was spent end-to-end, in each model step, and in each tool call?

The latency result is the benchmark output. The trajectory is the evidence used
to explain that latency and the model/tool behavior behind it.

## Important Rule: Not Every Model Step Has a Function Call

A model step is not the same thing as a function call.

One model step can produce:

- no function call, only assistant text
- one function call
- multiple function calls
- a request for user input or approval
- an error, timeout, or interruption

Therefore trajectory records must always preserve the model step even when
`toolCalls` is empty. Tool calls are children of a model step, not the step
itself.

## Storage Format

Runtime trajectory events are JSON Lines. Each line is one ordered event.

Events are ordered by `seq`; `ts` is useful for wall-clock inspection. Latency
measurements should use monotonic durations recorded by the runtime when
available.

```json
{
  "traceSchema": "openclaw-trajectory",
  "schemaVersion": 1,
  "traceId": "session-id",
  "source": "runtime",
  "type": "event.type",
  "ts": "2026-06-17T10:00:00.000Z",
  "seq": 1,
  "sessionId": "session-id",
  "sessionKey": "agent:main:telegram:direct:123",
  "runId": "run-id",
  "workspaceDir": "/workspace",
  "provider": "openai",
  "modelId": "gpt-5",
  "modelApi": "responses",
  "data": {}
}
```

## Required Event Types

### `session.started`

Start of one user-request trajectory.

```json
{
  "type": "session.started",
  "data": {
    "channel": "telegram",
    "threadId": "thread-id",
    "workspaceDir": "/workspace",
    "userInstruction": "user-visible instruction text",
    "sessionFile": "/path/to/session.jsonl",
    "toolCount": 12,
    "startedAtMs": 1234567890
  }
}
```

### `context.compiled`

The full prompt context OpenClaw submits to the model runtime.

If the downstream model runtime builds the final provider HTTP request
internally, this event is still required and should be marked as the fullest
available prompt capture. Byte-for-byte provider request capture should be added
when the runtime exposes it.

```json
{
  "type": "context.compiled",
  "data": {
    "captureLevel": "openclaw-runtime-request",
    "systemPrompt": "full system/developer instructions",
    "prompt": "current user prompt",
    "historyMessages": [
      {
        "role": "user",
        "content": "previous user message"
      },
      {
        "role": "assistant",
        "content": "previous assistant message"
      }
    ],
    "imagesCount": 0,
    "tools": [
      {
        "name": "browser.open",
        "description": "Open a URL",
        "parameters": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string"
            }
          },
          "required": ["url"]
        }
      }
    ]
  }
}
```

Recommended `captureLevel` values:

- `provider-http-request`: byte-for-byte provider request body, if available
- `model-runtime-request`: complete request sent to the model runtime
- `openclaw-runtime-request`: complete request OpenClaw sent to its embedded runtime
- `prompt-summary`: partial prompt capture only

### `model.step.started`

Start of one model request/response boundary.

```json
{
  "type": "model.step.started",
  "data": {
    "stepId": "step-1",
    "threadId": "thread-id",
    "turnId": "turn-id",
    "model": "gpt-5",
    "provider": "openai",
    "startedAtMs": 1234567900
  }
}
```

### `model.request`

The exact request shape sent to the model boundary that OpenClaw can observe.
This may duplicate `context.compiled` for runtimes where OpenClaw only sees one
compiled request.

```json
{
  "type": "model.request",
  "data": {
    "stepId": "step-1",
    "captureLevel": "openclaw-runtime-request",
    "messages": [
      {
        "role": "system",
        "content": "full system/developer instructions"
      },
      {
        "role": "user",
        "content": "current user instruction"
      }
    ],
    "tools": [
      {
        "name": "shell.exec",
        "parameters": {
          "type": "object"
        }
      }
    ],
    "toolChoice": "auto",
    "providerOptions": {}
  }
}
```

### `model.response`

The model output for one step.

`toolCalls` must be present and may be an empty array.

```json
{
  "type": "model.response",
  "data": {
    "stepId": "step-1",
    "status": "success",
    "latencyMs": 1512,
    "latencyKind": "model-and-runtime-minus-tools",
    "runtimeLatencyMs": 1553,
    "modelAndRuntimeLatencyMs": 1512,
    "assistantText": "I will inspect the repository first.",
    "rawResponse": {
      "finishReason": "tool_calls"
    },
    "toolCalls": [
      {
        "toolCallId": "call-1",
        "name": "shell.exec",
        "arguments": {
          "cmd": "git status -sb"
        }
      }
    ],
    "usage": {
      "inputTokens": 1200,
      "outputTokens": 80,
      "cachedInputTokens": 0
    }
  }
}
```

For a direct answer with no function call:

```json
{
  "type": "model.response",
  "data": {
    "stepId": "step-2",
    "status": "success",
    "latencyMs": 932,
    "assistantText": "The local branch is already up to date.",
    "toolCalls": [],
    "usage": {
      "inputTokens": 900,
      "outputTokens": 30
    }
  }
}
```

### `tool.call`

One tool/function invocation requested by the model.

```json
{
  "type": "tool.call",
  "data": {
    "stepId": "step-1",
    "threadId": "thread-id",
    "turnId": "turn-id",
    "toolCallId": "call-1",
    "name": "shell.exec",
    "arguments": {
      "cmd": "git status -sb"
    },
    "startedAtMs": 1234568000
  }
}
```

### `tool.result`

The result returned to the model/runtime for one tool/function invocation.

```json
{
  "type": "tool.result",
  "data": {
    "stepId": "step-1",
    "threadId": "thread-id",
    "turnId": "turn-id",
    "toolCallId": "call-1",
    "name": "shell.exec",
    "success": true,
    "latencyMs": 41,
    "contentItems": [
      {
        "type": "text",
        "text": "## feat/tracing-2026.5.7-pr...origin/feat/tracing-2026.5.7-pr"
      }
    ]
  }
}
```

### `session.ended`

End of the trajectory for the user request.

```json
{
  "type": "session.ended",
  "data": {
    "status": "success",
    "finalAssistantText": "I wrote TRAJECTORY.md with the target format.",
    "e2eLatencyMs": 3520,
    "modelLatencyMs": null,
    "modelAndRuntimeLatencyMs": 2444,
    "toolLatencyMs": 41,
    "overheadLatencyMs": 1035,
    "toolCallCount": 1,
    "modelStepCount": 2,
    "timedOut": false,
    "aborted": false,
    "promptError": null
  }
}
```

## Latency Fields

Use these latency definitions consistently:

- `e2eLatencyMs`: user instruction received to final response emitted.
- `modelLatencyMs`: sum of observed model request/response durations.
- `modelAndRuntimeLatencyMs`: observed model runtime duration minus tool time when
  provider-only model latency is not directly available.
- `toolLatencyMs`: sum of observed tool/function execution durations.
- `overheadLatencyMs`: `e2eLatencyMs - modelLatencyMs - toolLatencyMs`.
- `latencyMs` on `model.response`: one model step duration.
- `latencyMs` on `tool.result`: one tool call duration.

When a duration cannot be measured exactly, omit it or set it to `null`; do not
invent values from wall-clock timestamps after the fact.

The current Codex app-server bridge records the exact end-to-end duration and
tool durations. It does not currently expose provider-only model latency, so it
sets `modelLatencyMs` to `null` and emits `modelAndRuntimeLatencyMs` plus
`latencyKind: "model-and-runtime-minus-tools"` for the model step estimate.

## Minimal Complete Trajectory

The smallest useful trajectory contains:

1. `session.started`
2. `context.compiled`
3. `model.step.started`
4. `model.request`
5. `model.response`
6. zero or more `tool.call` / `tool.result` pairs
7. zero or more additional model steps
8. `session.ended`

## Export Bundle

An exported trajectory bundle should keep the JSONL timeline plus derived files
for easier inspection:

- `events.jsonl`: ordered runtime and transcript events
- `metadata.json`: model, provider, runtime, plugin, workspace, and config info
- `prompts.json`: prompt submissions and prompt-building details
- `tools.json`: tool/function schemas exposed to the model
- `artifacts.json`: final status, latency, usage, errors, and assistant text
- `session-branch.json`: redacted transcript branch
- `manifest.json`: file list, schema version, event counts, and source paths

## Redaction and Limits

Trajectory data is sensitive. It may contain user messages, prompts, local
paths, tool arguments, tool results, and model outputs.

Before sharing outside the trusted debugging group:

- redact credentials, tokens, cookies, API keys, and passwords
- redact or summarize large images, screenshots, attachments, and file payloads
- replace home/workspace paths where possible
- preserve event order and ids even when content is redacted

Redaction should not remove the existence of a model step or tool call. If
content is removed, keep a placeholder such as `"<redacted>"`.
