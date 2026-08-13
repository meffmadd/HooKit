import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  HookCatalog,
  type HookIdentity,
  type CatalogResult,
  type CatalogStorageLocations,
} from "../hookit/hook-catalog/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function locations(name: string): CatalogStorageLocations {
  const root = mkdtempSync(join(tmpdir(), `HooKit-catalog-${name}-`));
  roots.push(root);
  return {
    global: join(root, "home", "hookit.json"),
    project: join(root, "project", ".pi", "hookit.json"),
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function catalog(result: CatalogResult): HookCatalog {
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.diagnostics));
  return result.catalog;
}

function find(
  catalog: HookCatalog,
  identity: HookIdentity,
) {
  return catalog.entries.find(
    (entry) => entry.source === identity.source && entry.name === identity.name,
  );
}

function localShell(shell = "true", extra: Record<string, unknown> = {}) {
  return {
    description: "Local guard",
    event: "tool_call",
    shell,
    ...extra,
  };
}

function localAction(
  action: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    description: "Local action",
    event: "tool_call",
    action: { outcome: "pass", ...action },
    ...extra,
  };
}

const remoteShell = {
  description: "Remote guard",
  event: "tool_call" as const,
  shell: "false",
};

const id = (source: string, name: string): HookIdentity => ({ source, name });

describe("Hook Catalog creation", () => {
  it("treats missing authorized files as empty and keeps project authorization", () => {
    const paths = locations("missing");
    const loaded = catalog(HookCatalog.open(paths));

    assert.deepEqual(loaded.entries, []);
    assert.deepEqual(loaded.repositories, []);
    assert.equal(existsSync(paths.global), false);
    assert.equal(existsSync(paths.project!), false);
  });

  it("does not read or write omitted untrusted project storage", () => {
    const paths = locations("untrusted");
    writeJson(paths.global, { local: { safe: localShell() } });
    mkdirSync(dirname(paths.project!), { recursive: true });
    const malformed = "{ keep these malformed bytes";
    writeFileSync(paths.project!, malformed);

    const loaded = catalog(HookCatalog.open({ global: paths.global }));
    assert.deepEqual(loaded.entries.map((entry) => entry.name), ["safe"]);

    const result = loaded.mutate({
      type: "install",
      entries: [{ identity: id("owner/repo", "new"), entry: remoteShell }],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.diagnostics[0]!.reason, /not authorized/);
    assert.equal(readFileSync(paths.project!, "utf8"), malformed);
  });

  it("partitions by source and replaces matching global entries as whole records", () => {
    const paths = locations("merge");
    writeJson(paths.global, {
      repos: ["ignored/global-metadata"],
      local: {
        shared: localShell("global", { when: "global-when" }),
        globalOnly: localShell("global-only"),
      },
      "owner/repo": { sameName: remoteShell },
    });
    writeJson(paths.project!, {
      repos: ["owner/repo", "hidden/repo"],
      local: { shared: localShell("project") },
      "owner/repo": { sameName: { ...remoteShell, shell: "project-repo" } },
      "hidden/repo": { hidden: remoteShell },
    });

    const loaded = catalog(HookCatalog.open(paths));
    assert.deepEqual(
      loaded.entries.map((entry) => `${entry.source}/${entry.name}`),
      ["local/shared", "local/globalOnly", "owner/repo/sameName", "hidden/repo/hidden"],
    );
    const shared = find(loaded, id("local", "shared"));
    assert.ok(shared && "shell" in shared);
    assert.equal(shared.shell, "project");
    assert.equal(shared.when, undefined, "the project record replaces rather than merges");
    assert.ok("shell" in find(loaded, id("hidden/repo", "hidden"))!);
    assert.deepEqual(loaded.repositories, ["owner/repo", "hidden/repo"]);
    assert.equal("path" in shared, false, "storage provenance is not exposed");
  });

  it("uses Source plus name as identity regardless of Catalog Entry kind", () => {
    const paths = locations("identity-across-kinds");
    writeJson(paths.global, {
      local: { shared: localShell("global-hook") },
    });
    writeJson(paths.project!, {
      local: { shared: { description: "Project Preset", preset: [] } },
    });

    const loaded = catalog(HookCatalog.open(paths));

    assert.equal(loaded.entries.length, 1);
    const shared = find(loaded, id("local", "shared"));
    assert.ok(shared && "preset" in shared);
  });

  it("loads and clones normalized Hooks with owned Actions", () => {
    const paths = locations("actions");
    const action = {
      type: "emit-custom-event" as const,
      outcome: "pass" as const,
      name: "test:event",
      data: { nested: [1, true] },
    };
    writeJson(paths.project!, {
      local: {
        handler: {
          description: "Notify an integration",
          event: "hook_result",
          filter: { outcome: "block" },
          when: "true",
          action,
          default: true,
        },
      },
    });

    const loaded = catalog(HookCatalog.open(paths));
    const handler = find(loaded, id("local", "handler"));
    assert.ok(handler && "action" in handler);
    assert.deepEqual(handler.action, action);
    assert.equal(handler.shell, "true");
    assert.notStrictEqual(handler.action, action);
    assert.equal(handler.default, true);
    assert.equal("path" in handler, false);
  });

  it("keeps global repository sections visible without project declaration", () => {
    const paths = locations("global-repo");
    writeJson(paths.global, {
      "owner/repo": { guard: remoteShell },
    });
    writeJson(paths.project!, {
      local: { localOnly: localShell() },
    });

    const loaded = catalog(HookCatalog.open(paths));
    assert.deepEqual(
      loaded.entries.map((entry) => `${entry.source}/${entry.name}`),
      ["owner/repo/guard", "local/localOnly"],
    );
  });

  it("keeps project local implicit when repos is absent", () => {
    const paths = locations("local-only");
    writeJson(paths.project!, {
      local: { guard: localShell() },
    });

    const loaded = catalog(HookCatalog.open(paths));
    assert.deepEqual(loaded.entries.map((entry) => `${entry.source}/${entry.name}`),
      ["local/guard"]);
    assert.deepEqual(loaded.repositories, []);
  });

  it("loads declared project repository sections", () => {
    const paths = locations("declared");
    writeJson(paths.project!, {
      repos: ["owner/repo"],
      "owner/repo": { guard: remoteShell },
    });

    const loaded = catalog(HookCatalog.open(paths));
    assert.deepEqual(loaded.entries.map((entry) => `${entry.source}/${entry.name}`),
      ["owner/repo/guard"]);
    assert.deepEqual(loaded.repositories, ["owner/repo"]);
  });

  it("diagnoses an undeclared project repository section", () => {
    const paths = locations("undeclared");
    writeJson(paths.project!, {
      local: { visible: localShell() },
      "owner/repo": { guard: remoteShell },
    });

    const result = HookCatalog.open(paths);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.diagnostics.map((item) => item.storage), ["project"]);
      assert.match(result.diagnostics[0]!.reason, /owner\/repo/);
      assert.match(result.diagnostics[0]!.reason, /repos/);
    }
  });

  it("allows a declared repository that has no section yet", () => {
    const paths = locations("repo-without-section");
    writeJson(paths.project!, {
      repos: ["owner/repo"],
      local: { guard: localShell() },
    });

    const loaded = catalog(HookCatalog.open(paths));
    assert.deepEqual(loaded.repositories, ["owner/repo"]);
    assert.deepEqual(loaded.entries.map((entry) => entry.name), ["guard"]);
  });

  it("rejects arbitrary non-canonical section sources", () => {
    const paths = locations("non-canonical");
    writeJson(paths.global, { one: { entry: localShell() } });
    const result = HookCatalog.open(paths);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]!.storage, "global");
      assert.match(result.diagnostics[0]!.reason, /expected local or owner\/repo/);
    }
  });

  it("lets one project eligibility error prevent a partial catalog", () => {
    const paths = locations("partial");
    writeJson(paths.global, {
      local: { globalOk: localShell() },
    });
    writeJson(paths.project!, {
      repos: ["other/repo"],
      local: { projectOk: localShell() },
      "owner/repo": { undeclared: remoteShell },
      "other/repo": { other: remoteShell },
    });

    const result = HookCatalog.open(paths);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0]!.storage, "project");
      assert.match(result.diagnostics[0]!.reason, /owner\/repo/);
    }
  });

  it("reports the first failure for every invalid authorized storage", () => {
    const paths = locations("diagnostics");
    mkdirSync(dirname(paths.global), { recursive: true });
    writeFileSync(paths.global, "not json");
    writeJson(paths.project!, {
      local: {
        bad: { description: "missing shell", event: "tool_call" },
        alsoBad: 42,
      },
    });

    const result = HookCatalog.open(paths);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.diagnostics.map((item) => item.storage), ["global", "project"]);
    assert.match(result.diagnostics[0]!.reason, /Unexpected token|JSON/);
    assert.match(result.diagnostics[1]!.reason, /local\/bad/);
    assert.equal(result.diagnostics.length, 2);
    assert.equal("path" in result.diagnostics[0]!, false);
  });

  it("rejects a non-object storage root", () => {
    const paths = locations("invalid-root");
    mkdirSync(dirname(paths.global), { recursive: true });
    writeFileSync(paths.global, "[]");

    const result = HookCatalog.open(paths);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]!.storage, "global");
      assert.match(result.diagnostics[0]!.reason, /JSON object/);
    }
  });

  it("rejects invalid file metadata without a partial catalog", () => {
    const paths = locations("invalid-shape");
    writeJson(paths.global, { local: { valid: localShell() } });
    writeJson(paths.project!, {
      repos: ["not-qualified"],
      local: {
        invalid: { description: "x", event: "made_up", shell: "true" },
      },
    });

    const result = HookCatalog.open(paths);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0]!.storage, "project");
      assert.match(result.diagnostics[0]!.reason, /repos/);
    }
  });

  it("deep-freezes catalog entries once, including nested owned data", () => {
    const paths = locations("frozen");
    const action = {
      type: "message" as const,
      outcome: ["pass", "block"] as unknown as "pass",
      message: "Review",
      delivery: "followUp" as const,
      code: [0, 1],
    };
    writeJson(paths.project!, {
      local: {
        guard: {
          description: "Frozen guard",
          event: "tool_call",
          filter: { toolName: ["bash", "read"] },
          when: "true",
          shell: "git status",
          action,
        },
        preset: { description: "P", preset: ["local/guard"] },
      },
    });

    const loaded = catalog(HookCatalog.open(paths));
    assert.ok(Object.isFrozen(loaded.entries));
    assert.ok(Object.isFrozen(loaded.repositories));
    const guard = loaded.entries.find((e) => e.name === "guard")!;
    assert.ok(Object.isFrozen(guard));
    assert.ok(Object.isFrozen(guard.filter));
    if ("action" in guard) {
      assert.ok(Object.isFrozen(guard.action));
      assert.ok(Object.isFrozen(guard.action.outcome));
      assert.ok(Object.isFrozen(guard.action.code));
    }
    const preset = loaded.entries.find((e) => e.name === "preset")!;
    if ("preset" in preset) assert.ok(Object.isFrozen(preset.preset));
    // The frozen entry is not caller-owned storage data.
    assert.notStrictEqual("action" in guard && guard.action, action);
  });

  it("returns source-qualified diagnostics for invalid filter regexes", () => {
    const paths = locations("invalid-regex");
    writeJson(paths.project!, {
      local: {
        bad: {
          description: "x",
          event: "tool_call",
          shell: "true",
          filter: { toolName: "[" },
        },
      },
    });
    const result = HookCatalog.open(paths);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]!.storage, "project");
      assert.match(result.diagnostics[0]!.reason, /local\/bad/);
      assert.match(result.diagnostics[0]!.reason, /invalid regex/);
    }
  });

  it("returns source-qualified diagnostics for invalid entries", () => {
    const paths = locations("invalid-entry");
    writeJson(paths.project!, {
      local: {
        bad: { description: "x", event: "made_up", shell: "true" },
      },
    });
    const result = HookCatalog.open(paths);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]!.storage, "project");
      assert.match(result.diagnostics[0]!.reason, /local\/bad/);
      assert.match(result.diagnostics[0]!.reason, /unknown event/);
    }
  });

  for (const [label, name] of [
    ["empty", ""],
    ["slash", "nested/name"],
    ["NUL", "nul\x00name"],
  ] as const) {
    it(`rejects a Catalog Entry with an ${label} name`, () => {
      const paths = locations(`invalid-${label}-name`);
      writeJson(paths.project!, { local: { [name]: localShell() } });

      const result = HookCatalog.open(paths);

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.diagnostics[0]!.storage, "project");
        assert.match(result.diagnostics[0]!.reason, /entry name/);
      }
    });
  }

  it("rejects duplicate Hook References within one Preset", () => {
    const paths = locations("duplicate-preset-refs");
    writeJson(paths.project!, {
      local: {
        guard: localShell(),
        bundle: {
          description: "Repeated member",
          preset: ["local/guard", "local/guard"],
        },
      },
    });

    const result = HookCatalog.open(paths);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]!.storage, "project");
      assert.match(result.diagnostics[0]!.reason, /local\/bundle/);
      assert.match(result.diagnostics[0]!.reason, /Hook or Preset schema/);
    }
  });

  it("accepts Preset references that resolve to Hooks or remain dangling", () => {
    const paths = locations("valid-preset-relations");
    writeJson(paths.global, {
      "owner/hooks": { remote: remoteShell },
    });
    writeJson(paths.project!, {
      local: {
        "local guard": localShell(),
        bundle: {
          description: "Available and missing members",
          preset: [
            "local/local guard",
            "owner/hooks/remote",
            "owner/hooks/missing guard",
          ],
        },
      },
    });

    const loaded = catalog(HookCatalog.open(paths));

    const bundle = find(loaded, id("local", "bundle"));
    assert.ok(bundle && "preset" in bundle);
    assert.deepEqual(bundle.preset, [
      "local/local guard",
      "owner/hooks/remote",
      "owner/hooks/missing guard",
    ]);
  });

  it("rejects a cross-Source Preset reference resolved to a Preset after storage merge", () => {
    const paths = locations("nested-after-merge");
    writeJson(paths.global, {
      local: {
        bundle: { description: "Bundle", preset: ["owner/hooks/member"] },
      },
      "owner/hooks": {
        member: localShell("global-hook"),
      },
    });
    writeJson(paths.project!, {
      repos: ["owner/hooks"],
      "owner/hooks": {
        member: { description: "Project Preset", preset: [] },
      },
    });

    const result = HookCatalog.open(paths);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]!.storage, "global");
      assert.match(result.diagnostics[0]!.reason, /local\/bundle/);
      assert.match(result.diagnostics[0]!.reason, /owner\/hooks\/member/);
      assert.match(result.diagnostics[0]!.reason, /Preset/);
    }
  });

  it("rejects Preset nesting introduced before refresh without changing the snapshot", () => {
    const paths = locations("nested-refresh");
    writeJson(paths.project!, {
      local: {
        member: localShell(),
        bundle: { description: "Bundle", preset: ["local/member"] },
      },
    });
    const initial = catalog(HookCatalog.open(paths));
    writeJson(paths.project!, {
      local: {
        member: { description: "Nested", preset: [] },
        bundle: { description: "Bundle", preset: ["local/member"] },
      },
    });

    const result = initial.refresh();

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.diagnostics[0]!.reason, /nested Presets/);
    const member = find(initial, id("local", "member"));
    assert.ok(member && "shell" in member);
  });
});

describe("Hook Catalog mutations", () => {
  it("installs a validated batch with repository allowlist updates in one replacement", () => {
    const paths = locations("batch-install");
    writeJson(paths.project!, {
      $schema: "https://example.test/schema.json",
      local: { existing: localShell("keep") },
    });
    const initial = catalog(HookCatalog.open(paths));

    const result = initial.mutate({
      type: "install",
      entries: [
        {
          identity: id("owner/hooks", "guard"),
          entry: { ...remoteShell, filter: { toolName: "^bash$" } },
        },
        {
          identity: id("owner/hooks", "bundle"),
          entry: {
            description: "Bundle",
            preset: ["owner/hooks/guard", "owner/hooks/unavailable"],
          },
        },
      ],
    });
    const fresh = catalog(result);

    assert.notStrictEqual(fresh, initial);
    assert.deepEqual(initial.entries.map((entry) => entry.name), ["existing"]);
    assert.deepEqual(fresh.repositories, ["owner/hooks"]);
    assert.ok(find(fresh, id("owner/hooks", "guard")));
    assert.ok(find(fresh, id("owner/hooks", "bundle")));
    const persisted = readJson(paths.project!);
    assert.equal(persisted.$schema, "https://example.test/schema.json");
    assert.deepEqual(persisted.repos, ["owner/hooks"]);
    assert.ok((persisted.local as Record<string, unknown>).existing);
    assert.deepEqual(
      (persisted["owner/hooks"] as Record<string, unknown>).guard,
      {
        description: "Remote guard",
        event: "tool_call",
        shell: "false",
        filter: { toolName: "^bash$" },
      },
    );
    assert.deepEqual(
      readdirSync(dirname(paths.project!)).filter((name) => name.includes(".tmp")),
      [],
    );
  });

  it("canonicalizes an omitted shell to true in snapshots and persistence", () => {
    const paths = locations("canonical-action-shell");
    writeJson(paths.project!, {});
    const initial = catalog(HookCatalog.open(paths));
    const actionOnly = localAction({ type: "interrupt" });

    const fresh = catalog(initial.mutate({
      type: "install",
      entries: [{ identity: id("local", "notify"), entry: actionOnly }],
    }));
    const installed = find(fresh, id("local", "notify"));
    assert.ok(installed && "shell" in installed && "action" in installed);
    assert.equal(installed.shell, "true");
    assert.deepEqual(
      (readJson(paths.project!).local as Record<string, unknown>).notify,
      {
        description: "Local action",
        event: "tool_call",
        shell: "true",
        action: { type: "interrupt", outcome: "pass" },
      },
    );
  });

  it("independently validates mutation inputs and leaves disk unchanged on failure", () => {
    const paths = locations("input-validation");
    writeJson(paths.project!, { local: { keep: localShell() } });
    const before = readFileSync(paths.project!, "utf8");
    const initial = catalog(HookCatalog.open(paths));

    const result = initial.mutate({
      type: "install",
      entries: [{
        identity: id("owner/hooks", "bad"),
        entry: { description: "bad", event: "unknown", shell: "true" } as never,
      }],
    });

    assert.equal(result.ok, false);
    assert.equal(readFileSync(paths.project!, "utf8"), before);
    assert.equal(find(initial, id("owner/hooks", "bad")), undefined);
  });

  it("rejects invalid installation names without writing", () => {
    const paths = locations("invalid-install-name");
    writeJson(paths.project!, { local: { keep: localShell() } });
    const before = readFileSync(paths.project!, "utf8");
    const initial = catalog(HookCatalog.open(paths));

    const result = initial.mutate({
      type: "install",
      entries: [{ identity: id("local", "nested/name"), entry: remoteShell }],
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.diagnostics[0]!.reason, /entry name/);
    assert.equal(readFileSync(paths.project!, "utf8"), before);
    assert.equal(find(initial, id("local", "nested/name")), undefined);
  });

  it("rejects duplicate batch identities without writing", () => {
    const paths = locations("duplicate-batch");
    const initial = catalog(HookCatalog.open(paths));
    const result = initial.mutate({
      type: "install",
      entries: [
        { identity: id("owner/hooks", "same"), entry: remoteShell },
        { identity: id("owner/hooks", "same"), entry: remoteShell },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(existsSync(paths.project!), false);
  });

  it("atomically rejects a batch that resolves a Preset member to a Preset", () => {
    const paths = locations("nested-batch");
    writeJson(paths.project!, { local: { keep: localShell() } });
    const before = readFileSync(paths.project!, "utf8");
    const initial = catalog(HookCatalog.open(paths));

    const result = initial.mutate({
      type: "install",
      entries: [
        {
          identity: id("owner/hooks", "bundle"),
          entry: { description: "Bundle", preset: ["owner/hooks/member"] },
        },
        {
          identity: id("owner/hooks", "member"),
          entry: { description: "Nested", preset: [] },
        },
      ],
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.diagnostics[0]!.reason, /nested Presets/);
    assert.equal(readFileSync(paths.project!, "utf8"), before);
    assert.equal(find(initial, id("owner/hooks", "bundle")), undefined);
  });

  it("rejects installing a Preset at a dangling Hook Reference", () => {
    const paths = locations("nested-at-dangling-ref");
    writeJson(paths.project!, {
      local: {
        bundle: { description: "Bundle", preset: ["local/member"] },
      },
    });
    const before = readFileSync(paths.project!, "utf8");
    const initial = catalog(HookCatalog.open(paths));

    const result = initial.mutate({
      type: "install",
      entries: [{
        identity: id("local", "member"),
        entry: { description: "Nested", preset: [] },
      }],
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.diagnostics[0]!.reason, /nested Presets/);
    assert.equal(readFileSync(paths.project!, "utf8"), before);
    assert.ok(find(initial, id("local", "bundle")));
  });

  it("re-reads before install so unrelated external edits survive", () => {
    const paths = locations("reread");
    writeJson(paths.project!, { local: { original: localShell("one") } });
    const initial = catalog(HookCatalog.open(paths));
    writeJson(paths.project!, {
      local: {
        original: localShell("externally-changed"),
        external: localShell("added-outside"),
      },
    });

    const fresh = catalog(initial.mutate({
      type: "install",
      entries: [{ identity: id("owner/hooks", "new"), entry: remoteShell }],
    }));

    const original = find(fresh, id("local", "original"));
    assert.ok(original && "shell" in original);
    assert.equal(original.shell, "externally-changed");
    assert.ok(find(fresh, id("local", "external")));
  });

  it("preserves malformed external bytes and the previous snapshot on mutation failure", () => {
    const paths = locations("malformed-reread");
    writeJson(paths.project!, { local: { keep: localShell() } });
    const initial = catalog(HookCatalog.open(paths));
    const malformed = "{ definitely malformed";
    writeFileSync(paths.project!, malformed);

    const result = initial.mutate({
      type: "set-default",
      identity: id("local", "keep"),
      value: true,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]!.storage, "project");
    assert.equal(readFileSync(paths.project!, "utf8"), malformed);
    assert.ok(find(initial, id("local", "keep")));
  });

  it("validates every authorized storage before mutating the target storage", () => {
    const paths = locations("validate-all-before-write");
    writeJson(paths.global, { local: { global: localShell() } });
    writeJson(paths.project!, { local: { project: localShell() } });
    const initial = catalog(HookCatalog.open(paths));
    const projectBefore = readFileSync(paths.project!, "utf8");
    writeFileSync(paths.global, "{ malformed unrelated global storage");

    const result = initial.mutate({
      type: "install",
      entries: [{ identity: id("owner/hooks", "new"), entry: remoteShell }],
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]!.storage, "global");
    assert.equal(readFileSync(paths.project!, "utf8"), projectBefore);
  });

  it("updates whichever storage supplies the visible entry and preserves local default", () => {
    const paths = locations("update-provenance");
    writeJson(paths.global, {
      local: {
        globalEntry: localShell("old", { default: true }),
        shadowed: localShell("global-shadow"),
      },
    });
    writeJson(paths.project!, {
      local: {
        shadowed: localShell("project-shadow", { default: true }),
        handler: localAction({ type: "interrupt" }, { default: true }),
      },
    });
    let current = catalog(HookCatalog.open(paths));

    current = catalog(current.mutate({
      type: "update",
      identity: id("local", "globalEntry"),
      entry: localShell("new-global", { default: false }),
    }));
    current = catalog(current.mutate({
      type: "update",
      identity: id("local", "shadowed"),
      entry: localShell("new-project"),
    }));
    current = catalog(current.mutate({
      type: "update",
      identity: id("local", "handler"),
      entry: localAction({ type: "shutdown", interrupt: true }),
    }));

    const global = readJson(paths.global);
    const project = readJson(paths.project!);
    assert.deepEqual((global.local as Record<string, unknown>).globalEntry, {
      description: "Local guard",
      event: "tool_call",
      shell: "new-global",
      default: true,
    });
    assert.equal(
      ((global.local as Record<string, unknown>).shadowed as Record<string, unknown>).shell,
      "global-shadow",
    );
    assert.deepEqual((project.local as Record<string, unknown>).shadowed, {
      description: "Local guard",
      event: "tool_call",
      shell: "new-project",
      default: true,
    });
    assert.equal(find(current, id("local", "shadowed"))?.default, true);
    assert.deepEqual((project.local as Record<string, unknown>).handler, {
      description: "Local action",
      event: "tool_call",
      shell: "true",
      action: { type: "shutdown", outcome: "pass", interrupt: true },
      default: true,
    });
    const handler = find(current, id("local", "handler"));
    assert.ok(handler && "action" in handler);
    assert.deepEqual(handler.action, {
      type: "shutdown",
      outcome: "pass",
      interrupt: true,
    });
    assert.equal(handler.default, true);
  });

  it("atomically rejects an update that turns a referenced Hook into a Preset", () => {
    const paths = locations("nested-update");
    writeJson(paths.project!, {
      local: {
        member: localShell("keep-hook"),
        bundle: { description: "Bundle", preset: ["local/member"] },
      },
    });
    const before = readFileSync(paths.project!, "utf8");
    const initial = catalog(HookCatalog.open(paths));

    const result = initial.mutate({
      type: "update",
      identity: id("local", "member"),
      entry: { description: "Nested", preset: [] },
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.diagnostics[0]!.reason, /nested Presets/);
    assert.equal(readFileSync(paths.project!, "utf8"), before);
    const member = find(initial, id("local", "member"));
    assert.ok(member && "shell" in member);
    assert.equal(member.shell, "keep-hook");
  });

  it("uses provenance from the mandatory re-read rather than the old snapshot", () => {
    const paths = locations("fresh-provenance");
    writeJson(paths.global, { local: { moving: localShell("global-old") } });
    writeJson(paths.project!, { local: { moving: localShell("project-old") } });
    const initial = catalog(HookCatalog.open(paths));
    writeJson(paths.project!, { local: { unrelated: localShell("keep") } });

    const fresh = catalog(initial.mutate({
      type: "update",
      identity: id("local", "moving"),
      entry: localShell("global-new"),
    }));

    assert.deepEqual((readJson(paths.global).local as Record<string, unknown>).moving, {
      description: "Local guard",
      event: "tool_call",
      shell: "global-new",
    });
    assert.ok((readJson(paths.project!).local as Record<string, unknown>).unrelated);
    const moving = find(fresh, id("local", "moving"));
    assert.ok(moving && "shell" in moving);
    assert.equal(moving.shell, "global-new");
  });

  it("removes only the owning source and reveals a matching global entry", () => {
    const paths = locations("remove");
    writeJson(paths.global, {
      local: { same: localShell("global") },
      "owner/other": { same: remoteShell },
    });
    writeJson(paths.project!, {
      repos: ["owner/other"],
      local: {
        same: localShell("project"),
        sibling: localShell("keep"),
      },
      "owner/other": { same: { ...remoteShell, shell: "other-project" } },
    });
    const initial = catalog(HookCatalog.open(paths));

    const fresh = catalog(initial.mutate({
      type: "remove",
      identity: id("local", "same"),
    }));

    const revealed = find(fresh, id("local", "same"));
    assert.ok(revealed && "shell" in revealed);
    assert.equal(revealed.shell, "global");
    assert.ok(find(fresh, id("local", "sibling")));
    assert.ok(find(fresh, id("owner/other", "same")));
  });

  it("atomically rejects removal when an override would reveal Preset nesting", () => {
    const paths = locations("remove-reveals-nesting");
    writeJson(paths.global, {
      local: {
        member: { description: "Hidden Preset", preset: [] },
        bundle: { description: "Bundle", preset: ["local/member"] },
      },
    });
    writeJson(paths.project!, {
      local: { member: localShell("visible-hook") },
    });
    const before = readFileSync(paths.project!, "utf8");
    const initial = catalog(HookCatalog.open(paths));

    const result = initial.mutate({
      type: "remove",
      identity: id("local", "member"),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.diagnostics[0]!.reason, /nested Presets/);
    assert.equal(readFileSync(paths.project!, "utf8"), before);
    const member = find(initial, id("local", "member"));
    assert.ok(member && "shell" in member);
    assert.equal(member.shell, "visible-hook");
  });

  it("allows Hook removal to leave a dangling Preset member and later resolve it", () => {
    const paths = locations("remove-to-dangling");
    writeJson(paths.project!, {
      local: {
        member: localShell("original"),
        bundle: { description: "Bundle", preset: ["local/member"] },
      },
    });
    const initial = catalog(HookCatalog.open(paths));

    const dangling = catalog(initial.mutate({
      type: "remove",
      identity: id("local", "member"),
    }));
    assert.equal(find(dangling, id("local", "member")), undefined);
    const bundle = find(dangling, id("local", "bundle"));
    assert.ok(bundle && "preset" in bundle);
    assert.deepEqual(bundle.preset, ["local/member"]);

    const resolved = catalog(dangling.mutate({
      type: "install",
      entries: [{ identity: id("local", "member"), entry: localShell("restored") }],
    }));
    const restored = find(resolved, id("local", "member"));
    assert.ok(restored && "shell" in restored);
    assert.equal(restored.shell, "restored");
  });

  it("fails a stale mutation when the identity disappeared after re-read", () => {
    const paths = locations("stale-missing");
    writeJson(paths.project!, { local: { stale: localShell() } });
    const initial = catalog(HookCatalog.open(paths));
    writeJson(paths.project!, { local: { other: localShell() } });

    const result = initial.mutate({
      type: "remove",
      identity: id("local", "stale"),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.diagnostics[0]!.reason, /was not found/);
    assert.ok((readJson(paths.project!).local as Record<string, unknown>).other);
  });

  it("edits only local presets and preserves the effective default preference", () => {
    const paths = locations("edit-preset");
    writeJson(paths.global, {
      local: {
        editable: { description: "Old", preset: [], default: true },
      },
      "owner/hooks": {
        locked: { description: "Locked", preset: [] },
      },
    });
    const initial = catalog(HookCatalog.open(paths));

    const fresh = catalog(initial.mutate({
      type: "edit-local-preset",
      identity: id("local", "editable"),
      description: "New",
      preset: ["local/missing"],
    }));
    assert.deepEqual((readJson(paths.global).local as Record<string, unknown>).editable, {
      description: "New",
      preset: ["local/missing"],
      default: true,
    });
    assert.equal(find(fresh, id("local", "editable"))?.description, "New");

    const locked = fresh.mutate({
      type: "edit-local-preset",
      identity: id("owner/hooks", "locked"),
      description: "No",
      preset: [],
    });
    assert.equal(locked.ok, false);
    if (!locked.ok) assert.match(locked.diagnostics[0]!.reason, /only local/);
  });

  it("atomically rejects editing a local Preset to reference a Preset", () => {
    const paths = locations("nested-edit");
    writeJson(paths.project!, {
      local: {
        editable: { description: "Original", preset: [] },
        nested: { description: "Nested", preset: [] },
      },
    });
    const before = readFileSync(paths.project!, "utf8");
    const initial = catalog(HookCatalog.open(paths));

    const result = initial.mutate({
      type: "edit-local-preset",
      identity: id("local", "editable"),
      description: "Invalid edit",
      preset: ["local/nested"],
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.diagnostics[0]!.reason, /nested Presets/);
    assert.equal(readFileSync(paths.project!, "utf8"), before);
    assert.equal(find(initial, id("local", "editable"))?.description, "Original");
  });

  it("toggles default on the current owner without changing entry content", () => {
    const paths = locations("default");
    writeJson(paths.project!, {
      local: {
        guard: localShell("check", { filter: { toolName: "^bash$" } }),
      },
    });
    let current = catalog(HookCatalog.open(paths));
    current = catalog(current.mutate({
      type: "set-default",
      identity: id("local", "guard"),
      value: true,
    }));
    assert.equal(find(current, id("local", "guard"))?.default, true);
    current = catalog(current.mutate({
      type: "set-default",
      identity: id("local", "guard"),
      value: false,
    }));

    assert.equal(find(current, id("local", "guard"))?.default, false);
    assert.deepEqual((readJson(paths.project!).local as Record<string, unknown>).guard, {
      description: "Local guard",
      event: "tool_call",
      shell: "check",
      filter: { toolName: "^bash$" },
    });
  });

  it("adds a repository through project storage and returns the fresh allowlist", () => {
    const paths = locations("add-repo");
    const initial = catalog(HookCatalog.open(paths));
    const fresh = catalog(initial.mutate({
      type: "add-repository",
      source: "owner/hooks",
    }));

    assert.deepEqual(initial.repositories, []);
    assert.deepEqual(fresh.repositories, ["owner/hooks"]);
    assert.deepEqual(readJson(paths.project!).repos, ["owner/hooks"]);

    const invalid = fresh.mutate({ type: "add-repository", source: "invalid" });
    assert.equal(invalid.ok, false);
  });
});
