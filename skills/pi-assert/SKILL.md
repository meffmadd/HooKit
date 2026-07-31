---
name: pi-assert
description: Define Shell Assertions and declarative Action Handlers for Pi tool calls, results, turns, settled agents, and cancellable session changes.
---

# pi-assert

`pi-assert` reads sectioned `.pi/asserts.json` files. Use `local` for
hand-written rules and `owner/repo` sections for installed rules. Project
entries override global entries by **source and name**, not name alone.

```json
{
  "$schema": "https://raw.githubusercontent.com/meffmadd/pi-assert/main/schema.json",
  "repos": ["owner/rules"],
  "local": {
    "block-env-write": {
      "description": "Prevent writes to environment files",
      "hook": "tool_call",
      "filter": {
        "toolName": "^write$",
        "path": "(^|/)\\.env.*$"
      },
      "shell": "false"
    },
    "clean-tree": {
      "description": "Require a clean tree after a turn",
      "hook": "agent_end",
      "shell": "git diff --quiet",
      "default": true
    }
  },
  "owner/rules": {
    "redact-secret-result": {
      "description": "Suppress leaked secrets from read results",
      "hook": "tool_result",
      "filter": { "toolName": "^read$" },
      "shell": "grep -q SECRET \"$PI_TOOL_RESULT\" && exit 1 || exit 0"
    }
  }
}
```

## Executable rule fields

Every entry contains exactly one of `shell`, `action`, or `preset`. A Shell
Assertion requires `description`, `hook`, and `shell`; an Action Handler uses
the same trigger fields but replaces `shell` with one structured `action`.

- `hook`: `tool_call`, `tool_result`, `turn_end`, `agent_end`,
  `agent_settled`, `session_before_switch`, `session_before_fork`, or the
  synthetic `assert_result`. Unknown hook names fail loading clearly.
  `session_shutdown` is unsupported because Pi cannot cancel it.
- `filter`: optional object whose keys are implicitly ANDed. Tool candidates
  are `{ ...event.input, toolName }`, with trusted `toolName` taking
  precedence. Lifecycle candidates are bounded records: `turn_end` adds
  `turnIndex`; agent hooks expose `event`; session switch exposes `reason` and
  optional `targetSessionFile`; session fork exposes `entryId` and `position`;
  `assert_result` exposes `event`, `assertionRef`, originating `runId`,
  `outcome`, and `code`.
  Dot-separated keys resolve nested values, so `"request.target.path"` can
  match a deeply nested tool input without `jq`.
  - Every string is a JavaScript regex source tested with `RegExp.test()`
    against a string candidate. The same matcher applies to tool names, paths,
    commands, and other string fields. Escape backslashes for JSON; regex
    literal delimiters and flags are not supported. Invalid patterns fail
    source-qualified configuration loading.
  - Numbers, booleans, and `null` use strict equality without coercion.
  - Arrays mean any-of. String members use regex semantics and non-string
    members use strict equality; an empty array matches nothing.
  - Anchor exact strings: `"^bash$"` matches only `bash`, while unanchored
    `"bash"` also matches `mybash`. This is a migration change from the former
    strict-equality behavior.
- `when`: optional shell precondition. A normal non-zero exit skips the rule.
  For Shell Assertions, timeout, abort, and spawn failure fail closed according
  to hook policy. For Action Handlers, those infrastructure failures report an
  error and skip the action without changing the native outcome.
- `default`: optional boolean; enables the source-qualified entry for a new
  session.

### Action Handlers

An Action Handler requests an effect after hook/filter matching and a successful
optional `when`. It never decides or changes a native Shell Assertion outcome.
Native actions are considered independently of shell fail-fast traversal;
`assert_result` composes a reaction with a specific source-qualified decision.
Handlers and deliveries are ordered and best-effort, so one failure does not
suppress siblings.

```json
{
  "local": {
    "notify-on-block": {
      "description": "Notify another extension about blocked operations",
      "hook": "assert_result",
      "filter": { "outcome": ["block", "patch", "cancel"] },
      "action": {
        "type": "emit-custom-event",
        "name": "my-extension:guard-blocked",
        "data": { "source": "pi-assert" }
      }
    }
  }
}
```

- `interrupt`: no extra fields; requests Pi abort (a harmless no-op when idle).
- `shutdown`: optional boolean `interrupt` (default `false`); when true, abort
  is requested before graceful shutdown. Print mode keeps Pi's shutdown no-op.
- `compact`: optional string `instructions`; fire-and-forget through Pi's normal
  compaction lifecycle.
- `message`: requires string `message` and `delivery` (`steer`, `followUp`, or
  `nextTurn`). Optional `triggerTurn` defaults false and cannot be true with
  `nextTurn`. This creates a visible `pi-assert` custom message, not user input.
- `emit-custom-event`: requires a non-whitespace `name` and accepts optional JSON
  `data`. It uses only `pi.events`, so lifecycle-looking names do not invoke
  native Pi hooks. Prefer namespaced event names.

Action strings/data are static—there is no template, environment, stdout, or
computed-payload expansion. Use one named handler per action and combine them
with presets when needed.

### Shell and precondition environment

Every matching Shell Assertion and every Action Handler `when` receives:

- session: `PI_SESSION_ID`, optional `PI_SESSION_FILE`, optional
  `PI_SESSION_NAME`, and optional `PI_SESSION_LEAF_ID`
- model: optional `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`
- runtime: `PI_MODE` (`tui`, `rpc`, `json`, or `print`) and
  `PI_PROJECT_TRUSTED` (`true` or `false`)
- context usage: optional `PI_CONTEXT_TOKENS`, `PI_CONTEXT_WINDOW`, and
  `PI_CONTEXT_PERCENT`
- invocation: `PI_EVENT`, canonical `PI_ASSERT_REF`, configured
  `PI_ASSERT_HOOK`, fresh UUID `PI_ASSERT_RUN_ID`, and `PI_CWD`

Optional or unknown fields are unset, never empty or stringified
`null`/`undefined`. A Shell Assertion's `when` and main `shell` share the exact
metadata snapshot and run ID. An Action Handler uses one fresh ID for its
optional precondition and action request. Other rules, events, repeated
executions, and retries get
fresh IDs; run IDs are correlation IDs, not idempotency keys.

Tool hooks additionally expose `PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, and JSON
`PI_TOOL_INPUT`; `tool_result` also exposes text `PI_TOOL_RESULT` and
`PI_TOOL_IS_ERROR`. Lifecycle and synthetic hooks expose JSON
`PI_EVENT_PAYLOAD` (the bounded filter candidate). `PI_EVENT` is universal,
including `tool_call` and `tool_result`. Commands execute with `PWD` equal to
`PI_CWD`.

pi-assert removes stale inherited values for all variables it manages before
spawning each shell, while preserving unrelated values such as `PATH` and
`PI_CODING_AGENT`.

## Assertion-result handlers

Use `assert_result` for Shell Assertion logging or Action Handler reactions
after another Shell Assertion decides:

```json
{
  "local": {
    "handle-failures": {
      "description": "Log selected local failures",
      "hook": "assert_result",
      "filter": {
        "assertionRef": "^local/",
        "outcome": ["block", "patch", "cancel", "report"]
      },
      "shell": "./scripts/log-assert-result.sh"
    }
  }
}
```

`assertionRef` is a regex matched against canonical `source/name`; `runId` is
a regex matched against the originating UUID. `outcome` is an exact scalar or
any-of list containing `pass`, `block`, `patch`, `cancel`, or `report`; regex
syntax is not accepted. `code` is matched strictly as a number or `null`. The
bounded JSON payload is
`{ event: "assert_result", assertionRef, runId, outcome, code }`.

A main shell emits one result: `pass` with code `0`, or its hook action with the
non-zero exit code/`null`. A `when` execution failure emits the hook action with
`null`; filter misses and ordinary non-zero `when` skips emit nothing. In a
handler, payload `assertionRef`/`runId` identify the originating rule and run;
the handler's `PI_ASSERT_REF`/`PI_ASSERT_RUN_ID` identify the handler currently
executing and therefore carry a separate run ID. Handlers retain the bounded
session/model/runtime snapshot and are awaited result-major, then in configured
order, without the originating abort signal.
Their failures and action requests cannot change the already-computed
originating decision, and neither handler kind emits recursive results.

## Execution summaries

Each concrete native event that starts a main assertion shell or requests an
action gets one durable, context-neutral transcript entry. Command-only wording
remains `pi-assert ran N command(s) in Xms · <trigger>`; action-only and mixed
summaries say `requested N action(s)`. The shown
key reflects Pi's configured `app.tools.expand` binding (`Ctrl-O` by default).
Expand it to reveal source-qualified refs, `✓`/`✗` status, per-shell durations,
and the tool-call ID for tool events.
Synthetic `assert_result` handler shells and actions are nested with `↳`
beneath the result they handled. Action rows persist only handler identity,
action type, run/hook identity, and origin association—not message text,
instructions, or custom-event data. Actions and preconditions do not count as
commands or contribute command duration.

Filters and ordinary non-zero `when` skips produce no row. A passing `when`
precondition is not counted separately, and an infrastructure failure during
`when` remains on the existing error path without a fictitious main-shell row.
Fail-fast hooks show only reached shells; aggregate hooks show all completed
shells. The entry persists with Pi session history across resume, reload, fork,
and tree navigation but is never sent to the model. Existing block, patch,
cancel, report, corrective, and handler-failure feedback remains separate.
Because Pi appends custom entries rather than attaching them to arbitrary tool
rows, parallel summaries may appear together after a batch; trigger labels and
expanded tool-call IDs disambiguate them. Non-TUI modes receive no duplicate
agent message.

## Presets

A preset has `description`, a `preset` array, and optional boolean `default`;
it cannot contain executable fields. It can reference Shell Assertions and
Action Handlers together. Refs are `local/name` or
`owner/repo/name`.

```json
{
  "local": {
    "safe-defaults": {
      "description": "Enable local and installed write guards",
      "preset": ["local/block-env-write", "owner/rules/protect-env"]
    }
  }
}
```

Use `/asserts` to enable entries, browse repos, install presets and their
members, and edit local presets. `tool_call` and `tool_result` fail fast and
block/patch respectively. `turn_end` and `agent_settled` collect failures and
report only. `agent_end` collects failures and triggers one corrective turn.
Session switch/fork hooks collect failures, cancel the action, and report one
aggregate. `assert_result` is always report-only.
