/**
 * Tests for the pure fuzzy matcher (`pi-assert/ui/fuzzy.ts`).
 *
 * These assert subsequence match/non-match, returned highlighting positions,
 * and the four coarse field-tier orderings with stable within-section order —
 * not raw scores (there are none).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fuzzyMatch,
  matchQuery,
  filterSection,
  highlightSegments,
} from "../pi-assert/ui/fuzzy.js";
import type { CatalogEntry } from "../pi-assert/assertion-catalog/index.js";

function makeAssert(
  name: string,
  opts: {
    source?: string;
    description?: string;
    shell?: string;
    when?: string;
  } = {},
): CatalogEntry {
  return {
    name,
    source: opts.source ?? "local",
    description: opts.description ?? "",
    hook: "tool_call",
    shell: opts.shell ?? "true",
    when: opts.when,
    default: false,
    path: `/tmp/${name}.json`,
  };
}

function makeAction(name: string): CatalogEntry {
  return {
    name,
    source: "local",
    description: "integration notification",
    hook: "assert_result",
    shell: "true",
    action: {
      type: "message",
      outcome: "pass",
      message: "Please investigate",
      delivery: "followUp",
      triggerTurn: true,
    },
    default: false,
  };
}

/** Build a `PresetAssert` (a `preset`-ref bundle) for `filterSection` tests. */
function makePreset(
  name: string,
  refs: string[] = [],
  opts: { source?: string; description?: string } = {},
): CatalogEntry {
  return {
    name,
    source: opts.source ?? "local",
    description: opts.description ?? "",
    preset: refs,
    default: false,
    path: `/tmp/${name}.json`,
  };
}

// ── fuzzyMatch ─────────────────────────────────────────────────────

describe("fuzzyMatch", () => {
  it("matches a subsequence and returns positions", () => {
    const m = fuzzyMatch("wrg", "write-guard");
    assert.deepEqual(m, [0, 1, 6]); // w,r,g in 'write-guard'
  });

  it("returns null when not a subsequence", () => {
    assert.equal(fuzzyMatch("xyz", "write-guard"), null);
  });

  it("is case-insensitive", () => {
    assert.deepEqual(fuzzyMatch("ENV", "no-env"), [3, 4, 5]);
  });

  it("returns an empty position list for an empty query", () => {
    assert.deepEqual(fuzzyMatch("", "anything"), []);
  });

  it("matches an extremely scattered subsequence", () => {
    const target = "g" + "x".repeat(120) + "i" + "x".repeat(120) + "t";
    const m = fuzzyMatch("git", target);
    assert.ok(m, "a scattered subsequence still matches");
    assert.deepEqual(m, [0, 121, 242]);
  });
});

// ── matchQuery (query normalization seam) ───────────────────────────

describe("matchQuery", () => {
  it("ignores spaces in the query (v1a strip)", () => {
    assert.deepEqual(matchQuery("no env", "no-env"), [0, 1, 3, 4, 5],
      "'no env' matches 'no-env' space-stripped");
  });

  it("a whitespace-only query strips to empty and matches", () => {
    assert.deepEqual(matchQuery(" ", "x"), []);
    assert.deepEqual(matchQuery("   ", "anything"), []);
  });
});

// ── highlightSegments ──────────────────────────────────────────

describe("highlightSegments", () => {
  it("returns null for an empty query", () => {
    assert.equal(highlightSegments("", "no-env"), null);
  });

  it("returns null for a whitespace-only query", () => {
    assert.equal(highlightSegments("   ", "no-env"), null);
  });

  it("returns null when the query is not a subsequence", () => {
    assert.equal(highlightSegments("xyz", "no-env"), null);
  });

  it("splits a contiguous match into matched/unmatched runs", () => {
    const segs = highlightSegments("env", "no-env")!;
    assert.deepEqual(segs, [
      { text: "no-", matched: false },
      { text: "env", matched: true },
    ]);
  });

  it("matches a whole target as a single matched run", () => {
    assert.deepEqual(highlightSegments("env", "env"), [
      { text: "env", matched: true },
    ]);
  });

  it("reconstructs the target and marks exactly the matched indices", () => {
    const segs = highlightSegments("wrg", "write-guard")!;
    assert.equal(segs.map((s) => s.text).join(""), "write-guard");
    const matchedIdx: number[] = [];
    let i = 0;
    for (const s of segs) {
      for (let j = 0; j < s.text.length; j++) {
        if (s.matched) matchedIdx.push(i);
        i++;
      }
    }
    assert.deepEqual(matchedIdx, [0, 1, 6]);
  });

  it("is case-insensitive", () => {
    const segs = highlightSegments("ENV", "no-env")!;
    assert.ok(segs.some((s) => s.matched && s.text.toLowerCase() === "env"));
  });

  it("uses the same positions as eligibility", () => {
    // Every position `filterSection` ranks on is exactly what highlights.
    const m = matchQuery("env", "protect-env")!;
    const segs = highlightSegments("env", "protect-env")!;
    const highlighted: number[] = [];
    let i = 0;
    for (const s of segs) {
      for (let j = 0; j < s.text.length; j++) {
        if (s.matched) highlighted.push(i);
        i++;
      }
    }
    assert.deepEqual(highlighted, Array.from(m));
  });
});

// ── filterSection ───────────────────────────────────────────────────

describe("filterSection", () => {
  it("empty query returns all entries in original order", () => {
    const a = makeAssert("alpha");
    const b = makeAssert("beta");
    const out = filterSection("", [a, b]);
    assert.deepEqual(out, [a, b]);
  });

  it("whitespace-only query returns all entries in original order", () => {
    const a = makeAssert("alpha");
    const b = makeAssert("beta");
    const out = filterSection("   ", [a, b]);
    assert.deepEqual(out, [a, b]);
  });

  it("filters to matching entries", () => {
    const a = makeAssert("write-guard");
    const b = makeAssert("no-env");
    const out = filterSection("env", [a, b]);
    assert.deepEqual(out, [b]);
  });

  it("name outranks description", () => {
    const perfectDesc = makeAssert("zzz", { description: "env" });
    const poorName = makeAssert("env", { description: "unrelated" });
    const out = filterSection("env", [perfectDesc, poorName]);
    assert.deepEqual(out, [poorName, perfectDesc],
      "a name match outranks a description match");
  });

  it("description outranks source", () => {
    const descMatch = makeAssert("x", { description: "env" });
    const sourceMatch = makeAssert("y", { source: "owner/env-tools" });
    const out = filterSection("env", [descMatch, sourceMatch]);
    assert.deepEqual(out, [descMatch, sourceMatch],
      "description outranks source");
  });

  it("source outranks body fields", () => {
    const sourceMatch = makeAssert("x", { source: "owner/env-tools" });
    const shellMatch = makeAssert("y", { shell: "grep env .env" });
    const out = filterSection("env", [sourceMatch, shellMatch]);
    assert.deepEqual(out, [sourceMatch, shellMatch],
      "source outranks shell");
  });

  it("shell, when, Action detail, and Preset refs share one tier", () => {
    const shellMatch = makeAssert("s", { shell: "grep env .env" });
    const whenMatch = makeAssert("w", { when: "test -f ./env" });
    const actionMatch = makeAction("a");
    const presetMatch = makePreset("p", ["local/env-guard"]);
    // Each matches only via its body field: same tier → catalog order.
    const bodyEntries = [shellMatch, whenMatch, actionMatch, presetMatch];
    const out = filterSection("env", bodyEntries);
    assert.deepEqual(out, bodyEntries,
      "body-tier matches retain catalog order");
  });

  it("same-tier matches preserve catalog order regardless of match gaps", () => {
    // Both match only via shell (same tier); the scattered one must NOT
    // outrank the tight one (no match-gap quality heuristics).
    const tight = makeAssert("t", { shell: "env " });
    const scattered = makeAssert("s", {
      shell: "e" + "x".repeat(40) + "n" + "x".repeat(40) + "v",
    });
    const out = filterSection("env", [scattered, tight]);
    assert.deepEqual(out, [scattered, tight],
      "same-tier entries keep catalog order even across a huge gap");
  });

  it("is stable on ties (original within-section order preserved)", () => {
    const first = makeAssert("aaa-env");
    const second = makeAssert("bbb-env");
    const out = filterSection("env", [first, second]);
    assert.deepEqual(out, [first, second]);
  });

  it("does not throw when description/when are absent (test-constructed)", () => {
    const a: CatalogEntry = {
      name: "no-env",
      source: "local",
      hook: "tool_call",
      shell: "true",
      default: false,
      // description intentionally omitted
    } as unknown as CatalogEntry;
    const out = filterSection("env", [a]);
    assert.deepEqual(out, [a]);
  });

  it("matches against the `when` field", () => {
    const a = makeAssert("x", { when: "test -f ./env" });
    assert.deepEqual(filterSection("env", [a]), [a]);
  });

  it("matches against the owned Action detail at the body tier", () => {
    const action = makeAction("notify");
    assert.deepEqual(filterSection("followUp", [action]), [action]);
    assert.deepEqual(filterSection("investigate", [action]), [action]);
    assert.deepEqual(filterSection("triggerTurn", [action]), [action]);
  });

  it("excludes entries that match no field", () => {
    const a = makeAssert("write-guard");
    const b = makeAssert("no-secrets");
    assert.deepEqual(filterSection("zzz", [a, b]), []);
  });
});

// ── preset field (coerce) ─────────────────────────────────────────────

describe("filterSection — preset field", () => {
  it("matches a preset via its `preset` refs (coerced to a joined string)", () => {
    const p = makePreset("my-preset", [
      "local/block-rm-rf",
      "meffmadd/pi-assert-rules/protect-env",
    ]);
    assert.deepEqual(filterSection("protect-env", [p]), [p]);
  });

  it("matches a ref that appears after the join separator", () => {
    const p = makePreset("p", ["local/foo", "local/bar"]);
    assert.deepEqual(filterSection("bar", [p]), [p]);
  });

  it("tier dominance: name outranks preset", () => {
    const nameMatch = makePreset("env-preset", ["local/x"]);
    const presetMatch = makePreset("other", ["local/env-guard"]);
    const out = filterSection("env", [nameMatch, presetMatch]);
    assert.deepEqual(out, [nameMatch, presetMatch],
      "name outranks a preset-ref body match");
  });

  it("an empty preset array does not match on the preset field", () => {
    const p = makePreset("zzz", []);
    assert.deepEqual(filterSection("zzz", [p]), [p],
      "still matches via its name");
  });

  it("a preset whose refs don't contain the query is excluded", () => {
    const p = makePreset("p", ["local/foo"]);
    assert.deepEqual(filterSection("bar", [p]), []);
  });

  it("shell asserts are unaffected (preset field is undefined → coerce yields \"\")", () => {
    const a = makeAssert("write-guard", { shell: "echo hi" });
    assert.deepEqual(filterSection("hi", [a]), [a]);
  });
});

// ── highlightSegments — joined preset refs ─────────────────────────────

describe("highlightSegments — joined preset refs", () => {
  it("highlights a ref that sits after the ', ' join separator", () => {
    const joined = ["local/foo", "owner/repo/bar"].join(", ");
    const segs = highlightSegments("bar", joined)!;
    assert.ok(segs, "the joined ref string is searchable");
    assert.equal(segs.map((s) => s.text).join(""), joined);
    assert.ok(
      segs.some((s) => s.matched && s.text === "bar"),
      "the ref after the comma is a highlighted run",
    );
  });

  it("returns null when the query is not a subsequence of any ref", () => {
    const joined = ["local/foo", "owner/repo/bar"].join(", ");
    assert.equal(highlightSegments("zzz", joined), null);
  });
});
