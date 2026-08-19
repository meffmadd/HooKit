---
name: hookit-sandbox
description: Manually test HooKit hooks against the real Pi pipeline in an isolated sandbox project. Use when the user wants to try, verify, demo, or debug a hook interactively in the Pi TUI, or run a scripted non-interactive behavior check.
---

# HooKit sandbox

`sandbox/` at the repo root is a gitignored scratch Pi project for manual
hook testing. A Pi session started there runs the working HooKit checkout
and reads only `sandbox/.pi/hookit.json` (plus any global catalog); the repo
root's own `.pi/hookit.json` never loads there because project storage
resolves from the session cwd.

The machinery lives in this skill's `scripts/` directory (repo-root
relative: `.agents/skills/hookit-sandbox/scripts/`). Each script mechanizes
exactly one layer of the environment — they are transparent windows into
the setup, not black boxes.

## The environment, layer by layer

Every manual test lines up five layers. Understand these before changing
the setup:

1. **Extension under test.** `--approve -e <repo>/hookit/index.ts` loads the
   working checkout before the trust decision, from any cwd. `run.sh` owns
   this incantation — never duplicate the flags elsewhere.
2. **Catalog storage.** Hooks come from the merged catalog: global
   `~/.pi/agent/hookit.json` (always read — keep it empty or expected) plus
   project `<cwd>/.pi/hookit.json` (read only when trusted). Test hooks
   live in the sandbox catalog's `local` section;
   `scripts/starter-catalog.json` is the single committed source.
3. **Trust.** `--approve` trusts project-local files for one run without
   saving anything; `/trust` saves a permanent decision to
   `~/.pi/agent/trust.json`. Non-interactive modes never prompt, which is
   why every scripted run passes `--approve`.
4. **Enablement.** A fresh session enables exactly the entries with
   `default: true`. `/hooks` toggles persist as `hookit-config` entries on
   the session branch, so resumed sessions keep old toggles — the most
   common reason a hook "doesn't fire" during testing.
5. **Trigger.** Tool events fire only for model-initiated tool calls. `!cmd`
   in the editor runs through Pi's bash mode and bypasses the tool pipeline
   entirely — it fires no tool events. Give each test hook an exact-command
   filter (`"command": "^echo <trigger>$"`) and prompt the model:
   `run: echo <trigger>`.

Observation surfaces: the block/patch reason fed back to the model, the
Execution Report custom entry, follow-up messages, the `/hooks` panel, the
`hooks: n/m` status line, and side-effect files appended by hook shells
(`.pi/sandbox-log.jsonl` — the scriptable one).

## Machinery

| Script | Owns |
|---|---|
| `setup.sh [--fresh] [--force]` | Scaffold: seeds the sandbox catalog + README from `starter-catalog.json`, validates; `--fresh` clears the log, `--force` resets a modified catalog |
| `run.sh` | Launch: interactive TUI by default, `-r` resume, `-p "prompt"` print run (`--ephemeral`, `--name`) |
| `check.sh [block\|audit\|all]` | Probe + assert: resets the log, runs a scenario ephemeral, asserts the expected log line; non-zero exit on miss |
| `validate.sh [file]` | Schema gate: ajv-validates any hookit.json (default the sandbox catalog) before the confusing HooKit load diagnostic appears |
| `doctor.sh` | Debug: prints every layer's live state (pi version, catalogs, trust, sessions, log) |

`npm run sandbox` (repo root) delegates to `run.sh`.

## Setup

```bash
bash .agents/skills/hookit-sandbox/scripts/setup.sh
```

Idempotent. The three starters each demonstrate one pattern:
`sandbox-block` (tool_call guard with an exact-command filter),
`sandbox-audit` (tool_result side-effect logging), `sandbox-react`
(reactive `hook_result` logger) — all `default: true`. Read
`scripts/starter-catalog.json` for the canonical shape; the sandbox copy is
derived from it and may be replaced freely while testing.

## Interactive run

```bash
npm run sandbox          # repo root
# or: bash .agents/skills/hookit-sandbox/scripts/run.sh
```

Prompt `run: echo hookit-sandbox-block` and expect the tool call to be
blocked, an Execution Report row for the guard plus its reactive row, and a
`hook_result` line in `.pi/sandbox-log.jsonl`. Prompt
`run: echo hookit-sandbox-audit` to exercise the passing path (it appends
the `tool_result` log line). `/hooks` shows enablement; `/reload`
re-creates extensions after HooKit code edits.

## Testing a hook under test

Add or replace an entry in `sandbox/.pi/hookit.json` — give it
`default: true` and an exact-command filter — then start a fresh session
(`/new`, or a new `run.sh`). Validate first:

```bash
bash .agents/skills/hookit-sandbox/scripts/validate.sh
```

`check.sh` asserts only the starter scenarios; for a custom hook, drive it
interactively or with `run.sh -p "run: echo <trigger>"` and inspect the log.

## Scripted check (non-interactive)

```bash
bash .agents/skills/hookit-sandbox/scripts/check.sh all
```

Each scenario costs one real model call (the trigger must be
model-initiated — that is the constraint the exact-command filter works
around), so this is a manual/smoke tier, not part of `npm test`. For ad-hoc
probes, `run.sh -p "prompt"` runs the same pipeline and *saves* the session;
add `--ephemeral` when the run is not worth resuming, `--name <topic>` to
make it easy to find later.

## Sessions

Sessions never save into the sandbox directory. Pi auto-saves every session
— interactive and non-interactive alike, unless `--no-session` — to
`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`, organized by
working directory. From the sandbox cwd, `/resume` lists that directory's
sessions and resumes one interactively — including `run.sh -p` runs.

Resuming restores the HooKit state that rode along: enablement toggles
(`hookit-config` branch entries) and past Execution Reports in history.
Plain `pi -r` would resume **without** the extension loaded, so always
resume through `run.sh -r`. When a resumed session misbehaves, start `/new`
for a clean, default-derived enablement.

## Reset

```bash
bash .agents/skills/hookit-sandbox/scripts/setup.sh --fresh --force
```

## Boundaries

- TUI-only surfaces (the Execution Report renderer, the `/hooks` panel) need
  the interactive run; `-p`/`--mode json` verify behavior only.
- Unexpected hooks firing ⇒ run `doctor.sh`; the global catalog merges into
  every run.
- Hook shells get a 5-second timeout and fail closed (block/patch) on
  infrastructure errors.
