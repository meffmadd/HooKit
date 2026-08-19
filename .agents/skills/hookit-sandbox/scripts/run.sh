#!/usr/bin/env bash
# Launch Pi in the sandbox with the working HooKit checkout loaded.
# This script owns the launch incantation — do not duplicate the flags
# elsewhere; everything (npm run sandbox, check.sh) delegates here.
#
# Usage:
#   run.sh                       interactive TUI session (saved)
#   run.sh -r                    interactive, opening the /resume picker
#   run.sh -p [opts] "prompt"    non-interactive print run (saved)
#     --ephemeral                do not save the session (--no-session)
#     --name <topic>             name the session for easier /resume
#
# --approve trusts project-local files for this run without saving a
# trust decision. Sessions auto-save per-cwd under ~/.pi/agent/sessions/.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
SANDBOX="$REPO_ROOT/sandbox"
EXTENSION="$REPO_ROOT/hookit/index.ts"

if [[ ! -f "$EXTENSION" ]]; then
  echo "run: extension not found: $EXTENSION" >&2
  exit 1
fi
if [[ ! -f "$SANDBOX/.pi/hookit.json" ]]; then
  echo "run: sandbox catalog missing — run scripts/setup.sh first" >&2
  exit 1
fi

cd "$SANDBOX"

if [[ "${1:-}" == "-r" ]]; then
  # Plain `pi -r` would resume without the extension loaded; always resume
  # through this script so HooKit is active in the resumed session.
  exec pi -r --approve -e "$EXTENSION"
fi

if [[ "${1:-}" == "-p" ]]; then
  shift
  EPHEMERAL=0
  NAME=""
  PROMPT=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ephemeral) EPHEMERAL=1 ;;
      --name) NAME="${2:-}"; shift ;;
      -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
      *) PROMPT="$1" ;;
    esac
    shift
  done
  if [[ -z "$PROMPT" ]]; then
    echo 'run: -p needs a prompt, e.g. run.sh -p "run: echo hookit-sandbox-block"' >&2
    exit 1
  fi
  ARGS=(pi -p --approve -e "$EXTENSION")
  [[ $EPHEMERAL -eq 1 ]] && ARGS+=(--no-session)
  [[ -n "$NAME" ]] && ARGS+=(--name "$NAME")
  ARGS+=("$PROMPT")
  exec "${ARGS[@]}"
fi

exec pi --approve -e "$EXTENSION"
