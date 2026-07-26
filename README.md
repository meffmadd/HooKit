# pi-assert

Shell guards for Pi tool and lifecycle events. Assertions are loaded from project
`.pi/asserts.json` and global `~/.pi/asserts.json`; a project entry overrides a
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

Shell assertions require `description`, a supported `hook`, and `shell`.
Optional `filter`, `when`, and boolean `default` are supported. `when` only
skips on an ordinary non-zero exit—timeouts and execution failures apply the
hook's fail-closed policy. Shells run with `PWD` and `PI_CWD` set to the Pi
project directory.

Supported hooks are `tool_call`, `tool_result`, `turn_end`, `agent_end`,
`agent_settled`, `session_before_switch`, and `session_before_fork`. Unknown
lifecycle names fail configuration loading with the supported list.
`session_shutdown` is intentionally unsupported because Pi does not provide a
way for an extension to cancel shutdown.

### Filters

Tool-hook filters match `{ ...event.input, toolName }`, with the trusted
`toolName` taking precedence. Other adapters expose bounded candidates:

- `turn_end`: `{ event: "turn_end", turnIndex }`
- `agent_end` / `agent_settled`: `{ event }`
- `session_before_switch`: `{ event, reason, targetSessionFile? }`
- `session_before_fork`: `{ event, entryId, position }`

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

A preset replaces shell fields with a `preset` array of qualified refs:

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

Use `/asserts` to install, enable, disable, and manage rules and presets.

## Environment

Tool hooks receive `PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, `PI_TOOL_INPUT`, and
`PI_CWD`; result hooks additionally receive `PI_TOOL_RESULT` and
`PI_TOOL_IS_ERROR`. Other lifecycle hooks receive `PI_EVENT`,
`PI_EVENT_PAYLOAD` (the JSON-encoded bounded filter candidate), and `PI_CWD`.
All commands also execute with `PWD` set to `PI_CWD`.

## License

MIT
