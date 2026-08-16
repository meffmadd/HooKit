# 🦉 HooKit

Hooks with outcome-selected Pi Actions for Pi events.

HooKit applies user-configured **Hooks** to Pi **Events** — a policy that
subscribes to a tool call, a finished turn, or a settled agent, runs a shell
decision, and may own one outcome-selected Pi **Action**. Configuration lives
in `.pi/hookit.json`; `/hooks` manages installation, enablement, defaults,
Presets, and search.

## The documentation

The complete documentation is organized around three needs:

- **[Getting Started](site/content/docs/getting-started/index.mdx)** —
  installation, the guided Hook-writing tutorial, and the Hook library.
- **[Reference](site/content/docs/reference/configuration.mdx)** — the complete
  configuration contract and runtime behavior.
- **[Concepts](site/content/docs/concepts/overview.mdx)** — evaluation,
  composition, and security.

The JSON Schema at `schema.json` is the validation authority. Every designated
JSON configuration example is validated against it.

## Quick example

<!-- docs-example:valid -->
```json
{
  "$schema": "https://raw.githubusercontent.com/meffmadd/pi-assert/main/schema.json",
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
    }
  }
}
```

Open `/hooks`, focus `protect-env`, and press `Enter` to enable it. The
Follow [Installation](site/content/docs/getting-started/installation.mdx), then
[Write a hook](site/content/docs/getting-started/first-hook.mdx) for a complete
Hook with an expected result at every step.

## Security

Hook shells execute locally as trusted code with your Pi process permissions.
They are not sandboxed; the 5-second default timeout bounds commands but is not
a sandbox. Treat repository Hooks like third-party executable code and review
their Source before installation. Read the
[security page](site/content/docs/concepts/security.mdx) before authoring or
installing policies from untrusted sources.

## Repositories

- **HooKit** — this repository: the extension, schema, and documentation site.
- **HooKit-rules** ([`meffmadd/pi-assert-rules`](https://github.com/meffmadd/pi-assert-rules))
  — the installable Hook library: file safety, Bash command guards, Git
  protections, tool restrictions, quality checks, notifications, and
  observability Hooks.
