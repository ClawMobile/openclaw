# ClawMobile Benchmark Trajectory v1

This trajectory format is for the first benchmark analysis pass: completion rate,
step count, token usage, and duration. It intentionally avoids full prompts,
message bodies, screenshots, UIAutomator XML, action coordinates, grounding data,
and full tool results.

## Shape

A trajectory is one JSON object written at the end of a run:

```json
{
  "schema_version": "1.0.0-v1",
  "trajectory_id": "traj_20260619_keep_0007",
  "started_at": "2026-06-19T10:00:01Z",
  "task_id": "keep_create_note_titled",
  "instruction": "Create a note in Google Keep",
  "agent": { "framework": "openclaw", "model": "gpt-5.4" },
  "turns": [],
  "outcome": { "success": true, "termination_reason": "success" },
  "rollups": {
    "total_turns": 0,
    "total_actions": 0,
    "total_errors": 0,
    "total_tokens": { "input": 0, "output": 0 },
    "total_duration_ms": 0
  }
}
```

The schema is stored at `src/trajectory/trajectory.schema.json`.

## Collection Switch

Collection is enabled by default. Disable it explicitly when needed:

```sh
CLAWMOBILE_COLLECT_TRAJECTORY=0
```

Optional overrides:

- `CLAWMOBILE_TRAJECTORY_DIR`: output directory. Defaults to `recordings/trajectories/` under the run workspace.
- `CLAWMOBILE_TRAJECTORY_ID`: exact output id and filename stem.
- `CLAWMOBILE_TRAJECTORY_TASK_ID`: benchmark task id. Defaults to `unknown_task` when no harness passes one.
- `CLAWMOBILE_TRAJECTORY_INSTRUCTION`: benchmark instruction. Defaults to the run prompt.
- `CLAWMOBILE_TRAJECTORY_SUCCESS`: checker success override, `true` or `false`.
- `CLAWMOBILE_TRAJECTORY_TERMINATION_REASON`: one of `success`, `max_steps`, `crash`, `refused`, `error`, `user_abort`.
- `CLAWMOBILE_TRAJECTORY_CHECKER_OUTPUT`: JSON object from an external checker.
- `CLAWMOBILE_TRAJECTORY_MODEL`: model name override.
- `CLAWMOBILE_TRAJECTORY_MODEL_VERSION`: model version label.

The legacy `OPENCLAW_TRAJECTORY=0` switch is also accepted as a disablement alias.

## Turn Records

Each `turns[]` entry records one PI model inference boundary exposed by the
OpenClaw embedded runner:

```json
{
  "turn_index": 0,
  "actions": ["tap", "type"],
  "error_count": 0,
  "token_usage": { "input": 1820, "output": 64, "cached": 1200 },
  "duration_ms": 2100
}
```

Fields:

- `turn_index`: zero-based sequence number.
- `actions`: tool call names emitted in this turn. No tool call means `[]`.
- `error_count`: failed tool results and tool timeouts in this turn.
- `token_usage`: model response usage. If the runtime does not expose usage, input/output are `0`.
- `duration_ms`: model/runtime turn wall-clock duration when available.

## Rollups

Rollups are computed from `turns`:

- `total_turns = turns.length`
- `total_actions = sum(turn.actions.length)`
- `total_errors = sum(turn.error_count)`
- `total_tokens.input = sum(turn.token_usage.input)`
- `total_tokens.output = sum(turn.token_usage.output)`
- `total_duration_ms = sum(turn.duration_ms)` when any turn has duration

`total_cost_usd` is intentionally omitted until a configurable pricing table is
added.

## Outcome

`termination_reason` describes how the run stopped. `success` is intended to be
provided by an external checker. Until a benchmark harness passes checker data,
the PI integration can be overridden with `CLAWMOBILE_TRAJECTORY_SUCCESS` and
`CLAWMOBILE_TRAJECTORY_CHECKER_OUTPUT`.

Runtime fallback mapping:

- normal completion -> `success`
- timeout/budget stop -> `max_steps`
- abort -> `user_abort`
- prompt/runtime error -> `error`

## Output

The collector writes one file:

```text
recordings/trajectories/<trajectory_id>.json
```

`recordings/` is gitignored by the ClawMobile repository.
