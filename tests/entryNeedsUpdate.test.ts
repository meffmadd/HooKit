/**
 * Tests for the pure outdated-detection functions in installer.ts:
 * `entryContentSignature`, `entryNeedsUpdate`, `classifyEntry`.
 *
 * These are pure (no I/O), so the tests are plain value comparisons.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyEntry,
  entryContentSignature,
  entryNeedsUpdate,
  type EntryState,
  type HookEntry,
  type SignableEntry,
} from "../hookit/installer.js";

// ── Fixtures ─────────────────────────────────────────────────────

const base: SignableEntry = {
  description: "Blocks writes.",
  event: "tool_call",
  shell: "false",
};

/** Clone `base` and override selected fields. */
function with_(
  overrides: Partial<SignableEntry>,
  baseEntry: SignableEntry = base,
): SignableEntry {
  return { ...baseEntry, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════
// entryContentSignature
// ═══════════════════════════════════════════════════════════════════

describe("entryContentSignature", () => {
  it("includes description, event, shell and omits absent filter/when", () => {
    assert.deepStrictEqual(
      entryContentSignature({ description: "d", event: "h", shell: "s" }),
      { description: "d", event: "h", shell: "s" },
    );
  });

  it("includes filter and when only when present", () => {
    assert.deepStrictEqual(
      entryContentSignature({
        description: "d",
        event: "h",
        shell: "s",
        filter: { toolName: "write" },
        when: "true",
      }),
      {
        description: "d",
        event: "h",
        shell: "s",
        filter: { toolName: "write" },
        when: "true",
      },
    );
  });

  it("excludes default (a local-only preference)", () => {
    const sig = entryContentSignature({
      description: "d",
      event: "h",
      shell: "s",
      default: true,
    } as HookEntry);
    assert.ok(!("default" in sig), "default must not appear in the signature");
  });

  it("includes canonical shell and owned Action configuration", () => {
    const sig = entryContentSignature({
      description: "notify",
      event: "hook_result",
      action: {
        type: "message",
        outcome: "pass",
        message: "blocked",
        delivery: "followUp",
      },
      filter: { outcome: "block" },
      when: "true",
      default: true,
    });
    assert.deepEqual(sig, {
      description: "notify",
      event: "hook_result",
      shell: "true",
      action: {
        type: "message",
        outcome: "pass",
        message: "blocked",
        delivery: "followUp",
      },
      filter: { outcome: "block" },
      when: "true",
    });
  });

  it("canonicalizes omitted and explicit true shells identically", () => {
    const implicit = {
      description: "notify",
      event: "tool_call",
      action: { type: "interrupt", outcome: "pass" } as const,
    };
    assert.deepEqual(
      entryContentSignature(implicit),
      entryContentSignature({ ...implicit, shell: "true" }),
    );
    assert.equal(entryNeedsUpdate(implicit, { ...implicit, shell: "true" }), false);
  });

  it("never emits undefined-valued keys", () => {
    const sig = entryContentSignature({
      description: "d",
      event: "h",
      shell: "s",
      filter: undefined,
      when: undefined,
    });
    assert.deepStrictEqual(sig, { description: "d", event: "h", shell: "s" });
    assert.ok(!("filter" in sig));
    assert.ok(!("when" in sig));
  });
});

// ═══════════════════════════════════════════════════════════════════
// entryNeedsUpdate
// ═══════════════════════════════════════════════════════════════════

describe("entryNeedsUpdate", () => {
  it("returns false for identical entries", () => {
    assert.strictEqual(entryNeedsUpdate(base, with_({})), false);
  });

  it("returns true when an owned Action changes", () => {
    assert.equal(
      entryNeedsUpdate(
        {
          description: "notify",
          event: "tool_call",
          action: { type: "interrupt", outcome: "pass" },
        },
        {
          description: "notify",
          event: "tool_call",
          action: { type: "shutdown", outcome: "pass" },
        },
      ),
      true,
    );
  });

  it("returns false when only default differs (default is excluded)", () => {
    const installed = { ...base, default: true } as HookEntry;
    const repo = { ...base } as HookEntry;
    assert.strictEqual(entryNeedsUpdate(installed, repo), false);
  });

  it("returns false when default differs in both directions", () => {
    const installed = { ...base } as HookEntry;
    const repo = { ...base, default: true } as HookEntry;
    assert.strictEqual(entryNeedsUpdate(installed, repo), false);
  });

  it("returns true when description differs", () => {
    assert.strictEqual(
      entryNeedsUpdate(base, with_({ description: "Different." })),
      true,
    );
  });

  it("returns true when event differs", () => {
    assert.strictEqual(
      entryNeedsUpdate(base, with_({ event: "tool_result" })),
      true,
    );
  });

  it("returns true when shell differs", () => {
    assert.strictEqual(entryNeedsUpdate(base, with_({ shell: "true" })), true);
  });

  it("returns true when filter differs", () => {
    assert.strictEqual(
      entryNeedsUpdate(base, with_({ filter: { toolName: "bash" } })),
      true,
    );
  });

  it("returns true when when differs", () => {
    assert.strictEqual(
      entryNeedsUpdate(base, with_({ when: "git diff --quiet" })),
      true,
    );
  });

  it("returns false when filter is absent on both sides", () => {
    assert.strictEqual(
      entryNeedsUpdate(
        { description: "d", event: "h", shell: "s" },
        { description: "d", event: "h", shell: "s" },
      ),
      false,
    );
  });

  it("returns true when filter is present on one side but not the other", () => {
    assert.strictEqual(
      entryNeedsUpdate(
        { description: "d", event: "h", shell: "s" },
        { description: "d", event: "h", shell: "s", filter: { toolName: "x" } },
      ),
      true,
    );
    assert.strictEqual(
      entryNeedsUpdate(
        { description: "d", event: "h", shell: "s", filter: { toolName: "x" } },
        { description: "d", event: "h", shell: "s" },
      ),
      true,
    );
  });

  it("returns false when filter keys are in a different order (order-independent)", () => {
    assert.strictEqual(
      entryNeedsUpdate(
        {
          description: "d",
          event: "h",
          shell: "s",
          filter: { a: "1", b: "2" },
        },
        {
          description: "d",
          event: "h",
          shell: "s",
          filter: { b: "2", a: "1" },
        },
      ),
      false,
    );
  });

  it("returns false when when is absent on both sides", () => {
    assert.strictEqual(
      entryNeedsUpdate(
        { description: "d", event: "h", shell: "s" },
        { description: "d", event: "h", shell: "s" },
      ),
      false,
    );
  });

  it("returns true when when is present on one side but not the other", () => {
    assert.strictEqual(
      entryNeedsUpdate(
        { description: "d", event: "h", shell: "s" },
        { description: "d", event: "h", shell: "s", when: "true" },
      ),
      true,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// classifyEntry
// ═══════════════════════════════════════════════════════════════════

describe("classifyEntry", () => {
  it("returns 'not-installed' when installed is undefined", () => {
    assert.strictEqual(
      classifyEntry(base, undefined),
      "not-installed" as EntryState,
    );
  });

  it("returns 'installed' when content matches", () => {
    assert.strictEqual(
      classifyEntry(base, with_({})),
      "installed" as EntryState,
    );
  });

  it("returns 'installed' when only default differs", () => {
    assert.strictEqual(
      classifyEntry(base, { ...base, default: true } as HookEntry),
      "installed" as EntryState,
    );
  });

  it("returns 'outdated' when shell differs", () => {
    assert.strictEqual(
      classifyEntry(base, with_({ shell: "true" })),
      "outdated" as EntryState,
    );
  });

  it("returns 'outdated' when filter differs", () => {
    assert.strictEqual(
      classifyEntry(base, with_({ filter: { toolName: "bash" } })),
      "outdated" as EntryState,
    );
  });

  it("returns 'outdated' when description differs", () => {
    assert.strictEqual(
      classifyEntry(base, with_({ description: "New description." })),
      "outdated" as EntryState,
    );
  });
});
