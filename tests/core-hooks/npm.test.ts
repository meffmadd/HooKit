import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  agentEndOutcome,
  assertAgentEndCommand,
  fixture,
} from "./fixtures.js";

describe("Core npm workflow Hooks", () => {
  const commands = new Map([
    ["npm-test", "test"],
    ["npm-lint", "run lint"],
    ["npm-build", "run build"],
    ["npm-typecheck", "run typecheck"],
  ]);

  for (const [name, expectedArguments] of commands) {
    it(`${name} runs its exact npm command and reports command failure`, async () => {
      await assertAgentEndCommand(name, "npm", expectedArguments);
    });
  }

  it("reports missing npm, missing scripts, and invalid project metadata", async () => {
    const missingNpm = fixture("npm-missing");
    assert.equal(
      await agentEndOutcome("npm-test", missingNpm, { PATH: join(missingNpm, "empty-bin") }),
      "report",
    );

    const missingProject = fixture("npm-no-project");
    assert.equal(await agentEndOutcome("npm-test", missingProject), "report");

    const missingScripts = fixture("npm-missing-scripts");
    writeFileSync(join(missingScripts, "package.json"), "{\"scripts\":{}}\n");
    for (const name of commands.keys()) {
      assert.equal(await agentEndOutcome(name, missingScripts), "report", name);
    }

    const malformedProject = fixture("npm-malformed-project");
    writeFileSync(join(malformedProject, "package.json"), "{not-json\n");
    assert.equal(await agentEndOutcome("npm-test", malformedProject), "report");
  });
});
