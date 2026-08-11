---
name: hookit
description: Define Hooks with outcome-selected Pi Actions for tool calls, results, turns, settled agents, and cancellable session changes.
---

# HooKit

Use `.pi/hookit.json` for project policies and `~/.pi/agent/hookit.json` for
global policies. Project storage is used only after Pi trusts the project.

## Hook shape

Every executable entry is one Hook. It requires `description`, `event`, and
at least one of `shell` or `action`. It may contain both. Optional fields are
`filter`, `when`, and `default`.

When `shell` is omitted, HooKit normalizes it to the canonical command
`"true"`. Boolean shell values and inert entries with neither shell nor Action
are invalid. Exact `"true"` and `"false"` in `shell` or `when` avoid spawning a
subprocess; only those exact strings are optimized. Other strings run through
`/bin/sh`, so pipes, redirects, `&&`, and `||` work normally.

```json
{
  "$schema": "https://raw.githubusercontent.com/meffmadd/HooKit/main/schema.json",
  "local": {
    "block-dangerous-rm": {
      "description": "Block dangerous recursive removal",
      "event": "tool_call",
      "filter": {
        "toolName": "^bash$",
        "command": "(^|[;&|\\s])rm\\s+-rf(\\s|$)"
      },
      "shell": "false",
      "action": {
        "type": "message",
        "outcome": "block",
        "code": 1,
        "message": "HooKit blocked a dangerous removal command.",
        "delivery": "followUp"
      },
      "default": true
    },
    "notify-on-settled": {
      "description": "Emit an extension event whenever settling is allowed",
      "event": "agent_settled",
      "action": {
        "type": "emit-custom-event",
        "outcome": "pass",
        "name": "example:agent-settled"
      }
    }
  }
}
```

## Events and individual outcomes

- `tool_call`: `pass` / `block`
- `tool_result`: `pass` / `patch`
- `turn_end`, `agent_end`, `agent_settled`: `pass` / `report`
- `session_before_switch`, `session_before_fork`: `pass` / `cancel`
- synthetic `hook_result`: local `pass` / `report`

Tool events run every matching Hook sequentially and aggregate all failures
into one block or patch. Lifecycle and session events aggregate too. An owned
Action selects only its individual owner result, not the aggregate event. A pass
Action can therefore run even when a sibling fails.

Evaluation order is event/filter → `when` → effective shell → immutable Hook
Result → owned Action → `hook_result` Hooks. A filter miss or ordinary
non-zero `when` produces no result or Action. Timeout, abort, or spawn failure
uses code `null` and fails closed. Already-aborted `turn_end` and `agent_end`
Hooks are skipped before traversal.

## Filters

Filters are implicit AND. Strings are JavaScript regular-expression sources;
use `^...$` for exact matching. Numbers, booleans, and `null` match strictly.
Arrays are any-of. Dot-separated keys resolve nested tool input fields.

Tool candidates contain `{ ...event.input, toolName }`. Lifecycle candidates
contain `event` plus documented bounded scalar metadata. `hook_result` filters
are limited to `event`, `hookRef`, `runId`, `outcome`, and `code`; identity
fields use regex matching while outcome/code match exactly.

`when` is a shell precondition. Ordinary non-zero means “not applicable” and
skips the Hook. A passing precondition and main shell share one
`PI_HOOK_RUN_ID`.

## Owned Actions

An Action is optional and singular. It requires `outcome`, either one canonical
outcome or a non-empty list. Optional `code` is one number, `null`, or a
non-empty list. Outcome and code are ANDed; lists are any-of. Pass uses code `0`;
failures use non-zero or `null`. Invalid event/outcome/code combinations are
rejected.

Supported payloads:

- `interrupt`
- `shutdown`, optional `interrupt`
- `compact`, optional static `instructions`
- `message`, with static `message`, `delivery` (`steer`, `followUp`, or
  `nextTurn`), and optional `triggerTurn`
- `emit-custom-event`, with non-empty `name` and optional JSON `data`

Selectors are removed from the delivery request. Payload text/data is static:
there is no environment, template, event, or stdout expansion. Action delivery
is ordered and best-effort and cannot alter the already-frozen native outcome.
Multiple message Actions remain distinct; Pi owns steering/follow-up batching.
Broad Actions can cause later Pi events, so avoid accidental continuation loops.

To request an unconditional Action after a native Event, omit shell and select `pass`.
It remains one Hook, runs as optimized canonical `true`, counts as a normal
command, and emits an ordinary `hook_result` event.

## `hook_result`

Use `hook_result` for cross-cutting or reusable reactions. Narrow by
source-qualified ref whenever possible:

```json
{
  "local": {
    "audit-guard-results": {
      "description": "Audit failures from the destructive-rm policy",
      "event": "hook_result",
      "filter": {
        "hookRef": "^local/block-dangerous-rm$",
        "outcome": "block",
        "code": [1, null]
      },
      "shell": "./scripts/audit-guard-result.sh",
      "action": {
        "type": "emit-custom-event",
        "outcome": ["pass", "report"],
        "name": "example:audit-finished"
      }
    }
  }
}
```

For each originating Hook Result, the origin's Action is considered first, then matching
`hook_result` Hooks in configured Active Hook Set order. A matching Hook gets
a local pass/report result that may select its own Action. That local result is
never redispatched, so synthetic handling is bounded to one level. Hooks
handling `hook_result` run detached from the originating abort signal and cannot
mutate the origin.

`PI_EVENT_PAYLOAD` for `hook_result` is bounded to:

```text
{ event: "hook_result", hookRef, runId, outcome, code }
```

## Shell environment

Reached preconditions and shells receive:

- `PI_HOOK_REF`, `PI_HOOK_EVENT`, `PI_HOOK_RUN_ID`
- `PI_EVENT`, `PI_CWD`
- tool events: `PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, `PI_TOOL_INPUT`, and for
  results `PI_TOOL_RESULT` / `PI_TOOL_IS_ERROR`
- lifecycle events: bounded JSON `PI_EVENT_PAYLOAD`
- captured Pi session/model/provider/reasoning/trust/context metadata when
  available

Managed keys are removed from inherited ambient environment before real shells.
A 5-second timeout bounds shell and precondition execution.

## Presets and repositories

Presets contain one-level qualified Hook refs (`local/name` or
`owner/repo/name`). Nested Presets are ignored; duplicate Hooks are
source-qualified and deduplicated.

```json
{
  "repos": ["owner/hooks"],
  "local": {
    "safe-defaults": {
      "description": "Enable local and installed guards",
      "preset": [
        "local/block-dangerous-rm",
        "owner/hooks/protect-secrets"
      ],
      "default": true
    }
  }
}
```

Repository install/update canonicalizes omitted shell to `"true"`. Outdated
comparison includes canonical shell and the owned Action but excludes local
`default`, which updates preserve.

## Reporting

Every event that records a main command or requests an Action is observed.
Consecutive Hook Evaluations for `tool_call` or `tool_result` in one Execution
Wave are combined into a single bounded Execution Report that flushes at the
next event's entry; ordinary events append their report immediately. Optimized commands
count and render
normally; preconditions do not count separately. Rows stay flat in Hook
Evaluation order; synthetic work carries an inline `from` origin annotation.
Durable rows retain bounded Hook refs, outcomes, Action types, pass/fail state,
and durations—not invocation IDs, message bodies, instructions, event data,
rich Pi objects, or storage paths.
