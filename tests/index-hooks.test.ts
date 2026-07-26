import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import registerExtension from "../pi-assert/index.js";
import { projectFilePath } from "../pi-assert/config.js";

type EventHandler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

function extensionHarness(): {
  pi: ExtensionAPI;
  handler: (event: string) => EventHandler;
} {
  const handlers = new Map<string, EventHandler[]>();
  const pi = {
    on(event: string, handler: EventHandler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;

  return {
    pi,
    handler(event: string): EventHandler {
      const registered = handlers.get(event);
      assert.ok(registered?.length, `missing ${event} handler`);
      return registered[0];
    },
  };
}

describe("index session guard dispatch", () => {
  it("returns cancellation even when failure feedback throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-assert-index-hooks-"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          switch: {
            description: "block switches",
            hook: "session_before_switch",
            shell: "false",
            default: true,
          },
          fork: {
            description: "block forks",
            hook: "session_before_fork",
            shell: "false",
            default: true,
          },
        },
      }));

      let throwNotifications = false;
      let throwHasUI = false;
      const ctx = {
        cwd: root,
        get hasUI() {
          if (throwHasUI) throw new Error("hasUI failed");
          return true;
        },
        isProjectTrusted: () => true,
        sessionManager: { getBranch: () => [] },
        ui: {
          theme: { fg: (_color: string, text: string) => text },
          setStatus: () => {},
          notify: () => {
            if (throwNotifications) throw new Error("notification failed");
          },
        },
      } as unknown as ExtensionContext;

      const harness = extensionHarness();
      registerExtension(harness.pi);
      await harness.handler("session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );

      throwNotifications = true;
      assert.deepStrictEqual(
        await harness.handler("session_before_switch")(
          { type: "session_before_switch", reason: "new" },
          ctx,
        ),
        { cancel: true },
      );
      throwNotifications = false;
      throwHasUI = true;
      assert.deepStrictEqual(
        await harness.handler("session_before_fork")(
          { type: "session_before_fork", entryId: "entry-1", position: "at" },
          ctx,
        ),
        { cancel: true },
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
