import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const repositoryRoot = new URL("..", import.meta.url);

describe("npm package contents", () => {
  it("ships the Pi package without repository-only content", () => {
    const packed = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    assert.equal(packed.status, 0, packed.stderr || packed.error?.message);

    const manifests = JSON.parse(packed.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    assert.equal(manifests.length, 1);
    const paths = manifests[0]!.files.map((file) => file.path);
    for (const required of [
      "AGENTS.md",
      "hookit/index.ts",
      "skills/hookit/SKILL.md",
    ]) {
      assert.ok(paths.includes(required), `missing ${required}\n${paths.join("\n")}`);
    }
    for (const excluded of ["hooks", "site", "tests"]) {
      assert.equal(
        paths.some(
          (path) => path === excluded || path.startsWith(`${excluded}/`),
        ),
        false,
        paths.join("\n"),
      );
    }
  });
});
