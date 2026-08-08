# pi-assert

Assertions for Pi hook events. An Assertion runs a shell decision and may own one
outcome-selected Pi Action. Configuration lives in `asserts.json`; `/asserts`
manages installation, activation, defaults, Presets, and search.

## Configuration

Project configuration is `.pi/asserts.json`. Global configuration is
`~/.pi/agent/asserts.json`. Project entries are read only after Pi trusts the
project. `local` contains authored entries; `owner/repo` sections contain
installed entries; `repos` lists repositories available to the installer.

```json
{
  "$schema": "https://raw.githubusercontent.com/meffmadd/pi-assert/main/schema.json",
  "repos": ["owner/rules"],
  "local": {
    "protect-env": {
      "description": "Block writes to dotenv files",
      "hook": "tool_call",
      "filter": {
        "toolName": "^write$",
        "path": "(^|/)\\.env$"
      },
      "shell": "false",
      "action": {
        "type": "message",
        "outcome": "block",
        "code": 1,
        "message": "A dotenv write was blocked by pi-assert.",
        "delivery": "followUp"
      },
      "default": true
    },
    "announce-settled": {
      "description": "Notify another extension after the agent settles",
      "hook": "agent_settled",
      "action": {
        "type": "emit-custom-event",
        "outcome": "pass",
        "name": "example:agent-settled",
        "data": { "source": "pi-assert" }
      }
    }
  },
  "owner/rules": {
    "clean-turn": {
      "description": "Require a clean worktree after each turn",
      "hook": "turn_end",
      "shell": "git diff --quiet"
    }
  }
}
```

An executable entry is always an **Assertion**:

- `description` and `hook` are required.
- At least one of `shell` or `action` is required. They may be used together.
- Omitted `shell` is normalized to the canonical string `"true"` before the
  entry enters the Assertion Catalog.
- `filter`, `when`, and `default` are optional.
- `action` is optional and singular.
- A Preset uses `description`, `preset`, and optional `default`; it cannot carry
  executable fields.

Boolean shell values are invalid. An entry with neither shell nor Action is
invalid. Standalone Action records without `outcome` are invalid.

## Evaluation pipeline

For each event, pi-assert captures one immutable Active Assertion Set and one
bounded callback metadata snapshot. Matching Assertions run sequentially in
that deterministic set order:

1. Match the Assertion's hook and `filter`.
2. Run optional `when`.
3. Run the effective `shell` and create one immutable individual Assertion
   Result.
4. Match the owned Action against that individual result.
5. Expose the result to configured `assert_result` Assertions.

A filter miss runs nothing. An ordinary non-zero `when` skips the shell, result,
Action, and execution entry. A precondition timeout, abort, or spawn failure
fails closed with code `null`, so an owned failure Action can select it.

The aggregate native outcome is frozen before Actions or `assert_result`
Assertions run. Delivery cannot weaken a block, patch, cancellation, or report.
Actions are returned as immutable delivery-neutral requests and delivered by
the thin Pi adapter in order, best-effort.

### Shell shortcuts

Exact `shell` strings `"true"` and `"false"` are optimized without spawning a
subprocess. They still behave and render as ordinary commands:

- exact `"true"` → pass, code `0`
- exact `"false"` → hook-specific failure, code `1`

The same shortcut applies to exact `when` strings. No trimming or parsing is
performed: `" true"`, `"true "`, `"true && echo ok"`, and every other string
still execute through the real local shell. Pipes, redirects, `&&`, and `||`
therefore retain normal `/bin/sh` behavior.

Shortcuts honor an already-aborted signal. Already-aborted `turn_end` and
`agent_end` evaluations skip Assertions before traversal. Abort after a real
shell starts yields code `null` and the hook-specific failure outcome.

## Hooks and outcomes

| Hook | Individual result | Aggregate native behavior |
|---|---|---|
| `tool_call` | `pass` or `block` | Runs all matches; aggregates failures into one block |
| `tool_result` | `pass` or `patch` | Runs all matches; aggregates failures into one replacement patch |
| `turn_end` | `pass` or `report` | Aggregates and presents failures |
| `agent_end` | `pass` or `report` | Aggregates; requests one deduplicated corrective turn |
| `agent_settled` | `pass` or `report` | Aggregates and presents failures |
| `session_before_switch` | `pass` or `cancel` | Aggregates and cancels on failure |
| `session_before_fork` | `pass` or `cancel` | Aggregates and cancels on failure |
| `assert_result` | local `pass` or `report` | Handles one originating result; cannot alter it |

All tool Assertions run even after one fails. An Action observes only its
owner's individual result, not the aggregate: a passing Assertion may request a
pass Action even when a sibling blocks the event.

## Owned Actions

Every Action requires `outcome`. It accepts one outcome or a non-empty list.
Optional `code` accepts one number, `null`, or a non-empty list. Fields are
ANDed; array members are any-of and matching is strict. The same matching
implementation handles `outcome` and `code` in `assert_result` filters.

Validation rejects outcomes impossible for the configured hook and selectors
with no possible outcome/code pairing. Pass results use code `0`; failure
results use a non-zero code or `null`.

`outcome` and `code` select the result; they are removed from the delivered
Action Request. Supported payloads are:

| `type` | Payload |
|---|---|
| `interrupt` | Calls Pi's supported abort operation |
| `shutdown` | Optional `interrupt: true`, then graceful Pi shutdown |
| `compact` | Optional static `instructions` passed to Pi compaction |
| `message` | Static `message`, `delivery` (`steer`, `followUp`, or `nextTurn`), and optional `triggerTurn` (`true` is invalid with `nextTurn`) |
| `emit-custom-event` | Non-empty event `name` and optional JSON `data` |

Action strings and data are static. They do not interpolate environment
variables, templates, shell output, or event fields. Multiple message requests
stay distinct; Pi's steering and follow-up settings own batching. Message,
compact, interrupt, and shutdown Actions can intentionally cause later Pi
events, so broad rules can create continuation loops.

An Action that should run unconditionally after a native event can omit shell
and select `pass`; it becomes an optimized canonical `shell: "true"` Assertion.
It still emits an ordinary `assert_result` event.

## Filters and `assert_result`

Filters are implicit AND across fields. String values are JavaScript regular
expression sources; anchor them with `^`/`$` for exact matching. Numbers,
booleans, and `null` use strict equality. Arrays are any-of. Dot-separated keys
resolve nested tool input fields.

Tool candidates are `{ ...event.input, toolName }`. Lifecycle candidates expose
only documented bounded scalars. `assert_result` exposes:

```text
{ event: "assert_result", assertionRef, runId, outcome, code }
```

Its filter is limited to `event`, source-qualified `assertionRef`, `runId`,
`outcome`, and `code`. Identity fields use regex matching; outcome/code use the
exact selector semantics above.

```json
{
  "local": {
    "audit-blocks": {
      "description": "Audit every block from local/protect-env",
      "hook": "assert_result",
      "filter": {
        "assertionRef": "^local/protect-env$",
        "outcome": "block",
        "code": [1, null]
      },
      "shell": "./scripts/audit-assert-result.sh",
      "action": {
        "type": "emit-custom-event",
        "outcome": ["pass", "report"],
        "name": "example:assert-audited"
      }
    }
  }
}
```

For each native result, its owned Action is considered first, followed by
configured `assert_result` Assertions in Active Assertion Set order. A result
Assertion gets its own local pass/report result and may select its own Action.
That local result is never redispatched, bounding synthetic handling to one
level. Origin identity remains available separately for accounting and shell
environment projection.

## Shell environment

Every reached `when` and main shell receives inherited environment plus bounded
Pi metadata and invocation fields:

- `PI_ASSERT_REF`, `PI_ASSERT_HOOK`, `PI_ASSERT_RUN_ID`
- `PI_EVENT`, `PI_CWD`
- tool hooks: `PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, `PI_TOOL_INPUT`; tool results
  also receive `PI_TOOL_RESULT` and `PI_TOOL_IS_ERROR`
- lifecycle hooks: bounded JSON `PI_EVENT_PAYLOAD`
- captured metadata such as session, model, provider, reasoning, trust, and
  context-window values when available

A `when` and its main shell share one run ID. Owned Actions share that same
source-qualified ref and run ID. Managed keys are cleared from the ambient
environment before each real shell so stale parent values cannot leak in.

## Presets, sources, and updates

Presets contain qualified refs (`local/name` or `owner/repo/name`) and expand one
level in ref order. They reference Assertions uniformly; nested Presets are not
expanded. Duplicate members are removed by source-qualified identity.

```json
{
  "local": {
    "guarded-workflow": {
      "description": "Enable the local and repository policies together",
      "preset": [
        "local/protect-env",
        "owner/rules/clean-turn"
      ],
      "default": true
    }
  }
}
```

Trusted project entries replace global entries only when source and name both
match, and whole records replace rather than field-merging. Repository install
and update canonicalize omitted shell to `"true"`. Content comparison includes
description, hook, canonical shell, owned Action, filter, and precondition, but
excludes local `default` preference. Updates preserve that preference.

## Execution summaries

A durable context-neutral transcript entry is appended when at least one
Assertion row or one requested Action is recorded. Tool calls and their
results for one Pi tool batch join one combined Execution Wave with a single
end-to-end duration; ordinary hooks append immediately. Exact `true`/`false`
shortcuts count as normal commands with normal duration presentation. Passing
preconditions are not counted separately; a `when` infrastructure failure
before the main command does not invent a command row (only a selected Action
stands alone).

Expanded summaries show source-qualified Assertion refs, pass/fail status,
individual `when` + `shell` duration, and requested Action type, rendered flat
in Hook Evaluation order with `from <ref> <outcome>` annotations on synthetic
rows — no causal nesting. Action rows show type and owner outcome. Persisted
report rows contain only bounded identity and outcome data; invocation
identity (`runId`), row-level hook, Action payload text, shell command text,
rich callback objects, and storage paths are not persisted.

## Commands and trust

- `/asserts` opens activation, search, Preset, default, remove, and install UI.
- Installed repository entries are updateable and removable like local entries.
- Orphaned repository entries are marked when repository lookup succeeds.
- Untrusted project storage is neither read nor written.

Treat repository rules as executable code: ordinary shell strings run locally
with your Pi process permissions. The 5-second default timeout bounds commands
and preconditions but is not a sandbox.
