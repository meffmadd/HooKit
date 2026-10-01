/**
 * Shared JSON Schema seam for every test that validates hookit.json
 * configuration against schema.json. Loading the schema and compiling
 * the Ajv validator live here once (one shared implementation over
 * two, per AGENTS.md) so schema.test.ts and docs-examples.test.ts
 * cannot fork the setup and silently drift.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";

const schemaPath = join(import.meta.dirname!, "..", "schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

/** Use the same validation mechanism with a schema from an unpacked release. */
export function createValidator(schema: object) {
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  return ajv.compile(schema);
}

/**
 * Compiled validator over schema.json. `validate(config)` returns a
 * boolean; after a failed call, `validate.errors` carries the Ajv
 * diagnostics for assertion messages.
 */
export const validate = createValidator(schema);
