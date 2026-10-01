# 🦉 HooKit

Hooks with outcome-selected Pi Actions for Pi events.

HooKit applies user-configured **Hooks** to Pi **Events** — a policy that
subscribes to a tool call, a finished turn, or a settled agent, runs a shell
decision, and may own one outcome-selected Pi **Action**. Configuration lives
in `.pi/hookit.json`; `/hooks` manages installation, enablement, defaults,
Presets, and search in Pi's interactive TUI. Hook Evaluation also works in
[RPC, JSON, and print modes](skills/hookit/references/reference/runtime-modes.md).

## The documentation

The complete documentation is organized around three needs:

- **[Getting Started](skills/hookit/references/getting-started/index.md)** —
  installation, Hook authoring, troubleshooting, and the Hook library.
- **[Reference](skills/hookit/references/reference/configuration/index.md)** — the complete
  configuration contract and runtime behavior.
- **[Concepts](skills/hookit/references/concepts/overview.md)** — evaluation,
  composition, and security.
- **[Glossary](skills/hookit/references/reference/glossary.md)** — domain vocabulary.

These readable Markdown pages ship with each npm release, alongside the
[JSON Schema](schema.json), and are authoritative for that installed version.
The [bundled skill](skills/hookit/SKILL.md) routes help and authoring tasks to
local references without network access. The
[documentation website](https://meffmadd.github.io/HooKit/) is supplementary
and may describe a newer version.

In a repository checkout, run `npm ci` and `npm run package:prepare` to generate
the same local pages from `site/content/docs/`. Every designated JSON
configuration example is validated against the schema.

## Quick example

<!-- docs-example:valid -->
```json
{
  "$schema": "https://raw.githubusercontent.com/meffmadd/HooKit/main/schema.json",
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
        "delivery": "followUp",
        "sendAs": "custom"
      },
      "default": true
    }
  }
}
```

In an interactive Pi TUI, open `/hooks`, focus `protect-env`, and press `Enter`
to toggle its enablement.
Follow [Installation](skills/hookit/references/getting-started/installation.md), then
[Write a hook](skills/hookit/references/getting-started/first-hook.md) for a complete
Hook with an expected result at every step.

## Security

Hook shells execute locally as trusted code with your Pi process permissions.
They are not sandboxed; the 5-second default timeout bounds commands but is not
a sandbox. Treat repository Hooks like third-party executable code and review
their Source before installation. Read the
[security page](skills/hookit/references/concepts/security.md) before authoring or
installing policies from untrusted sources.

## Repositories

- **HooKit** — the extension, schema, documentation site, and stable
  [Core Hook catalog][core-hook-catalog]. Core Hooks install remotely from
  `meffmadd/HooKit`; they are not bundled in the npm package.
- **[HooKit Extras](https://github.com/meffmadd/HooKit-extras)** — specialized,
  platform-specific, dependency-heavy, and incubating Hooks.

[core-hook-catalog]: https://github.com/meffmadd/HooKit/blob/main/hooks/README.md
