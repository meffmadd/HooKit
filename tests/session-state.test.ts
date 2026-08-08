import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AssertionCatalog } from "../pi-assert/assertion-catalog/index.js";
import { HookEvaluation } from "../pi-assert/hook-evaluation/index.js";
import { AssertsState } from "../pi-assert/ui/state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(name: string): {
  root: string;
  global: string;
  project: string;
  state: AssertsState;
  persisted: string[][];
} {
  const root = mkdtempSync(join(tmpdir(), `pi-assert-state-${name}-`));
  roots.push(root);
  const global = join(root, "global", "asserts.json");
  const project = join(root, "project", ".pi", "asserts.json");
  const persisted: string[][] = [];
  const state = new AssertsState({
    appendEntry(_type: string, data: { activeAsserts: string[] }) {
      persisted.push(data.activeAsserts);
    },
  } as unknown as ExtensionAPI);
  return { root, global, project, state, persisted };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function context(saved?: string[]): ExtensionContext {
  return {
    sessionManager: {
      getBranch: () => saved === undefined
        ? []
        : [{
            type: "custom",
            customType: "pi-assert-config",
            data: { activeAsserts: saved },
          }],
    },
  } as unknown as ExtensionContext;
}

function shell(command: string, isDefault = false) {
  return {
    description: "guard",
    hook: "tool_call",
    shell: command,
    ...(isDefault ? { default: true } : {}),
  };
}

describe("session state catalog replacement", () => {
  it("initializes from defaults only when no saved activation exists", () => {
    const { global, project, state } = setup("defaults");
    writeJson(project, {
      local: {
        enabled: shell("true", true),
        disabled: shell("true"),
      },
    });
    state.load({ global, project });
    state.restore(context());

    assert.equal(state.isActive(state.entries[0]!), true);
    assert.equal(state.isActive(state.entries[1]!), false);
  });

  it("restores canonical saved keys and prunes missing ones", () => {
    const { global, project, state } = setup("identity");
    writeJson(project, {
      repos: ["owner/repo"],
      local: { guard: shell("true"), gone: shell("true") },
      "owner/repo": { guard: shell("true") },
    });
    state.load({ global, project });
    state.restore(context([
      "local\x00guard",
      "owner/repo\x00guard",
      "local\x00missing", // pruned: not in the catalog
    ]));

    assert.deepEqual(Array.from(state.active),
      ["local\x00guard", "owner/repo\x00guard"]);
  });

  it("silently drops bare saved names, including unambiguous ones", () => {
    const { global, project, state } = setup("bare");
    writeJson(project, {
      local: { guard: shell("true"), other: shell("true") },
    });
    state.load({ global, project });
    // `guard` is unambiguous (only one catalog entry with that name) but is a
    // bare name; it must still be discarded without name resolution.
    state.restore(context(["local\x00other", "guard"]));

    assert.deepEqual(Array.from(state.active), ["local\x00other"]);
  });

  it("a saved entry containing only discarded names still represents saved mode", () => {
    const { global, project, state } = setup("saved-only-discarded");
    writeJson(project, {
      local: {
        guard: shell("true", true), // default would apply in defaults mode
      },
    });
    state.load({ global, project });
    state.restore(context(["bare-name"]));

    // The bare name is discarded AND defaults are not re-enabled: a saved
    // activation entry (even one with nothing restorable) means saved mode.
    assert.deepEqual(Array.from(state.active), []);
    state.enable("local\x00guard");
    state.persist();
    assert.deepEqual(state.active.size, 1);
  });

  it("preserves saved identities across a fresh catalog and prunes removed ones", () => {
    const { global, project, state, persisted } = setup("replace");
    writeJson(project, {
      local: { keep: shell("true"), remove: shell("true") },
    });
    state.load({ global, project });
    state.restore(context(["local\x00keep", "local\x00remove"]));

    const result = state.mutate({
      type: "remove",
      identity: { source: "local", name: "remove" },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(Array.from(state.active), ["local\x00keep"]);
    state.persist();
    assert.deepEqual(persisted, [["local\x00keep"]]);
  });

  it("keeps an active identity when removing an override reveals global", () => {
    const { global, project, state } = setup("reveal");
    writeJson(global, { local: { same: shell("global") } });
    writeJson(project, { local: { same: shell("project") } });
    state.load({ global, project });
    state.restore(context(["local\x00same"]));

    const result = state.mutate({
      type: "remove",
      identity: { source: "local", name: "same" },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(Array.from(state.active), ["local\x00same"]);
    const revealed = state.entries[0]!;
    assert.ok("shell" in revealed);
    assert.equal(revealed.shell, "global");
  });

  it("recomputes default-derived activation on replacement", () => {
    const { global, project, state } = setup("new-defaults");
    writeJson(project, { local: { first: shell("true", true) } });
    state.load({ global, project });
    state.restore(context());
    writeJson(project, { local: { second: shell("true", true) } });

    const result = state.refresh();
    assert.equal(result.ok, true);
    assert.deepEqual(Array.from(state.active), ["local\x00second"]);
  });

  it("keeps the known-good catalog and activation after a failed mutation", () => {
    const { global, project, state } = setup("failed-mutation");
    writeJson(project, { local: { guard: shell("true") } });
    state.load({ global, project });
    state.restore(context(["local\x00guard"]));
    writeFileSync(project, "{ malformed external edit");

    const result = state.mutate({
      type: "set-default",
      identity: { source: "local", name: "guard" },
      value: true,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(state.entries.map((entry) => entry.name), ["guard"]);
    assert.deepEqual(Array.from(state.active), ["local\x00guard"]);
    assert.equal(state.activeAssertionSet().size, 1);
  });

  it("accepts an independently-created fresh catalog", () => {
    const { global, project, state } = setup("accept");
    writeJson(project, { local: { one: shell("true") } });
    state.load({ global, project });
    state.restore(context(["local\x00one"]));
    writeJson(project, { local: { two: shell("true") } });
    const opened = AssertionCatalog.open({ global, project });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    state.replaceCatalog(opened.catalog);
    assert.deepEqual(state.entries.map((entry) => entry.name), ["two"]);
    assert.deepEqual(Array.from(state.active), []);
  });
});

describe("session state Active Assertion Set", () => {
  it("expands presets in ref order, deduplicates, and skips dangling or nested refs", async () => {
    const { root, global, project, state } = setup("preset");
    const log = join(root, "order.log");
    const append = (name: string) => `printf '${name}\\n' >> '${log}'`;
    writeJson(project, {
      local: {
        a: shell(append("a")),
        b: shell(append("b")),
        nested: { description: "nested", preset: ["local/a"] },
        bundle: {
          description: "bundle",
          preset: [
            "local/b",
            "local/a",
            "local/a",
            "local/missing",
            "local/nested",
          ],
        },
      },
    });
    state.load({ global, project });
    state.restore(context(["local\x00bundle"]));

    const activeSet = state.activeAssertionSet();
    assert.equal(activeSet.size, 2);
    const evaluated = await new HookEvaluation().evaluate(
      "tool_call",
      { toolName: "bash", toolCallId: "state", input: {} },
      { cwd: root, metadata: {} },
      activeSet,
    );
    assert.equal(evaluated.outcome, "pass");
    assert.equal(readFileSync(log, "utf8"), "b\na\n");
  });

  it("expands Assertions with owned Actions through presets", async () => {
    const { root, global, project, state } = setup("preset-action");
    writeJson(project, {
      local: {
        guard: shell("true"),
        notify: {
          description: "notify",
          hook: "tool_call",
          action: { type: "interrupt", outcome: "pass" },
        },
        bundle: {
          description: "bundle",
          preset: ["local/guard", "local/notify"],
        },
      },
    });
    state.load({ global, project });
    state.restore(context(["local\x00bundle"]));

    const evaluated = await new HookEvaluation().evaluate(
      "tool_call",
      { toolName: "bash", toolCallId: "preset-action", input: {} },
      { cwd: root, metadata: {} },
      state.activeAssertionSet(),
    );
    assert.equal(evaluated.outcome, "pass");
    assert.deepEqual(
      (evaluated.executionReport?.rows ?? [])
        .filter((row) => row.type === "action")
        .map((row) => row.assertionRef),
      ["local/notify"],
    );
  });

  it("captures an immutable set before later activation changes", async () => {
    const { root, global, project, state } = setup("immutable");
    const log = join(root, "captured.log");
    writeJson(project, {
      local: {
        guard: shell(`printf captured > '${log}'`),
      },
    });
    state.load({ global, project });
    state.restore(context(["local\x00guard"]));
    const captured = state.activeAssertionSet();
    state.disable("local\x00guard");

    await new HookEvaluation().evaluate(
      "tool_call",
      { toolName: "bash", toolCallId: "captured", input: {} },
      { cwd: root, metadata: {} },
      captured,
    );
    assert.equal(readFileSync(log, "utf8"), "captured");
    assert.equal(state.activeAssertionSet().size, 0);
  });
});
