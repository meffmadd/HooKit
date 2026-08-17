import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HookCatalog } from "../../hookit/hook-catalog/index.js";
import { validate } from "../schema-helper.js";
import {
  CORE_SOURCE,
  corePreset,
  loadCoreEntries,
} from "./index.js";
import { fixture } from "./fixtures.js";

const EXPECTED_CORE_ENTRIES = [
  "block-bash",
  "block-edit",
  "block-find",
  "block-grep",
  "block-ls",
  "block-read",
  "block-write",
  "diff-max-10-lines",
  "diff-max-100-lines",
  "diff-max-1000-lines",
  "diff-max-2000-lines",
  "diff-max-250-lines",
  "diff-max-50-lines",
  "diff-max-500-lines",
  "diff-max-5000-lines",
  "git-diff-check",
  "no-env-access",
  "no-env-secrets-in-output",
  "npm-build",
  "npm-lint",
  "npm-test",
  "npm-typecheck",
  "only-md",
  "paths-in-cwd",
  "pre-commit-run",
  "pre-commit-run-all-files",
  "read-max-10000-chars",
  "read-max-100000-chars",
  "read-max-20000-chars",
  "read-max-200000-chars",
  "read-max-500-chars",
  "read-max-50000-chars",
  "read-only",
  "require-more-deletions",
  "require-no-change",
  "write-new-files-only",
] as const;

describe("Core Hook catalog", () => {
  it("contains exactly the supported 36 Catalog Entries", () => {
    assert.deepEqual(
      [...loadCoreEntries().keys()].sort(),
      EXPECTED_CORE_ENTRIES,
    );
  });

  it("satisfies the shared schema and Hook Catalog invariants", () => {
    const entries = Object.fromEntries(loadCoreEntries());
    const configuration = {
      repos: [CORE_SOURCE],
      [CORE_SOURCE]: entries,
    };

    assert.equal(validate(configuration), true, JSON.stringify(validate.errors));

    const root = fixture("catalog");
    const project = join(root, "project", ".pi", "hookit.json");
    mkdirSync(dirname(project), { recursive: true });
    writeFileSync(project, `${JSON.stringify(configuration, null, 2)}\n`);

    const loaded = HookCatalog.open({
      global: join(root, "global.json"),
      project,
    });
    assert.equal(loaded.ok, true, loaded.ok ? undefined : JSON.stringify(loaded.diagnostics));
    assert.equal(loaded.catalog.entries.length, 36);
    assert.ok(loaded.catalog.entries.every((entry) => entry.default === false));
  });

  it("defines read-only as the three canonical Core mutation blockers", () => {
    assert.deepEqual(corePreset("read-only").preset, [
      "meffmadd/HooKit/block-bash",
      "meffmadd/HooKit/block-write",
      "meffmadd/HooKit/block-edit",
    ]);
  });
});
