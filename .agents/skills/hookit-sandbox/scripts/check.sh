#!/usr/bin/env bash
# Scripted behavior check against the real Pi pipeline (one model call per
# scenario — manual/smoke tier, not part of npm test).
#
# Usage: check.sh [block|audit|all]     (default: block)
#
# Each scenario: reset the side-effect log → validate the sandbox catalog →
# ephemeral print run with the trigger prompt → assert the expected log
# line. Exits non-zero when an assertion misses.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
SANDBOX="$REPO_ROOT/sandbox"
CATALOG="$SANDBOX/.pi/hookit.json"
LOG="$SANDBOX/.pi/sandbox-log.jsonl"
SCENARIO="${1:-block}"

scenario() {
  local name="$1" entry="$2" prompt="$3"
  shift 3
  local expects=("$@")

  echo "── scenario: $name"
  if ! grep -q "\"$entry\"" "$CATALOG" 2>/dev/null; then
    echo "✗ entry '$entry' missing from the sandbox catalog"
    echo "  (check.sh covers only the starter Hooks; setup.sh --force restores them)"
    FAILED=1
    return
  fi

  rm -f "$LOG"
  echo "  running (ephemeral print run)…"
  local output
  output="$(bash "$SKILL_DIR/scripts/run.sh" -p --ephemeral "$prompt")" || true
  printf '%s\n' "$output" | sed 's/^/  │ /'

  if [[ ! -f "$LOG" ]]; then
    echo "✗ no side-effect log written — the Hook did not run or did not match"
    FAILED=1
    return
  fi
  local ok=1
  local expect
  for expect in "${expects[@]}"; do
    if ! grep -qF "$expect" "$LOG"; then
      echo "✗ log missing: $expect"
      ok=0
    fi
  done
  if [[ $ok -eq 1 ]]; then
    echo "✓ assertions passed"
  else
    echo "  log contents:"; sed 's/^/  │ /' "$LOG"
    FAILED=1
  fi
}

[[ -f "$CATALOG" ]] || { echo "check: sandbox catalog missing — run scripts/setup.sh first" >&2; exit 1; }

FAILED=0
case "$SCENARIO" in
  block)
    scenario block sandbox-block \
      "Run this exact command using the bash tool, with no changes: echo hookit-sandbox-block" \
      '"hookRef":"local/sandbox-block"' \
      '"outcome":"block"'
    ;;
  audit)
    scenario audit sandbox-audit \
      "Run this exact command using the bash tool, with no changes: echo hookit-sandbox-audit" \
      'tool_result tool=bash is_error=false input={"command":"echo hookit-sandbox-audit"}'
    ;;
  all)
    scenario block sandbox-block \
      "Run this exact command using the bash tool, with no changes: echo hookit-sandbox-block" \
      '"hookRef":"local/sandbox-block"' \
      '"outcome":"block"'
    scenario audit sandbox-audit \
      "Run this exact command using the bash tool, with no changes: echo hookit-sandbox-audit" \
      'tool_result tool=bash is_error=false input={"command":"echo hookit-sandbox-audit"}'
    ;;
  *)
    echo "check: unknown scenario: $SCENARIO (use block|audit|all)" >&2
    exit 1
    ;;
esac

if [[ $FAILED -eq 1 ]]; then
  echo "check: FAILED"
  exit 1
fi
echo "check: OK"
