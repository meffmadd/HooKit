import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { clearRepoEntriesCache } from "../hookit/installer.js";
import { installRepositoryEntry } from "../hookit/ui/install.js";
import { HooksState } from "../hookit/ui/state.js";
import { CORE_SOURCE, coreEntry } from "./core-hooks/index.js";

const roots: string[] = [];

afterEach(() => {
  mock.restoreAll();
  clearRepoEntriesCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("preset installation workflow", () => {
  it("installs read-only and its three Core members from the first-party Source", async () => {
    const root = mkdtempSync(join(tmpdir(), "HooKit-core-install-workflow-"));
    roots.push(root);
    const global = join(root, "global.json");
    const project = join(root, "project", ".pi", "hookit.json");
    const state = new HooksState({ appendEntry() {} } as unknown as ExtensionAPI);
    state.load({ global, project });

    const piTools = {
      "block-bash": coreEntry("block-bash"),
      "block-write": coreEntry("block-write"),
      "block-edit": coreEntry("block-edit"),
      "read-only": coreEntry("read-only"),
    };
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(`/repos/${CORE_SOURCE}/git/trees/`)) {
        return response({
          tree: [{ path: "hooks/pi-tools.json", type: "blob", sha: "core" }],
        });
      }
      if (url.includes(`/repos/${CORE_SOURCE}/contents/hooks/pi-tools.json`)) {
        return response({
          type: "file",
          content: Buffer.from(JSON.stringify(piTools)).toString("base64"),
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const ctx = {
      ui: {
        notify() {},
        setStatus() {},
        theme: { fg: (_role: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await installRepositoryEntry(
      ctx,
      state,
      CORE_SOURCE,
      "read-only",
      coreEntry("read-only"),
    );

    const persisted = JSON.parse(readFileSync(project, "utf8")) as Record<string, unknown>;
    assert.deepEqual(persisted.repos, [CORE_SOURCE]);
    assert.deepEqual(
      Object.keys(persisted[CORE_SOURCE] as Record<string, unknown>).sort(),
      ["block-bash", "block-edit", "block-write", "read-only"],
    );
  });

  it("persists the preset and every fetched member as one batch while unavailable members remain dangling", async () => {
    const root = mkdtempSync(join(tmpdir(), "HooKit-install-workflow-"));
    roots.push(root);
    const global = join(root, "global.json");
    const project = join(root, "project", ".pi", "hookit.json");
    const state = new HooksState({ appendEntry() {} } as unknown as ExtensionAPI);
    state.load({ global, project });

    const goodEntry = {
      guard: {
        description: "Fetched member",
        event: "tool_call",
        shell: "false",
      },
    };
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/repos/bad/repo/")) {
        throw new Error("member repository unavailable");
      }
      if (url.includes("/repos/good/repo/git/trees/")) {
        return response({
          tree: [{ path: "hooks/defaults.json", type: "blob", sha: "member" }],
        });
      }
      if (url.includes("/repos/good/repo/contents/hooks/defaults.json")) {
        return response({
          type: "file",
          content: Buffer.from(JSON.stringify(goodEntry)).toString("base64"),
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const notifications: string[] = [];
    const ctx = {
      ui: {
        notify(message: string) { notifications.push(message); },
        setStatus() {},
        theme: { fg: (_role: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    await installRepositoryEntry(
      ctx,
      state,
      "owner/presets",
      "bundle",
      {
        description: "Bundle",
        preset: ["good/repo/guard", "bad/repo/gone"],
      },
    );

    const persisted = JSON.parse(readFileSync(project, "utf8")) as Record<string, unknown>;
    assert.deepEqual(persisted.repos, ["owner/presets", "good/repo"]);
    assert.deepEqual(
      (persisted["owner/presets"] as Record<string, unknown>).bundle,
      {
        description: "Bundle",
        preset: ["good/repo/guard", "bad/repo/gone"],
      },
    );
    assert.deepEqual(
      (persisted["good/repo"] as Record<string, unknown>).guard,
      goodEntry.guard,
    );
    assert.ok(state.entries.some((entry) => entry.source === "owner/presets" && entry.name === "bundle"));
    assert.ok(state.entries.some((entry) => entry.source === "good/repo" && entry.name === "guard"));
    assert.ok(notifications.some((message) => message.includes("member repository unavailable")));
    assert.ok(notifications.some((message) => message.includes('installed "bundle"')));
  });
});
