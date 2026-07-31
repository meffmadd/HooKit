# pi-assert

Shell assertions and declarative Action Handlers for Pi tool and lifecycle
events. Rules are loaded from project `.pi/asserts.json` and global
`~/.pi/asserts.json`; a project entry overrides a
global entry only when both its **source section and name** match.

## Quick start

```bash
pi install ./path/to/pi-assert
```

Create `.pi/asserts.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/meffmadd/pi-assert/main/schema.json",
  "local": {
    "unmodified": {
      "description": "Block direct writes",
      "hook": "tool_call",
      "filter": { "toolName": "^write$" },
      "shell": "false"
    },
    "no-rm-rf": {
      "description": "Block dangerous shell removal",
      "hook": "tool_call",
      "filter": {
        "toolName": "^bash$",
        "command": "(^|[;&|]\\s*)rm\\s+-rf(?:\\s|$)"
      },
      "shell": "false"
    }
  }
}
```

## Format

The top-level object is sectioned by source. `local` contains hand-written
rules; an `owner/repo` section contains installed rules. `repos` declares repo
sources available to the installer.

```json
{
  "repos": ["owner/rules"],
  "local": {
    "check-tree": {
      "description": "Require a clean tree at turn end",
      "hook": "agent_end",
      "shell": "git diff --quiet",
      "default": true
    }
  },
  "owner/rules": {
    "hide-secrets": {
      "description": "Redact secret-looking read results",
      "hook": "tool_result",
      "filter": { "toolName": "^read$" },
      "shell": "grep -q SECRET \"$PI_TOOL_RESULT\" && exit 1 || exit 0"
    }
  }
}
```

Every entry contains exactly one of `shell`, `action`, or `preset`. Shell
Assertions require `description`, a supported `hook`, and `shell`. Action
Handlers replace `shell` with one structured `action`. Both executable kinds
support optional `filter`, `when`, and boolean `default`. Presets replace the
executable field with a `preset` array.

For a Shell Assertion, `when` only skips on an ordinary non-zero exit—timeouts
and execution failures apply the hook's fail-closed policy. For an Action
Handler, ordinary non-zero also skips, but timeout, abort, or spawn failure is
reported and the action is not requested; a precondition can never create a
native block, patch, cancellation, or report outcome. Shells and preconditions
run with `PWD` and `PI_CWD` set to the Pi project directory.

Supported hooks are `tool_call`, `tool_result`, `turn_end`, `agent_end`,
`agent_settled`, `session_before_switch`, `session_before_fork`, and the
synthetic `assert_result` hook. Unknown hook names fail configuration loading
with the supported list. `session_shutdown` is intentionally unsupported
because Pi does not provide a way for an extension to cancel shutdown.

### Action Handlers

An Action Handler requests an effect after its hook and filter match and its
optional `when` exits successfully. It does not decide the hook's native
outcome. Native-hook actions are considered in Active Assertion Set order in a
separate reaction phase, even when a Shell Assertion failed fast. One bad
handler or delivery does not suppress later handlers, and action failures
cannot weaken a block, patch, cancellation, report, or pass.

```json
{
  "local": {
    "notify-on-block": {
      "description": "Ask for a follow-up after a local guard blocks",
      "hook": "assert_result",
      "filter": {
        "assertionRef": "^local/",
        "outcome": "block"
      },
      "action": {
        "type": "message",
        "message": "A local guard blocked an operation. Review the reason.",
        "delivery": "followUp"
      }
    }
  }
}
```

Supported actions:

| `action.type` | Fields and behavior |
| --- | --- |
| `interrupt` | No additional fields. Calls Pi's supported abort operation; harmless when idle. |
| `shutdown` | Optional `interrupt` boolean (default `false`). When true, abort is requested before graceful shutdown. Pi defers shutdown until supported and treats it as a no-op in print mode. |
| `compact` | Optional string `instructions`, passed as Pi custom compaction instructions. The request is fire-and-forget; asynchronous failure is reported separately. |
| `message` | Requires string `message` and `delivery`: `steer`, `followUp`, or `nextTurn`. Optional `triggerTurn` defaults to `false`; it cannot be true with `nextTurn`. Sends a visible `pi-assert` custom message, never impersonated user input. |
| `emit-custom-event` | Requires a non-whitespace `name` and accepts optional JSON `data`. Emits only through `pi.events`; even a lifecycle-looking name cannot forge a native Pi hook. Namespaced names are recommended. |

Action fields are static: pi-assert does not expand environment variables,
templates, shell stdout, or computed event data inside them. Use multiple named
Action Handlers (or a preset) to request multiple independently auditable
actions.

### Filters

Tool-hook filters match `{ ...event.input, toolName }`, with the trusted
`toolName` taking precedence. Other adapters expose bounded candidates:

- `turn_end`: `{ event: "turn_end", turnIndex }`
- `agent_end` / `agent_settled`: `{ event }`
- `session_before_switch`: `{ event, reason, targetSessionFile? }`
- `session_before_fork`: `{ event, entryId, position }`
- `assert_result`: `{ event: "assert_result", assertionRef, runId, outcome, code }`

Every filter key is implicitly ANDed. Dot-separated keys resolve nested input
fields:

```json
{
  "local": {
    "protect-nested-env": {
      "description": "Block a custom writer targeting an environment file",
      "hook": "tool_call",
      "filter": {
        "toolName": "_write$",
        "request.target.path": "(^|/)\\.env.*$"
      },
      "shell": "false"
    }
  }
}
```

Every string filter value is a JavaScript regular-expression **source**, tested
with `RegExp.test()` against a string candidate. This same matcher applies to
tool names, paths, commands, and any other string field. Regex literals and
flags are not supported; write the source as a JSON string and escape
backslashes for JSON. Invalid patterns make the source-qualified configuration
entry fail to load.

Numbers, booleans, and `null` use strict equality without coercion. Arrays mean
“any of”: string members use regex matching while non-string members retain
strict equality. An empty array matches nothing. For example,
`{ "toolName": ["^write$", "^edit$"] }` matches either exact tool name.

**Migration:** string filters previously used strict equality and are now
unanchored regexes. Add `^` and `$` to retain exact matching: `"bash"` also
matches `"mybash"`, while `"^bash$"` matches only `"bash"`.

### Assertion-result handlers

`assert_result` runs Shell Assertion or Action Handler reactions after a
non-`assert_result` Shell Assertion makes a decision:

```json
{
  "local": {
    "handle-local-results": {
      "description": "Handle selected local assertion results",
      "hook": "assert_result",
      "filter": {
        "assertionRef": "^local/",
        "outcome": ["pass", "block", "cancel"]
      },
      "shell": "./scripts/handle-result.sh"
    }
  }
}
```

`assertionRef` is the canonical `source/name` identity and uses the normal
JavaScript regex matcher. `runId` is the originating assertion invocation's
UUID and uses that same regex matcher. `outcome` is exact (not regex) and
accepts one value or an any-of list containing `pass`, `block`, `patch`,
`cancel`, or `report`. `code` uses strict number-or-`null` matching. A pass has
code `0`; an ordinary failure has its non-zero shell exit code; timeout, abort,
spawn failure, and a `when` execution failure currently use `null`.

Filter misses and ordinary non-zero `when` skips emit no result. Fail-fast hooks
emit preceding passes and their first failure; aggregate hooks emit every
result in execution order. Handlers are awaited without the originating abort
signal, run result-major and then in configured order, and fail open relative to
the already-computed
native decision. Shell handler results and action requests never emit another
`assert_result`, preventing recursion. This is the explicit way to compose a
Shell Assertion decision with an effect while keeping the check and reaction
independently reusable.

A preset replaces executable fields with a `preset` array of qualified refs:

```json
{
  "local": {
    "safe-writes": {
      "description": "My write safeguards",
      "preset": ["local/unmodified", "owner/rules/protect-env"]
    }
  }
}
```

### Hook failure policies

| Hook | Aggregation | Failure behavior and feedback |
| --- | --- | --- |
| `tool_call` | first failure | blocks the call and reports the reason |
| `tool_result` | first failure | replaces the result with a redacted error and reports the reason |
| `turn_end` | all failures | report-only UI notification; cannot alter the completed turn |
| `agent_end` | all failures | sends one corrective message; an identical repeat stops automatic retry |
| `agent_settled` | all failures | report-only UI notification; does not start another run |
| `session_before_switch` | all failures | cancels `/new` or `/resume` and reports one aggregate |
| `session_before_fork` | all failures | cancels `/fork` or `/clone` and reports one aggregate |
| `assert_result` | all matching handlers | Shell handlers are report-only; Action Handlers request effects; neither changes the originating assertion decision |

Use `/asserts` to install, enable, disable, and manage rules and presets.

## Execution summaries

After each concrete native event, pi-assert appends a durable execution summary
when at least one assertion main shell ran or at least one action was requested.
Command-only collapsed wording is unchanged; action-only and mixed examples are:

```text
 pi-assert requested 1 action · tool_call bash (ctrl+o to expand)
 pi-assert ran 2 commands in 8ms and requested 1 action · turn_end 2 (ctrl+o to expand)
```

The collapsed summary is inset and styled like Pi's other transcript messages;
its hint reflects Pi's global `app.tools.expand` binding (`Ctrl-O` by default).
Expanded rows show `✓`/`✗`, the canonical `source/name` assertion
reference, and each shell's duration. Tool summaries also show the tool-call ID
only when expanded. Expanded action rows show the source-qualified handler and
action type and say `requested` rather than claiming completion. `assert_result`
handler shells and actions appear with an indented `↳` beneath the originating
assertion result; the same handler can therefore appear repeatedly.

Only started main `shell` commands are listed and counted. Action requests and
all `when` preconditions are excluded from command counts and duration. Filter
misses, ordinary non-zero `when` skips, and assertions not reached by fail-fast
shell policy are omitted. Shell-precondition infrastructure failures remain on
the fail-closed path; Action Handler precondition failures report and skip.
Execution history stores only action type, source-qualified handler identity,
run ID, hook, and originating-result association—not message bodies, compaction
instructions, or custom-event data.

Execution summaries are custom session entries: they persist across resume,
reload, fork, and tree navigation but never enter model context. They supplement
rather than replace block reasons, patched results, cancellation feedback,
report-only errors, corrective turns, or handler-failure notifications. Pi's
custom-entry interface is append-only, so summaries for parallel tools can
appear together after a batch; the trigger suffix and expanded tool-call ID
provide attribution. Print, JSON, and RPC modes receive no duplicate agent
message for these summaries.

## Environment

Every matching Shell Assertion or Action Handler precondition receives the
following shared variables. Optional values are genuinely unset when Pi does
not know them; they are never the
strings `"null"`/`"undefined"` or an empty placeholder.

| Variable | Meaning |
| --- | --- |
| `PI_SESSION_ID` | Current Pi session ID |
| `PI_SESSION_FILE` | Current session JSONL path; unset for ephemeral sessions |
| `PI_SESSION_NAME` | Current display name; unset for unnamed sessions |
| `PI_SESSION_LEAF_ID` | Current branch leaf; unset at the session root |
| `PI_PROVIDER` | Selected model provider; unset without a selected model |
| `PI_MODEL` | Selected model ID; unset without a selected model |
| `PI_REASONING_LEVEL` | Current effective reasoning level when available |
| `PI_MODE` | Pi mode: `tui`, `rpc`, `json`, or `print` |
| `PI_PROJECT_TRUSTED` | `true` or `false` for current project trust |
| `PI_CONTEXT_TOKENS` | Current context token count when known |
| `PI_CONTEXT_WINDOW` | Active model context-window size when context usage is available |
| `PI_CONTEXT_PERCENT` | Current context percentage when known |
| `PI_CWD` | Current Pi project directory |
| `PI_EVENT` | Current hook name, including `tool_call` and `tool_result` |
| `PI_ASSERT_REF` | Canonical `source/name` of the rule currently executing |
| `PI_ASSERT_HOOK` | That rule's configured hook |
| `PI_ASSERT_RUN_ID` | Fresh UUID for this one assertion invocation |

A Shell Assertion's `when` and main `shell` receive the same metadata snapshot
and `PI_ASSERT_RUN_ID`. An Action Handler uses one fresh run ID for its optional
precondition and action-request accounting. Every other rule, event invocation,
retry, or repeated execution gets a fresh run ID. It is an
observability/correlation ID, not an idempotency key or stable retry identifier.

Hook-specific variables remain available:

- `tool_call`: `PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, and JSON `PI_TOOL_INPUT`
- `tool_result`: all tool-call variables plus text `PI_TOOL_RESULT` and boolean
  string `PI_TOOL_IS_ERROR`
- lifecycle and synthetic hooks: JSON `PI_EVENT_PAYLOAD`, containing exactly
  the adapter's bounded filter candidate rather than the native event

For `assert_result`, `PI_EVENT_PAYLOAD` contains
`{ event, assertionRef, runId, outcome, code }`. The payload's `assertionRef`
and `runId` identify the **originating** rule invocation. The handler's own
`PI_ASSERT_REF` and `PI_ASSERT_RUN_ID` identify the **currently executing
handler**, so its run ID is different. Handler execution retains the bounded
session/model/runtime snapshot but remains detached from the originating abort
signal.

All commands execute with `PWD` set to `PI_CWD`. Before spawning a shell,
pi-assert removes inherited values for every variable it manages and overlays
only current values, preventing a parent Pi session from leaking stale
metadata. Unrelated ambient variables such as `PATH` and the process marker
`PI_CODING_AGENT` remain inherited.

## License

MIT
