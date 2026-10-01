---
name: hookit
description: Help with HooKit installation, Hook and Preset authoring, configuration, Events, Actions, enablement, management, reports, security, and troubleshooting in Pi.
---

# HooKit

HooKit applies configured Hooks to Pi Events and requests outcome-selected Pi
Actions. **Read the relevant references below before answering questions,
authoring Hooks, or diagnosing behavior.** Do not guess the contract from an
example alone.

Resolve every path relative to the directory containing this `SKILL.md`, not
the user's working directory. The bundled Markdown and [JSON Schema](../../schema.json)
belong to this installed release and work offline. Prefer them over the live
website or default-branch documentation, which may describe another version.
No documentation server, repository checkout, or MDX renderer is needed.

## Task → references to read

| Task | Local references |
|---|---|
| Install and verify HooKit in the intended session | [Installation](references/getting-started/installation.md), [runtime modes](references/reference/runtime-modes.md) |
| Create, load, enable, and test a Hook; safely extend existing configuration | [Write a hook](references/getting-started/first-hook.md), [add a Hook](references/getting-started/authoring.md), [configuration](references/reference/configuration/index.md) |
| Look up Hook/Preset fields and validate configuration | [Configuration](references/reference/configuration/index.md), [Preset fields](references/reference/configuration/preset.md), [schema guidance](references/reference/configuration/schema.md), [release schema](../../schema.json) |
| Choose an Event, understand failure, or react to Hook Results | [Events](references/reference/events.md), [Hook Result Event](references/reference/events.md#hook-result-event), [evaluation ordering](references/reference/events.md#evaluation-order) |
| Match Event data or gate a Hook | [Filters and all candidates](references/reference/configuration/filter.md), [Preconditions](references/reference/configuration/when.md), [shell semantics](references/reference/configuration/shell.md) |
| Read Event/session data in a shell | [Shell environment and formats](references/reference/shell-environment.md) |
| Select Actions or control message delivery and continuation | [Actions](references/reference/configuration/action.md), [message delivery](references/reference/configuration/action.md#message-delivery) |
| Explain individual Hook Outcomes vs aggregate Event Outcomes | [Hook Evaluation](references/concepts/evaluation.md), [composition](references/concepts/composition.md) |
| Diagnose defaults, saved enablement, Preset members, trust, Sources, or merging | [Presets and sources](references/reference/configuration/presets-sources.md), [defaults](references/reference/configuration/default.md), [security](references/concepts/security.md) |
| Install, update, remove, search, or edit local Presets | [The /hooks panel](references/reference/hooks-panel.md) |
| Discover opt-in Core and Extras policies | [Hook library](references/getting-started/library.md) |
| Inspect execution in interactive or headless sessions | [Execution Reports](references/reference/execution-report.md), [runtime modes](references/reference/runtime-modes.md) |
| Fix a missing, skipped, failing, or looping Hook | [Troubleshooting](references/getting-started/troubleshooting.md), then the relevant contract above |
| Resolve domain vocabulary or browse all topics | [Glossary](references/reference/glossary.md), [documentation index](references/index.md) |

## Critical warnings

- **Trusted executable code, not a sandbox:** Hook shells and Preconditions run
  with Pi's permissions. Review them before installing or enabling them.
- **Configuration is not activation:** creating an entry or changing its
  `default` does not necessarily enable it. Saved session enablement, even an
  empty set, overrides defaults; verify enablement in the intended session.
- **Continuation can loop:** user messages and other continuation Actions can
  trigger later Events and select themselves again. There is no general loop
  guard for user-authored Actions; make continuation self-limiting.
