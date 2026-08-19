#!/usr/bin/env bash
# Report the live state of every manual-test environment layer — the
# executable version of the skill's "Boundaries" section. Read-only.
# Usage: doctor.sh
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
SANDBOX="$REPO_ROOT/sandbox"
EXTENSION="$REPO_ROOT/hookit/index.ts"
CATALOG="$SANDBOX/.pi/hookit.json"
LOG="$SANDBOX/.pi/sandbox-log.jsonl"
GLOBAL_CATALOG="$HOME/.pi/agent/hookit.json"
TRUST="$HOME/.pi/agent/trust.json"

echo "HooKit sandbox doctor"
echo "─────────────────────"

# Layer 1: extension under test
if [[ -f "$EXTENSION" ]]; then
  echo "extension:      $EXTENSION (present)"
else
  echo "extension:      MISSING at $EXTENSION"
fi
echo "pi:             $(pi --version 2>/dev/null | head -1 || echo 'not on PATH')"

# Layer 2: catalog storage
cd "$REPO_ROOT"
SANDBOX_CATALOG="$CATALOG" GLOBAL_CATALOG_PATH="$GLOBAL_CATALOG" node --input-type=module -e '
import { readFileSync, existsSync } from "node:fs";
const read = (label, path) => {
  if (!existsSync(path)) { console.log(`${label}:   (none)`); return; }
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const names = Object.keys(doc?.local ?? {});
    console.log(`${label}:   ${names.length} entr${names.length === 1 ? "y" : "ies"}${names.length ? `: ${names.join(", ")}` : ""}`);
  } catch { console.log(`${label}:   unreadable (invalid JSON)`); }
};
read("sandbox cat.", process.env.SANDBOX_CATALOG);
read("global cat.", process.env.GLOBAL_CATALOG_PATH);
'
if [[ -f "$GLOBAL_CATALOG" ]]; then
  echo "                (the global catalog merges into every run — unexpected"
  echo "                 Hooks firing usually start here)"
fi

# Layer 3: trust
if [[ -f "$TRUST" ]] && SANDBOX_PATH="$SANDBOX" node --input-type=module -e '
import { readFileSync } from "node:fs";
const trust = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/trust.json", "utf8"));
process.exit(trust[process.env.SANDBOX_PATH] === true ? 0 : 1);
' 2>/dev/null; then
  echo "trust:          saved for the sandbox cwd"
else
  echo "trust:          no saved decision — run.sh passes --approve per run"
fi

# Layer 4/5: sessions and log (enablement and triggers are session state)
SESSION_DIR="$(ls -d "$HOME"/.pi/agent/sessions/*HooKit-sandbox* 2>/dev/null | head -1 || true)"
if [[ -n "$SESSION_DIR" ]]; then
  COUNT=$(find "$SESSION_DIR" -name "*.jsonl" 2>/dev/null | wc -l | tr -d " ")
  echo "sessions:       $COUNT saved under $SESSION_DIR"
else
  echo "sessions:       0 saved (interactive and run.sh -p runs save; --ephemeral runs do not)"
fi
if [[ -f "$LOG" ]]; then
  LINES=$(wc -l < "$LOG" | tr -d " ")
  echo "side-eff. log:  $LINES line(s) in .pi/sandbox-log.jsonl"
else
  echo "side-eff. log:  empty"
fi
