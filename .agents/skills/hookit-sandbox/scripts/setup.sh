#!/usr/bin/env bash
# Seed the sandbox scratch project (idempotent).
# Usage: setup.sh [--fresh] [--force]
#   --fresh  also delete the sandbox side-effect log
#   --force  overwrite an existing sandbox catalog with the starter
#
# scripts/starter-catalog.json is the single source for the starter Hooks;
# the sandbox copy is derived from it and may be replaced freely while
# testing.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
SANDBOX="$REPO_ROOT/sandbox"
STARTER="$SKILL_DIR/scripts/starter-catalog.json"
CATALOG="$SANDBOX/.pi/hookit.json"
LOG="$SANDBOX/.pi/sandbox-log.jsonl"

FRESH=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --force) FORCE=1 ;;
    *) echo "setup: unknown option: $arg" >&2; exit 1 ;;
  esac
done

mkdir -p "$SANDBOX/.pi"

if [[ -f "$CATALOG" ]]; then
  if [[ $FORCE -eq 1 ]]; then
    cp "$STARTER" "$CATALOG"
    echo "setup: catalog reset to starter (--force)"
  elif cmp -s "$STARTER" "$CATALOG"; then
    echo "setup: catalog already matches the starter"
  else
    echo "setup: catalog differs from the starter (kept; --force restores it)"
  fi
else
  cp "$STARTER" "$CATALOG"
  echo "setup: catalog seeded from starter"
fi

if [[ $FRESH -eq 1 ]] && [[ -f "$LOG" ]]; then
  rm "$LOG"
  echo "setup: side-effect log removed (--fresh)"
fi

cat > "$SANDBOX/README.md" <<EOF
# HooKit sandbox

Gitignored scratch Pi project for manual hook testing — nothing here is
committed. Regenerate anytime with:
  bash .agents/skills/hookit-sandbox/scripts/setup.sh --fresh

- Catalog: .pi/hookit.json — seeded from the skill's starter-catalog.json;
  replace freely while testing.
- Side-effect log: .pi/sandbox-log.jsonl (deleted by --fresh).
- Interactive session: npm run sandbox (repo root) or scripts/run.sh.
- Resume past sessions: scripts/run.sh -r (loads HooKit too).
- Scripted check: scripts/check.sh [block|audit|all].
- Triggers (prompt the model to run exactly):
    run: echo hookit-sandbox-block   (blocked path)
    run: echo hookit-sandbox-audit   (passing path)
- Sessions save per-cwd under ~/.pi/agent/sessions/, never in this
  directory; \`/resume\` from here lists them.

Full environment model: .agents/skills/hookit-sandbox/SKILL.md
EOF

bash "$SKILL_DIR/scripts/validate.sh" "$CATALOG"
