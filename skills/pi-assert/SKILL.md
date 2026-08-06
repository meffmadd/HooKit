---
name: pi-assert
description: Define shell Assertions with outcome-selected Pi Actions for tool calls, results, turns, settled agents, and cancellable session changes.
---

# pi-assert

Use `.pi/asserts.json` for project policies and `~/.pi/agent/asserts.json` for
global policies. Project storage is used only after Pi trusts the project.

## Assertion shape

Every executable entry is one Assertion. It requires `description`, `hook`, and
at least one of `shell` or `action`. It may contain both. Optional fields are
`filter`, `when`, and `default`.

When `shell` is omitted, pi-assert normalizes it to the canonical command
`"true"`. Boolean shell values and inert entries with neither shell nor Action
are invalid. Exact `"true"` and `"false"` in `shell` or `when` avoid spawning a
subprocess; only those exact strings are optimized. Other strings run through
`/bin/sh`, so pipes, redirects, `&&`, and `||` work normally.

```json
{
  "$schema": "https://raw.githubusercontent.com/meffmadd/pi-assert/main/schema.json",
  "local": {
    "block-dangerous-rm": {
      "description": "Block dangerous recursive removal",
      "hook": "tool_call",
      "filter": {
        "toolName": "^bash$",
        "command": "(^|[;&|\\s])rm\\s+-rf(\\s|$)"
      },
      "shell": "false",
      "action": {
        "type": "message",
        "outcome": "block",
        "code": 1,
        "message": "pi-assert blocked a dangerous removal command.",
        "delivery": "followUp"
      },
      "default": true
    },
    "notify-on-settled": {
      "description": "Emit an extension event whenever settling is allowed",
      "hook": "agent_settled",
      "action": {
        "type": "emit-custom-event",
        "outcome": "pass",
        "name": "example:agent-settled"
      }
    }
  }
}
```

## Hooks and individual outcomes

- `tool_call`: `pass` / `block`
- `tool_result`: `pass` / `patch`
- `turn_end`, `agent_end`, `agent_settled`: `pass` / `report`
- `session_before_switch`, `session_before_fork`: `pass` / `cancel`
- synthetic `assert_result`: local `pass` / `report`

Tool hooks run every matching Assertion sequentially and aggregate all failures
into one block or patch. Lifecycle and session hooks aggregate too. An owned
Action selects only its individual owner result, not the aggregate event. A pass
Action can therefore run even when a sibling fails.

Evaluation order is hook/filter → `when` → effective shell → immutable Assertion
Result → owned Action → `assert_result` Assertions. A filter miss or ordinary
non-zero `when` produces no result or Action. Timeout, abort, or spawn failure
uses code `null` and fails closed. Already-aborted `turn_end` and `agent_end`
Assertions are skipped before traversal.

## Filters

Filters are implicit AND. Strings are JavaScript regular-expression sources;
use `^...$` for exact matching. Numbers, booleans, and `null` match strictly.
Arrays are any-of. Dot-separated keys resolve nested tool input fields.

Tool candidates contain `{ ...event.input, toolName }`. Lifecycle candidates
contain `event` plus documented bounded scalar metadata. `assert_result` filters
are limited to `event`, `assertionRef`, `runId`, `outcome`, and `code`; identity
fields use regex matching while outcome/code match exactly.

`when` is a shell precondition. Ordinary non-zero means “not applicable” and
skips the Assertion. A passing precondition and main shell share one
`PI_ASSERT_RUN_ID`.

## Owned Actions

An Action is optional and singular. It requires `outcome`, either one canonical
outcome or a non-empty list. Optional `code` is one number, `null`, or a
non-empty list. Outcome and code are ANDed; lists are any-of. Pass uses code `0`;
failures use non-zero or `null`. Invalid hook/outcome/code combinations are
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

To request an unconditional native-event Action, omit shell and select `pass`.
It remains one Assertion, runs as optimized canonical `true`, counts as a normal
command, and emits an ordinary `assert_result` event.

## `assert_result`

Use `assert_result` for cross-cutting or reusable reactions. Narrow by
source-qualified ref whenever possible:

```json
{
  "local": {
    "audit-guard-results": {
      "description": "Audit failures from the destructive-rm policy",
      "hook": "assert_result",
      "filter": {
        "assertionRef": "^local/block-dangerous-rm$",
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

For each native result, the origin's Action is considered first, then matching
`assert_result` Assertions in configured Active Assertion Set order. A result
Assertion gets a local pass/report result that may select its own Action. That
local result is never redispatched, so synthetic handling is bounded to one
level. Result Assertions run detached from the originating abort signal and
cannot mutate the origin.

`PI_EVENT_PAYLOAD` for `assert_result` is bounded to:

```text
{ event: "assert_result", assertionRef, runId, outcome, code }
```

## Shell environment

Reached preconditions and shells receive:

- `PI_ASSERT_REF`, `PI_ASSERT_HOOK`, `PI_ASSERT_RUN_ID`
- `PI_EVENT`, `PI_CWD`
- tool hooks: `PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, `PI_TOOL_INPUT`, and for
  results `PI_TOOL_RESULT` / `PI_TOOL_IS_ERROR`
- lifecycle hooks: bounded JSON `PI_EVENT_PAYLOAD`
- captured Pi session/model/provider/reasoning/trust/context metadata when
  available

Managed keys are removed from inherited ambient environment before real shells.
A 5-second timeout bounds shell and precondition execution.

## Presets and repositories

Presets contain one-level qualified Assertion refs (`local/name` or
`owner/repo/name`). Nested Presets are ignored; duplicate Assertions are
source-qualified and deduplicated.

```json
{
  "repos": ["owner/rules"],
  "local": {
    "safe-defaults": {
      "description": "Enable local and installed guards",
      "preset": [
        "local/block-dangerous-rm",
        "owner/rules/protect-secrets"
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
next hook's entry; ordinary hooks append their report immediately. Optimized commands
count and render
normally; preconditions do not count separately. Owned Actions nest beneath
their local result, while synthetic work remains associated with its origin.
Durable Action
rows retain only bounded identity/type/hook/run/outcome/origin metadata—not
message bodies, instructions, event data, rich Pi objects, or storage paths.
