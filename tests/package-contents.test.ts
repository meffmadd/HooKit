import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const repositoryRoot = new URL("..", import.meta.url);

describe("npm package contents", () => {
  it("keeps the remote Core Hook catalog out of the npm pack manifest", () => {
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
    assert.ok(paths.includes("hookit/index.ts"));
    assert.equal(
      paths.some((path) => path === "hooks" || path.startsWith("hooks/")),
      false,
      paths.join("\n"),
    );
  });
});
