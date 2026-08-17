import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  agentEndOutcome,
  executable,
  fixture,
  git,
  gitRepository,
  lines,
} from "./fixtures.js";

describe("Core Git Hooks", () => {
  it("git-diff-check reports tracked whitespace errors and conflict markers", async () => {
    const clean = gitRepository("git-diff-clean");
    assert.equal(await agentEndOutcome("git-diff-check", clean), "pass");

    appendFileSync(join(clean, "base.txt"), "trailing space  \n");
    assert.equal(await agentEndOutcome("git-diff-check", clean), "report");

    const conflict = gitRepository("git-diff-conflict");
    appendFileSync(
      join(conflict, "base.txt"),
      "<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> branch\n",
    );
    git(conflict, "add", "base.txt");
    assert.equal(await agentEndOutcome("git-diff-check", conflict), "report");
  });

  it("require-no-change rejects tracked, staged, untracked, empty, and binary changes", async () => {
    const cwd = gitRepository("require-no-change");
    assert.equal(await agentEndOutcome("require-no-change", cwd), "pass");

    appendFileSync(join(cwd, "base.txt"), "unstaged\n");
    assert.equal(await agentEndOutcome("require-no-change", cwd), "report");
    git(cwd, "reset", "--hard", "--quiet", "HEAD");

    appendFileSync(join(cwd, "base.txt"), "staged\n");
    git(cwd, "add", "base.txt");
    assert.equal(await agentEndOutcome("require-no-change", cwd), "report");
    git(cwd, "reset", "--hard", "--quiet", "HEAD");

    writeFileSync(join(cwd, "untracked.txt"), "one\n");
    assert.equal(await agentEndOutcome("require-no-change", cwd), "report");
    rmSync(join(cwd, "untracked.txt"));

    writeFileSync(join(cwd, "empty.txt"), "");
    assert.equal(await agentEndOutcome("require-no-change", cwd), "report");
    rmSync(join(cwd, "empty.txt"));

    writeFileSync(join(cwd, "base.txt"), Buffer.from([0, 1, 2, 3]));
    assert.equal(await agentEndOutcome("require-no-change", cwd), "report");

    const unborn = fixture("require-no-change-unborn");
    git(unborn, "init", "--quiet");
    assert.equal(await agentEndOutcome("require-no-change", unborn), "report");
  });

  it("counts staged and unstaged tracked changes while ignoring untracked files", async () => {
    const cwd = gitRepository("git-mixed-lines", 1);
    appendFileSync(join(cwd, "base.txt"), lines(2, "staged"));
    git(cwd, "add", "base.txt");
    appendFileSync(join(cwd, "base.txt"), lines(2, "unstaged"));
    writeFileSync(join(cwd, "untracked.txt"), lines(20, "untracked"));

    assert.equal(await agentEndOutcome("diff-max-10-lines", cwd), "pass");
    appendFileSync(join(cwd, "base.txt"), lines(7, "more"));
    assert.equal(await agentEndOutcome("diff-max-10-lines", cwd), "report");
  });

  it("combines additions and deletions at the diff boundary", async () => {
    const cwd = gitRepository("git-added-deleted", 20);
    const original = readFileSync(join(cwd, "base.txt"), "utf8").trimEnd().split("\n");
    writeFileSync(
      join(cwd, "base.txt"),
      `${original.slice(6).join("\n")}\n${lines(4, "replacement")}`,
    );
    assert.equal(await agentEndOutcome("diff-max-10-lines", cwd), "pass");
    appendFileSync(join(cwd, "base.txt"), "over-limit\n");
    assert.equal(await agentEndOutcome("diff-max-10-lines", cwd), "report");
  });

  for (const limit of [10, 50, 100, 250, 500, 1_000, 2_000, 5_000]) {
    const name = `diff-max-${limit}-lines`;
    it(`${name} has an inclusive added-and-deleted boundary`, async () => {
      const cwd = gitRepository(name, 1);
      appendFileSync(join(cwd, "base.txt"), lines(limit - 1, "added"));
      assert.equal(await agentEndOutcome(name, cwd), "pass");
      appendFileSync(join(cwd, "base.txt"), "at-limit\n");
      assert.equal(await agentEndOutcome(name, cwd), "pass");
      appendFileSync(join(cwd, "base.txt"), "over-limit\n");
      assert.equal(await agentEndOutcome(name, cwd), "report");
    });
  }

  it("counts tracked files with unusual names", async () => {
    const cwd = gitRepository("git-unusual-name", 1);
    const unusual = join(cwd, "odd\tname\nwith-newline.txt");
    writeFileSync(unusual, "baseline\n");
    git(cwd, "add", unusual);
    git(cwd, "commit", "--quiet", "-m", "unusual path baseline");

    appendFileSync(unusual, lines(10, "tracked"));
    assert.equal(await agentEndOutcome("diff-max-10-lines", cwd), "pass");
    appendFileSync(unusual, "eleven\n");
    assert.equal(await agentEndOutcome("diff-max-10-lines", cwd), "report");
  });

  it("fails line policies closed for binary, malformed, and unusable Git environments", async () => {
    const binary = gitRepository("git-binary", 1);
    writeFileSync(join(binary, "base.txt"), Buffer.from([0, 1, 2, 3]));
    assert.equal(await agentEndOutcome("diff-max-5000-lines", binary), "report");

    const nonRepository = fixture("git-non-repository");
    assert.equal(await agentEndOutcome("diff-max-5000-lines", nonRepository), "report");

    const unborn = fixture("git-unborn");
    git(unborn, "init", "--quiet");
    writeFileSync(join(unborn, "new.txt"), "new\n");
    assert.equal(await agentEndOutcome("diff-max-5000-lines", unborn), "report");

    const missingGit = fixture("git-missing");
    assert.equal(
      await agentEndOutcome("diff-max-5000-lines", missingGit, {
        PATH: join(missingGit, "empty-bin"),
      }),
      "report",
    );

    const malformed = fixture("git-malformed-numstat");
    const bin = join(malformed, "bin");
    mkdirSync(bin);
    executable(join(bin, "git"), "printf 'not-numstat\\n'");
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    assert.equal(
      await agentEndOutcome("diff-max-5000-lines", malformed, environment),
      "report",
    );
    assert.equal(
      await agentEndOutcome("require-more-deletions", malformed, environment),
      "report",
    );
  });

  it("require-more-deletions accepts only a strictly reductive diff", async () => {
    const reductive = gitRepository("git-more-deletions", 20);
    writeFileSync(join(reductive, "base.txt"), lines(15, "base"));
    writeFileSync(join(reductive, "untracked.txt"), lines(100, "ignored"));
    assert.equal(await agentEndOutcome("require-more-deletions", reductive), "pass");

    const equal = gitRepository("git-equal", 20);
    writeFileSync(
      join(equal, "base.txt"),
      `${lines(15, "base")}${lines(5, "replacement")}`,
    );
    assert.equal(await agentEndOutcome("require-more-deletions", equal), "report");

    const additive = gitRepository("git-additive", 20);
    appendFileSync(join(additive, "base.txt"), "addition\n");
    assert.equal(await agentEndOutcome("require-more-deletions", additive), "report");
  });
});
