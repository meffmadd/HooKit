import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { HookCatalog } from "../hookit/hook-catalog/index.js";
import { HookEvaluation } from "../hookit/hook-evaluation/index.js";
import { HooksState } from "../hookit/ui/state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(name: string): {
  root: string;
  global: string;
  project: string;
  state: HooksState;
  persisted: string[][];
} {
  const root = mkdtempSync(join(tmpdir(), `HooKit-state-${name}-`));
  roots.push(root);
  const global = join(root, "global", "hookit.json");
  const project = join(root, "project", ".pi", "hookit.json");
  const persisted: string[][] = [];
  const state = new HooksState({
    appendEntry(_type: string, data: { enabledEntries: string[] }) {
      persisted.push(data.enabledEntries);
    },
  } as unknown as ExtensionAPI);
  return { root, global, project, state, persisted };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function context(
  enabledEntries?: string[],
  legacyActiveHooks?: string[],
): ExtensionContext {
  const hasConfig = enabledEntries !== undefined || legacyActiveHooks !== undefined;
  return {
    sessionManager: {
      getBranch: () => !hasConfig
        ? []
        : [{
            type: "custom",
            customType: "hookit-config",
            data: {
              ...(enabledEntries === undefined ? {} : { enabledEntries }),
              ...(legacyActiveHooks === undefined ? {} : { activeHooks: legacyActiveHooks }),
            },
          }],
    },
  } as unknown as ExtensionContext;
}

function shell(command: string, isDefault = false) {
  return {
    description: "guard",
    event: "tool_call",
    shell: command,
    ...(isDefault ? { default: true } : {}),
  };
}

describe("session state enabled Catalog Entries", () => {
  it("initializes Hooks and Presets from defaults only when no saved enablement exists", () => {
    const { global, project, state } = setup("defaults");
    writeJson(project, {
      local: {
        enabled: shell("true", true),
        disabled: shell("true"),
        bundle: {
          description: "default Preset",
          preset: ["local/disabled"],
          default: true,
        },
      },
    });
    state.load({ global, project });
    state.restore(context());

    assert.deepEqual(Array.from(state.enabledEntries), [
      "local\x00enabled",
      "local\x00bundle",
    ]);
    assert.equal(state.enabledHookSet().size, 2);
  });

  it("does not restore legacy activeHooks as an alias", () => {
    const { global, project, state } = setup("legacy-active-hooks");
    writeJson(project, {
      local: {
        currentDefault: shell("true", true),
        legacyChoice: shell("true"),
      },
    });
    state.load({ global, project });
    state.restore(context(undefined, ["local\x00legacyChoice"]));

    assert.deepEqual(Array.from(state.enabledEntries), ["local\x00currentDefault"]);
  });

  it("an explicitly saved empty set overrides defaults", () => {
    const { global, project, state } = setup("saved-empty");
    writeJson(project, {
      local: {
        guard: shell("true", true),
        bundle: {
          description: "bundle",
          preset: ["local/guard"],
          default: true,
        },
      },
    });
    state.load({ global, project });
    state.restore(context([]));

    assert.deepEqual(Array.from(state.enabledEntries), []);
    assert.equal(state.enabledHookSet().size, 0);
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

    assert.deepEqual(Array.from(state.enabledEntries),
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

    assert.deepEqual(Array.from(state.enabledEntries), ["local\x00other"]);
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
    // enablement entry (even one with nothing restorable) means saved mode.
    assert.deepEqual(Array.from(state.enabledEntries), []);
    state.enable("local\x00guard");
    state.persist();
    assert.deepEqual(state.enabledEntries.size, 1);
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
    assert.deepEqual(Array.from(state.enabledEntries), ["local\x00keep"]);
    state.persist();
    assert.deepEqual(persisted, [["local\x00keep"]]);
  });

  it("keeps an enabled identity when removing an override reveals global", () => {
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
    assert.deepEqual(Array.from(state.enabledEntries), ["local\x00same"]);
    const revealed = state.entries[0]!;
    assert.ok("shell" in revealed);
    assert.equal(revealed.shell, "global");
  });

  it("recomputes default-derived enablement on replacement", () => {
    const { global, project, state } = setup("new-defaults");
    writeJson(project, { local: { first: shell("true", true) } });
    state.load({ global, project });
    state.restore(context());
    writeJson(project, { local: { second: shell("true", true) } });

    const result = state.refresh();
    assert.equal(result.ok, true);
    assert.deepEqual(Array.from(state.enabledEntries), ["local\x00second"]);
  });

  it("keeps the known-good Catalog and enablement after a failed mutation", () => {
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
    assert.deepEqual(Array.from(state.enabledEntries), ["local\x00guard"]);
    assert.equal(state.enabledHookSet().size, 1);
  });

  it("a saved branch ignores defaults introduced by Catalog replacement", () => {
    const { global, project, state } = setup("accept");
    writeJson(project, { local: { one: shell("true") } });
    state.load({ global, project });
    state.restore(context(["local\x00one"]));
    writeJson(project, { local: { two: shell("true", true) } });
    const opened = HookCatalog.open({ global, project });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    state.replaceCatalog(opened.catalog);
    assert.deepEqual(state.entries.map((entry) => entry.name), ["two"]);
    assert.deepEqual(Array.from(state.enabledEntries), []);
  });
});

describe("session state Enabled Hook Set", () => {
  it("expands presets in ref order and skips dangling refs", async () => {
    const { root, global, project, state } = setup("preset");
    const log = join(root, "order.log");
    const append = (name: string) => `printf '${name}\\n' >> '${log}'`;
    writeJson(project, {
      local: {
        a: shell(append("a")),
        b: shell(append("b")),
        bundle: {
          description: "bundle",
          preset: [
            "local/b",
            "local/a",
            "local/missing",
          ],
        },
      },
    });
    state.load({ global, project });
    state.restore(context(["local\x00bundle"]));

    const enabledSet = state.enabledHookSet();
    assert.equal(enabledSet.size, 2);
    const evaluated = await new HookEvaluation().evaluate(
      "tool_call",
      { toolName: "bash", toolCallId: "state", input: {} },
      { cwd: root, metadata: {} },
      enabledSet,
    );
    assert.equal(evaluated.eventOutcomes[0].outcome, "pass");
    assert.equal(readFileSync(log, "utf8"), "b\na\n");
  });

  it("deduplicates direct and multiple Preset paths by first Catalog occurrence", async () => {
    const { root, global, project, state } = setup("deduplicate-paths");
    const log = join(root, "deduplicated.log");
    const append = (name: string) => `printf '${name}\\n' >> '${log}'`;
    writeJson(project, {
      local: {
        direct: shell(append("direct")),
        shared: shell(append("shared")),
        first: {
          description: "first",
          preset: ["local/shared", "local/direct"],
        },
        second: {
          description: "second",
          preset: ["local/shared"],
        },
      },
    });
    state.load({ global, project });
    state.restore(context([
      "local\x00direct",
      "local\x00first",
      "local\x00second",
    ]));

    const evaluated = await new HookEvaluation().evaluate(
      "tool_call",
      { toolName: "bash", toolCallId: "deduplicate", input: {} },
      { cwd: root, metadata: {} },
      state.enabledHookSet(),
    );

    assert.equal(evaluated.eventOutcomes[0].outcome, "pass");
    assert.equal(readFileSync(log, "utf8"), "direct\nshared\n");
  });

  it("disabling one Preset removes only its enablement path", async () => {
    const { root, global, project, state } = setup("disable-one-path");
    const log = join(root, "paths.log");
    writeJson(project, {
      local: {
        member: shell(`printf member >> '${log}'`),
        first: { description: "first", preset: ["local/member"] },
        second: { description: "second", preset: ["local/member"] },
      },
    });
    state.load({ global, project });
    state.restore(context(["local\x00first", "local\x00second"]));
    state.disable("local\x00first");

    await new HookEvaluation().evaluate(
      "tool_call",
      { toolName: "bash", toolCallId: "remaining-path", input: {} },
      { cwd: root, metadata: {} },
      state.enabledHookSet(),
    );
    assert.equal(readFileSync(log, "utf8"), "member");

    state.enable("local\x00member");
    state.disable("local\x00second");
    await new HookEvaluation().evaluate(
      "tool_call",
      { toolName: "bash", toolCallId: "direct-path", input: {} },
      { cwd: root, metadata: {} },
      state.enabledHookSet(),
    );
    assert.equal(readFileSync(log, "utf8"), "membermember");
  });

  it("keeps a dangling Preset directly enabled while enabling available members", () => {
    const { global, project, state } = setup("dangling-enabled-preset");
    writeJson(project, {
      local: {
        available: shell("true"),
        bundle: {
          description: "bundle",
          preset: ["local/missing", "local/available"],
        },
      },
    });
    state.load({ global, project });
    state.restore(context(["local\x00bundle"]));

    assert.equal(state.isEnabledDirectly(state.entries.find((entry) => entry.name === "bundle")!), true);
    assert.deepEqual(Array.from(state.enabledEntries), ["local\x00bundle"]);
    assert.equal(state.enabledHookSet().size, 1);
  });

  it("expands Hooks with owned Actions through presets", async () => {
    const { root, global, project, state } = setup("preset-action");
    writeJson(project, {
      local: {
        guard: shell("true"),
        notify: {
          description: "notify",
          event: "tool_call",
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
      state.enabledHookSet(),
    );
    assert.equal(evaluated.eventOutcomes[0].outcome, "pass");
    assert.deepEqual(
      (evaluated.evaluationReport?.rows ?? [])
        .filter((row) => row.type === "action")
        .map((row) => row.hookRef),
      ["local/notify"],
    );
  });

  it("captures an immutable set before later enablement changes", async () => {
    const { root, global, project, state } = setup("immutable");
    const log = join(root, "captured.log");
    writeJson(project, {
      local: {
        guard: shell(`printf captured > '${log}'`),
      },
    });
    state.load({ global, project });
    state.restore(context(["local\x00guard"]));
    const captured = state.enabledHookSet();
    state.disable("local\x00guard");

    await new HookEvaluation().evaluate(
      "tool_call",
      { toolName: "bash", toolCallId: "captured", input: {} },
      { cwd: root, metadata: {} },
      captured,
    );
    assert.equal(readFileSync(log, "utf8"), "captured");
    assert.equal(state.enabledHookSet().size, 0);
  });
});
