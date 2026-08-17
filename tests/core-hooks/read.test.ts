import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fixture, toolResultOutcome } from "./fixtures.js";

describe("Core read-result thresholds", () => {
  for (const limit of [500, 10_000, 20_000, 50_000, 100_000, 200_000]) {
    const name = `read-max-${limit}-chars`;
    it(`${name} has an inclusive boundary`, async () => {
      const cwd = fixture(name);
      assert.equal(await toolResultOutcome(name, "read", "x".repeat(limit - 1), cwd), "pass");
      assert.equal(await toolResultOutcome(name, "read", "x".repeat(limit), cwd), "pass");
      assert.equal(await toolResultOutcome(name, "read", "x".repeat(limit + 1), cwd), "patch");
      assert.equal(await toolResultOutcome(name, "bash", "x".repeat(limit + 1), cwd), "pass");
    });
  }

  it("counts multibyte text as characters regardless of the inherited locale", async () => {
    const cwd = fixture("read-multibyte");
    const locale = { LANG: "C", LC_ALL: "C" };
    assert.equal(
      await toolResultOutcome("read-max-500-chars", "read", "é".repeat(500), cwd, locale),
      "pass",
    );
    assert.equal(
      await toolResultOutcome("read-max-500-chars", "read", "é".repeat(501), cwd, locale),
      "patch",
    );
  });

  it("reports unavailable character-counting machinery", async () => {
    const cwd = fixture("read-missing-node");
    assert.equal(
      await toolResultOutcome("read-max-500-chars", "read", "safe", cwd, {
        PATH: `${cwd}/empty-bin`,
      }),
      "patch",
    );
  });
});
