---
name: pi-assert
description: Define shell assertions and result handlers for Pi tool calls, results, turns, settled agents, and cancellable session changes.
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

## Assert fields

Every shell assert requires `description`, `hook`, and `shell`.

- `hook`: `tool_call`, `tool_result`, `turn_end`, `agent_end`,
  `agent_settled`, `session_before_switch`, `session_before_fork`, or the
  synthetic `assert_result`. Unknown hook names fail loading clearly.
  `session_shutdown` is unsupported because Pi cannot cancel it.
- `filter`: optional object whose keys are implicitly ANDed. Tool candidates
  are `{ ...event.input, toolName }`, with trusted `toolName` taking
  precedence. Lifecycle candidates are bounded records: `turn_end` adds
  `turnIndex`; agent hooks expose `event`; session switch exposes `reason` and
  optional `targetSessionFile`; session fork exposes `entryId` and `position`;
  `assert_result` exposes `event`, `assertionRef`, `outcome`, and `code`.
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
- `when`: optional shell precondition. A normal non-zero exit skips the rule;
  timeout, abort, and spawn failure fail closed for guard hooks.
- `default`: optional boolean; enables the source-qualified entry for a new
  session.

Commands execute with `PWD` equal to `PI_CWD`. Tool hooks expose
`PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, `PI_TOOL_INPUT`, and `PI_CWD`; `tool_result`
also exposes `PI_TOOL_RESULT` and `PI_TOOL_IS_ERROR`. Lifecycle and synthetic
hooks expose `PI_EVENT`, JSON `PI_EVENT_PAYLOAD` (the bounded filter candidate),
and `PI_CWD`.

## Assertion-result handlers

Use `assert_result` for report-only handling after another assertion decides:

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

`assertionRef` is a regex matched against canonical `source/name`. `outcome` is
an exact scalar or any-of list containing `pass`, `block`, `patch`, `cancel`,
or `report`; regex syntax is not accepted. `code` is matched strictly as a
number or `null`. The bounded JSON payload is
`{ event: "assert_result", assertionRef, outcome, code }`.

A main shell emits one result: `pass` with code `0`, or its hook action with the
non-zero exit code/`null`. A `when` execution failure emits the hook action with
`null`; filter misses and ordinary non-zero `when` skips emit nothing. Handlers
are awaited in order without the originating abort signal. Their failures are
reported but cannot change the already-computed originating decision, and they
never emit recursive results.

## Presets

A preset has `description`, a `preset` array, and optional boolean `default`;
it cannot contain shell-assert fields. Refs are `local/name` or
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
