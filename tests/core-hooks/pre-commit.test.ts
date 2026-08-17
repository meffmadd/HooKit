import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  agentEndOutcome,
  assertAgentEndCommand,
  executable,
  fixture,
} from "./fixtures.js";

describe("Core pre-commit workflow Hooks", () => {
  const commands = new Map([
    ["pre-commit-run", "run"],
    ["pre-commit-run-all-files", "run --all-files"],
  ]);

  for (const [name, expectedArguments] of commands) {
    it(`${name} runs its exact pre-commit command and reports command failure`, async () => {
      await assertAgentEndCommand(name, "pre-commit", expectedArguments, (cwd) => {
        writeFileSync(join(cwd, ".pre-commit-config.yaml"), "repos: []\n");
      });
    });
  }

  it("skips projects without pre-commit configuration", async () => {
    const cwd = fixture("pre-commit-not-configured");
    const bin = join(cwd, "bin");
    const log = join(cwd, "pre-commit.log");
    mkdirSync(bin);
    executable(join(bin, "pre-commit"), `touch "${log}"`);

    for (const name of commands.keys()) {
      assert.equal(await agentEndOutcome(name, cwd, { PATH: bin }), "pass", name);
    }
    assert.equal(existsSync(log), false);
  });

  it("reports missing pre-commit in a configured project", async () => {
    const cwd = fixture("pre-commit-missing");
    writeFileSync(join(cwd, ".pre-commit-config.yaml"), "repos: []\n");
    for (const name of commands.keys()) {
      assert.equal(
        await agentEndOutcome(name, cwd, { PATH: join(cwd, "empty-bin") }),
        "report",
        name,
      );
    }
  });
});
