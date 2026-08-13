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

## Enablement

Hooks and Presets can both be enabled directly. Direct Source-plus-name choices
are stored as `enabledEntries` in the current session branch. With no saved
choice, current `default: true` entries are enabled; a saved set, including an
empty set, overrides defaults on resume, reload, tree navigation, fork, and
clone. An enabled Preset stays enabled when references dangle and enables every
available member. The derived Enabled Hook Set is immutable, ordered by first
occurrence, and never contains the same Hook twice across direct and Preset
paths.

## Hook Outcomes and Event Outcomes

- `tool_call`: `pass` / `block`
- `tool_result`: `pass` / `patch`
- `turn_end`, `agent_end`, `agent_settled`: `pass` / `report`
- `session_before_switch`, `session_before_fork`: `pass` / `cancel`
- Hook Result Event `hook_result`: `pass` / `report`

Tool Events run every matching Hook sequentially and aggregate all Hook
Outcomes into one block or patch Event Outcome. Lifecycle and session Events
aggregate too. An owned Action selects only its owner's Hook Outcome and code,
not the Event Outcome. A pass Action can therefore run even when a sibling
fails.

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
are limited to `event`, `hookRef`, `invocationId`, `outcome`, and `code`; identity
fields use regex matching while outcome/code match exactly.

`when` is a shell precondition. Ordinary non-zero means “not applicable” and
skips the Hook. A passing precondition and main shell share one
`PI_HOOK_INVOCATION_ID`.

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

Selectors are removed from the Action Request Effect. Payload text/data is
static: there is no environment, template, event, or stdout expansion. Effect
delivery is ordered and best-effort and cannot alter any already-frozen Event
Outcome.
Multiple message Actions remain distinct; Pi owns steering/follow-up batching.
Broad Actions can cause later Pi events, so avoid accidental continuation loops.

To request an unconditional Action after a Native Event, omit shell and select `pass`.
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
`hook_result` Hooks in configured Enabled Hook Set order. Every origin projects
one Hook Result Event and an explicit pass/report Event Outcome even when no
reactive Hook matches. A matching Hook gets a local pass/report Hook Result that
may select its own Action. That local result is never redispatched, so handling
is bounded to one level. Hooks handling `hook_result` run detached from the
originating abort signal and cannot mutate the frozen Native Event Outcome.

`PI_EVENT_PAYLOAD` for `hook_result` is bounded to:

```text
{ event: "hook_result", hookRef, invocationId, outcome, code }
```

## Shell environment

Reached preconditions and shells receive:

- `PI_HOOK_REF`, `PI_HOOK_EVENT`, `PI_HOOK_INVOCATION_ID`
- `PI_EVENT`, `PI_CWD`
- tool events: `PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, `PI_TOOL_INPUT`, and for
  results `PI_TOOL_RESULT` / `PI_TOOL_IS_ERROR`
- lifecycle events: bounded JSON `PI_EVENT_PAYLOAD`
- captured Pi session/model/provider/reasoning/trust/context metadata when
  available

Managed keys are removed from inherited ambient environment before real shells.
A 5-second timeout bounds shell and precondition execution.

## Presets and repositories

Presets contain unique qualified Hook References (`local/name` or
`owner/repo/name`). Catalog Entry names are non-empty and contain neither `/`
nor NUL. Unresolved references remain valid and dangling; a reference resolving
to another installed Preset makes the Catalog invalid until nesting is
supported.

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

A Hook Evaluation returns one deeply immutable Hook Evaluation Outcome: a
non-empty ordered `eventOutcomes` sequence (Native Event first), ordered
Effects, and an optional Evaluation Report. Every Event that records a main
command or requests an Action is observed; Filter misses, false Preconditions,
and presentation/control Effects alone create no Evaluation Report.
Consecutive Hook Evaluations for `tool_call` or `tool_result` in one Execution
Wave contribute only their Evaluation Reports to a single bounded Execution
Report—Event Outcomes remain separate. The report flushes at the next Event's
entry; ordinary Events append their report immediately. Optimized commands
count and render
normally; preconditions do not count separately. Rows stay flat in Hook
Evaluation order; reactive work carries an inline `from` origin annotation.
Durable rows retain bounded Hook refs, outcomes, Action types, pass/fail state,
and durations—not invocation IDs, message bodies, instructions, event data,
rich Pi objects, Event Outcomes, or storage paths. Execution Duration includes
Hook Evaluation plus every ordered best-effort Effect delivery attempt;
incomplete tool lifecycles receive no invented duration or report.
