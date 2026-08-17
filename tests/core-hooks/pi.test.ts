import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HookEvaluation } from "../../hookit/hook-evaluation/index.js";
import { HooksState } from "../../hookit/ui/state.js";
import { CORE_SOURCE, loadCoreEntries } from "./index.js";
import { fixture, toolCallOutcome } from "./fixtures.js";

describe("Core Pi tool controls", () => {
  const blockers = ["read", "bash", "edit", "write", "grep", "find", "ls"];

  for (const toolName of blockers) {
    it(`block-${toolName} matches only ${toolName}`, async () => {
      const cwd = fixture(`block-${toolName}`);
      assert.equal(
        await toolCallOutcome(`block-${toolName}`, toolName, {}, cwd),
        "block",
      );
      assert.equal(
        await toolCallOutcome(`block-${toolName}`, `my-${toolName}`, {}, cwd),
        "pass",
      );
    });
  }

  it("read-only expands through session enablement to exactly three blockers", async () => {
    const root = fixture("read-only");
    const project = join(root, ".pi", "hookit.json");
    mkdirSync(dirname(project), { recursive: true });
    writeFileSync(project, `${JSON.stringify({
      repos: [CORE_SOURCE],
      [CORE_SOURCE]: Object.fromEntries(loadCoreEntries()),
    })}\n`);

    const state = new HooksState({ appendEntry() {} } as never);
    state.load({ global: join(root, "global.json"), project });
    const preset = state.entries.find(
      (entry) => entry.source === CORE_SOURCE && entry.name === "read-only",
    );
    assert.ok(preset);
    state.enable(preset);

    const evaluator = new HookEvaluation();
    for (const [toolName, expected] of [
      ["bash", "block"],
      ["write", "block"],
      ["edit", "block"],
      ["read", "pass"],
      ["grep", "pass"],
      ["find", "pass"],
      ["ls", "pass"],
    ] as const) {
      const outcome = await evaluator.evaluate(
        "tool_call",
        { toolName, toolCallId: `call-${toolName}`, input: {} },
        { cwd: root, metadata: {} },
        state.enabledHookSet(),
      );
      assert.equal(outcome.eventOutcomes[0].outcome, expected, toolName);
      assert.equal(
        outcome.evaluationReport?.rows.length ?? 0,
        expected === "block" ? 1 : 0,
        toolName,
      );
    }
  });
});
