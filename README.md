# pi-assert

Shell guards for Pi tool calls. Assertions are loaded from project
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

Shell assertions require `description`, `hook` (`tool_call`, `tool_result`, or
`agent_end`), and `shell`. Optional `filter`, `when`, and boolean `default`
are supported. `when` only skips on an ordinary non-zero exit—timeouts and
execution failures block. Shells run with `PWD` and `PI_CWD` set to the Pi
project directory.

### Filters

Tool-hook filters match `{ ...event.input, toolName }`, with the trusted
`toolName` taking precedence. Agent-end filters match
`{ "event": "agent_end" }`. Every filter key is implicitly ANDed.
Dot-separated keys resolve nested input fields:

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

`tool_call` blocks a call, `tool_result` replaces a failed result with a
redacted error, and `agent_end` starts a corrective turn for failures. Use
`/asserts` to install, enable, disable, and manage rules and presets.

## Environment

Tool hooks receive `PI_TOOL_NAME`, `PI_TOOL_CALL_ID`, `PI_TOOL_INPUT`, and
`PI_CWD`; result hooks additionally receive `PI_TOOL_RESULT` and
`PI_TOOL_IS_ERROR`. Agent-end hooks receive `PI_EVENT=agent_end` and `PI_CWD`.

## License

MIT
