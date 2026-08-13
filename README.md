# HooKit

Hooks for Pi events. A **Hook** runs a shell decision against a Pi **Event**
(`tool_call`, `turn_end`, ...) and may own one outcome-selected Pi **Action**.
Configuration lives in `.pi/hookit.json`; `/hooks` manages installation,
enablement, defaults, Presets, and search.

## Configuration

Project configuration is `.pi/hookit.json`. Global configuration is
`~/.pi/agent/hookit.json`. Project entries are read only after Pi trusts the
project. `local` contains authored entries; `owner/repo` sections contain
installed entries; `repos` lists repositories available to the installer.

```json
{
  "$schema": "https://raw.githubusercontent.com/meffmadd/HooKit/main/schema.json",
  "repos": ["owner/repo"],
  "local": {
    "protect-env": {
      "description": "Block writes to dotenv files",
      "event": "tool_call",
      "filter": {
        "toolName": "^write$",
        "path": "(^|/)\\.env$"
      },
      "shell": "false",
      "action": {
        "type": "message",
        "outcome": "block",
        "code": 1,
        "message": "A dotenv write was blocked by HooKit.",
        "delivery": "followUp"
      },
      "default": true
    },
    "announce-settled": {
      "description": "Notify another extension after the agent settles",
      "event": "agent_settled",
      "action": {
        "type": "emit-custom-event",
        "outcome": "pass",
        "name": "example:agent-settled",
        "data": { "source": "HooKit" }
      }
    }
  },
  "owner/repo": {
    "clean-turn": {
      "description": "Require a clean worktree after each turn",
      "event": "turn_end",
      "shell": "git diff --quiet"
    }
  }
}
```

An executable entry is always a **Hook**:

- `description` and `event` are required.
- At least one of `shell` or `action` is required. They may be used together.
- Omitted `shell` is normalized to the canonical string `"true"` before the
  entry enters the Hook Catalog.
- `filter`, `when`, and `default` are optional.
- `action` is optional and singular.
- A Preset uses `description`, `preset`, and optional `default`; it cannot carry
  executable fields.
- Catalog Entry names are non-empty and contain neither `/` nor NUL.
- Hook References within one Preset are unique.

Boolean shell values are invalid. An entry with neither shell nor Action is
invalid. Standalone Action records without `outcome` are invalid.

## Enablement and evaluation

Hooks and Presets can both be enabled directly. HooKit persists those direct
Source-plus-name choices as `enabledEntries` in the current session branch. A
new session with no saved choice derives enablement from current
`default: true` entries; a saved set, including an empty set, overrides defaults
on resume, reload, tree navigation, fork, and clone. Presets remain enabled when
some references dangle and enable every currently available member. `/hooks`
counts directly enabled Catalog Entries and shows an indirectly enabled member
as `enabled · via <preset>`.

For each Event, HooKit derives and captures one immutable Enabled Hook Set plus
one bounded callback metadata snapshot. Catalog Entry order and Preset reference
order determine first occurrence; direct and multiple Preset paths never execute
a Hook twice. Matching Hooks run sequentially in that deterministic set order:

1. Match the Hook's `event` and `filter`.
2. Run optional `when`.
3. Run the effective `shell` and create one immutable individual Hook
   Result.
4. Match the owned Action against that individual result.
5. Expose the result to configured `hook_result` Hooks.

A filter miss runs nothing. An ordinary non-zero `when` skips the shell, result,
Action, and execution entry. A precondition timeout, abort, or spawn failure
fails closed with code `null`, so an owned failure Action can select it.

The aggregate native outcome is frozen before Actions or `hook_result`
Hooks run. Delivery cannot weaken a block, patch, cancellation, or report.
Actions are returned as immutable delivery-neutral requests and delivered by
the thin Pi adapter in order, best-effort.

### Shell shortcuts

Exact `shell` strings `"true"` and `"false"` are optimized without spawning a
subprocess. They still behave and render as ordinary commands:

- exact `"true"` → pass, code `0`
- exact `"false"` → event-specific failure, code `1`

The same shortcut applies to exact `when` strings. No trimming or parsing is
performed: `" true"`, `"true "`, `"true && echo ok"`, and every other string
still execute through the real local shell. Pipes, redirects, `&&`, and `||`
therefore retain normal `/bin/sh` behavior.

Shortcuts honor an already-aborted signal. Already-aborted `turn_end` and
`agent_end` evaluations skip Hooks before traversal. Abort after a real
shell starts yields code `null` and the event-specific failure outcome.

## Events and outcomes

| Event | Individual result | Aggregate native behavior |
|---|---|---|
| `tool_call` | `pass` or `block` | Runs all matches; aggregates failures into one block |
| `tool_result` | `pass` or `patch` | Runs all matches; aggregates failures into one replacement patch |
| `turn_end` | `pass` or `report` | Aggregates and presents failures |
| `agent_end` | `pass` or `report` | Aggregates; requests one deduplicated corrective turn |
| `agent_settled` | `pass` or `report` | Aggregates and presents failures |
| `session_before_switch` | `pass` or `cancel` | Aggregates and cancels on failure |
| `session_before_fork` | `pass` or `cancel` | Aggregates and cancels on failure |
| `hook_result` | local `pass` or `report` | Handles one originating result; cannot alter it |

All tool Hooks run even after one fails. An Action observes only its
owner's individual result, not the aggregate: a passing Hook may request a
pass Action even when a sibling blocks the event.

## Owned Actions

Every Action requires `outcome`. It accepts one outcome or a non-empty list.
Optional `code` accepts one number, `null`, or a non-empty list. Fields are
ANDed; array members are any-of and matching is strict. The same matching
implementation handles `outcome` and `code` in `hook_result` filters.

Validation rejects outcomes impossible for the configured event and selectors
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
events, so broad Hooks can create continuation loops.

A Hook that should run unconditionally after a native event can omit shell
and select `pass`; it becomes an optimized canonical `shell: "true"` Hook.
It still emits an ordinary `hook_result` event.

## Filters and `hook_result`

Filters are implicit AND across fields. String values are JavaScript regular
expression sources; anchor them with `^`/`$` for exact matching. Numbers,
booleans, and `null` use strict equality. Arrays are any-of. Dot-separated keys
resolve nested tool input fields.

Tool candidates are `{ ...event.input, toolName }`. Lifecycle candidates expose
only documented bounded scalars. `hook_result` exposes:

```text
{ event: "hook_result", hookRef, runId, outcome, code }
```

Its filter is limited to `event`, source-qualified `hookRef`, `runId`,
`outcome`, and `code`. Identity fields use regex matching; outcome/code use the
exact selector semantics above.

```json
{
  "local": {
    "audit-blocks": {
      "description": "Audit every block from local/protect-env",
      "event": "hook_result",
      "filter": {
        "hookRef": "^local/protect-env$",
        "outcome": "block",
        "code": [1, null]
      },
      "shell": "./scripts/audit-hook-result.sh",
      "action": {
        "type": "emit-custom-event",
        "outcome": ["pass", "report"],
        "name": "example:hook-audited"
      }
    }
  }
}
```

For each originating Hook Result, its owned Action is considered first, followed by
configured `hook_result` Hooks in Enabled Hook Set order. A matching Hook gets
its own local pass/report result and may select its own Action. That local
result is never redispatched, bounding synthetic handling to one level.
Origin identity remains available separately for accounting and shell
environment projection.

## Shell environment

Every reached `when` and main shell receives inherited environment plus bounded
Pi metadata and invocation fields:

- `PI_HOOK_REF`, `PI_HOOK_EVENT`, `PI_HOOK_RUN_ID`
- `PI_EVENT`, `PI_CWD`
- tool events: `PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, `PI_TOOL_INPUT`; tool results
  also receive `PI_TOOL_RESULT` and `PI_TOOL_IS_ERROR`
- lifecycle events: bounded JSON `PI_EVENT_PAYLOAD`
- captured metadata such as session, model, provider, reasoning, trust, and
  context-window values when available

A `when` and its main shell share one run ID. Owned Actions share that same
source-qualified ref and run ID. Managed keys are cleared from the ambient
environment before each real shell so stale parent values cannot leak in.

## Presets, sources, and updates

Presets contain unique qualified Hook References (`local/name` or
`owner/repo/name`) and expand in reference order. Unresolved references remain
valid and dangling. A reference that resolves to another installed Preset makes
the complete Catalog invalid until nested Presets are supported.

```json
{
  "local": {
    "guarded-workflow": {
      "description": "Enable the local and repository policies together",
      "preset": [
        "local/protect-env",
        "owner/repo/clean-turn"
      ],
      "default": true
    }
  }
}
```

Trusted project entries replace global entries only when source and name both
match, and whole records replace rather than field-merging. Repository install
and update canonicalize omitted shell to `"true"`. Content comparison includes
description, event, canonical shell, owned Action, filter, and precondition,
but excludes local `default` preference. Updates preserve that preference.

## Execution summaries

A durable context-neutral transcript entry is appended when at least one
Hook row or one requested Action is recorded. Tool calls and their
results in one tool execution lifecycle join one combined Execution Wave with a
single end-to-end duration; ordinary Hook Evaluations append immediately. Exact `true`/`false`
shortcuts count as normal commands with normal duration presentation. Passing
preconditions are not counted separately; a `when` infrastructure failure
before the main command does not invent a command row (only a selected Action
stands alone).

Expanded summaries show source-qualified Hook refs, pass/fail status,
individual `when` + `shell` duration, and requested Action type, rendered flat
in Hook Evaluation order with `from <ref> <outcome>` annotations on synthetic
rows — no causal nesting. Action rows show type and owner outcome. Persisted
report rows contain only bounded identity and outcome data; invocation
identity (`runId`), row-level event, Action payload text, shell command text,
rich callback objects, and storage paths are not persisted.

## Commands and trust

- `/hooks` opens enablement, search, Preset, default, remove, and install UI.
- Installed repository entries are updateable and removable like local entries.
- Orphaned repository entries are marked when repository lookup succeeds.
- Untrusted project storage is neither read nor written.

Treat repository hooks as executable code: ordinary shell strings run locally
with your Pi process permissions. The 5-second default timeout bounds commands
and preconditions but is not a sandbox.
