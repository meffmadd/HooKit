import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fixture, toolCallOutcome } from "./fixtures.js";

describe("Core general safety filters", () => {
  it("only-md blocks non-Markdown write and edit destinations", async () => {
    const cwd = fixture("only-md");
    assert.equal(await toolCallOutcome("only-md", "write", { path: "README.md" }, cwd), "pass");
    assert.equal(await toolCallOutcome("only-md", "edit", { path: "docs/guide.md" }, cwd), "pass");
    assert.equal(await toolCallOutcome("only-md", "write", { path: "notes.txt" }, cwd), "block");
    assert.equal(await toolCallOutcome("only-md", "edit", { path: "image.png" }, cwd), "block");
    assert.equal(await toolCallOutcome("only-md", "my-write", { path: "notes.txt" }, cwd), "pass");
  });

  it("no-env-access blocks exact dotenv reads and writes", async () => {
    const cwd = fixture("no-env-access");
    assert.equal(await toolCallOutcome("no-env-access", "read", { path: ".env" }, cwd), "block");
    assert.equal(await toolCallOutcome("no-env-access", "write", { path: "config/.env" }, cwd), "block");
    assert.equal(await toolCallOutcome("no-env-access", "read", { path: ".env.local" }, cwd), "pass");
    assert.equal(await toolCallOutcome("no-env-access", "bash", { command: "cat .env" }, cwd), "pass");
  });

  it("paths-in-cwd resolves traversal, absolute paths, and symbolic links", async () => {
    const parent = fixture("paths-in-cwd");
    const cwd = join(parent, "project");
    const sibling = join(parent, "project-copy");
    mkdirSync(cwd);
    mkdirSync(sibling);
    symlinkSync(sibling, join(cwd, "escape"));
    symlinkSync(join(cwd, "inside"), join(cwd, "inside-link"));
    mkdirSync(join(cwd, "inside"));

    for (const path of [
      "README.md",
      "sub/../README.md",
      ".",
      "sub/..",
      cwd,
      `../${cwd.split("/").at(-1)}/nested/new.txt`,
      "inside-link/new.txt",
      "",
    ]) {
      assert.equal(
        await toolCallOutcome("paths-in-cwd", "read", { path }, cwd),
        "pass",
        path,
      );
    }

    for (const path of [
      "../secret.txt",
      sibling,
      `${sibling}/file.txt`,
      "escape/file.txt",
      "escape/../outside.txt",
    ]) {
      assert.equal(
        await toolCallOutcome("paths-in-cwd", "write", { path }, cwd),
        "block",
        path,
      );
    }

    assert.equal(await toolCallOutcome("paths-in-cwd", "read", {}, cwd), "pass");
    assert.equal(await toolCallOutcome("paths-in-cwd", "read", { path: 42 }, cwd), "block");
    assert.equal(await toolCallOutcome("paths-in-cwd", "bash", { path: sibling }, cwd), "pass");
    assert.equal(
      await toolCallOutcome("paths-in-cwd", "edit", { path: "file.txt" }, cwd, { PATH: fixture("no-node") }),
      "block",
    );
  });

  it("write-new-files-only distinguishes absent paths from every existing path kind", async () => {
    const cwd = fixture("write-new-files-only");
    writeFileSync(join(cwd, "existing.txt"), "existing\n");
    mkdirSync(join(cwd, "existing-directory"));
    mkdirSync(join(cwd, "nested"));
    symlinkSync("missing-target", join(cwd, "dangling-link"));

    assert.equal(await toolCallOutcome("write-new-files-only", "write", { path: "new.txt" }, cwd), "pass");
    assert.equal(await toolCallOutcome("write-new-files-only", "write", { path: "nested/new.txt" }, cwd), "pass");
    assert.equal(await toolCallOutcome("write-new-files-only", "write", { path: "existing.txt" }, cwd), "block");
    assert.equal(await toolCallOutcome("write-new-files-only", "write", { path: "existing-directory" }, cwd), "block");
    assert.equal(await toolCallOutcome("write-new-files-only", "write", { path: "dangling-link" }, cwd), "block");
    assert.equal(await toolCallOutcome("write-new-files-only", "write", {}, cwd), "block");
    assert.equal(await toolCallOutcome("write-new-files-only", "write", { path: "" }, cwd), "block");
    assert.equal(await toolCallOutcome("write-new-files-only", "write", { path: 42 }, cwd), "block");
    assert.equal(await toolCallOutcome("write-new-files-only", "edit", { path: "existing.txt" }, cwd), "pass");
    assert.equal(
      await toolCallOutcome("write-new-files-only", "write", { path: "other.txt" }, cwd, { PATH: fixture("write-no-node") }),
      "block",
    );
  });
});
