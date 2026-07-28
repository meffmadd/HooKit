import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { AssertionCatalog } from "../pi-assert/assertion-catalog/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function jsonExamples(path: string): unknown[] {
  const text = readFileSync(join(root, path), "utf8");
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1]!)
  );
}

describe("documentation JSON examples", () => {
  for (const path of ["README.md", "skills/pi-assert/SKILL.md"]) {
    it(`${path} examples create non-empty Assertion Catalogs`, () => {
      const examples = jsonExamples(path);
      assert.ok(examples.length > 0, "expected at least one JSON example");
      const directory = mkdtempSync(join(tmpdir(), "pi-assert-docs-"));
      try {
        for (let index = 0; index < examples.length; index++) {
          const project = join(directory, `${index}.json`);
          writeFileSync(project, JSON.stringify(examples[index]));
          const result = AssertionCatalog.open({
            global: join(directory, "missing-global.json"),
            project,
          });
          assert.equal(
            result.ok,
            true,
            result.ok ? undefined : JSON.stringify(result.diagnostics),
          );
          if (result.ok) {
            assert.ok(result.catalog.entries.length > 0);
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
