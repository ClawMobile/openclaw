---
summary: "Local HTTP channel for deterministic benchmark harnesses"
title: "Benchmark channel"
read_when:
  - You are wiring an external benchmark harness into OpenClaw
  - You need a local HTTP trigger surface for automated agent evaluation
  - You are debugging benchmark run completion polling
---

`benchmark` is a bundled synthetic channel for deterministic agent evaluation.
It is not a production chat channel. It exists so a benchmark harness can submit
one instruction over local HTTP, wait for OpenClaw to finish the agent turn, and
then verify device state outside OpenClaw.

## HTTP API

By default the channel listens on `127.0.0.1:8765`.

Submit a benchmark run:

```http
POST /runs
Content-Type: application/json

{
  "run_id": "L1-01-0001",
  "instruction": "Set the screen brightness to 50%",
  "device_serial": "android-device-serial"
}
```

Poll completion:

```http
GET /runs/L1-01-0001
```

The response contains a `run.status` value:

- `QUEUED` — the request was accepted but dispatch has not started yet.
- `RUNNING` — OpenClaw is processing the instruction.
- `COMPLETED` — OpenClaw produced a final reply.
- `FAILED` — dispatch failed before completion.

## Config

```json
{
  "channels": {
    "benchmark": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 8765,
      "token": "optional-local-token"
    }
  }
}
```

If `token` is set, requests must include either:

```http
Authorization: Bearer optional-local-token
```

or:

```http
x-openclaw-benchmark-token: optional-local-token
```

Keep the benchmark channel bound to loopback unless you have a separate network
security layer. The endpoint can trigger arbitrary agent instructions.

## Verification Boundary

The benchmark channel does not decide whether a task passed. It only handles
trigger and completion status. The benchmark harness should verify success
directly against the system under test, for example by reading Android state via
ADB.
