#!/usr/bin/env bash
# Schema-gate any hookit.json catalog (default: the sandbox catalog).
# Usage: validate.sh [file]
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
CATALOG="${1:-$REPO_ROOT/sandbox/.pi/hookit.json}"

if [[ ! -f "$CATALOG" ]]; then
  echo "validate: catalog not found: $CATALOG" >&2
  echo "  (run .agents/skills/hookit-sandbox/scripts/setup.sh to seed the sandbox)" >&2
  exit 1
fi

cd "$REPO_ROOT"
CATALOG_FILE="$CATALOG" node --input-type=module -e '
import Ajv from "ajv";
import { readFileSync } from "node:fs";
const file = process.env.CATALOG_FILE;
const schema = JSON.parse(readFileSync("schema.json", "utf8"));
const doc = JSON.parse(readFileSync(file, "utf8"));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
if (validate(doc)) {
  console.log(`validate: ${file} — valid against schema.json`);
  process.exit(0);
}
for (const err of validate.errors ?? []) {
  console.error(`  ${err.instancePath || "/"} ${err.message ?? "invalid"}`);
}
process.exit(1);
'
