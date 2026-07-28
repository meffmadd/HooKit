import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import registerExtension from "../pi-assert/index.js";
import {
  globalFilePath,
  projectFilePath,
} from "../pi-assert/config.js";

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
    sendMessage() {},
    getThinkingLevel: () => "high",
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

describe("index catalog authorization", () => {
  it("omits untrusted project storage before catalog creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-assert-index-untrusted-"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const cwd = join(root, "workspace");
      const globalPath = globalFilePath();
      mkdirSync(dirname(globalPath), { recursive: true });
      writeFileSync(globalPath, JSON.stringify({
        local: {
          global: {
            description: "trusted global guard",
            hook: "tool_call",
            shell: "false",
            default: true,
          },
        },
      }));
      const projectPath = projectFilePath(cwd);
      mkdirSync(dirname(projectPath), { recursive: true });
      writeFileSync(projectPath, "{ malformed and untrusted");

      const notifications: string[] = [];
      const ctx = {
        cwd,
        hasUI: true,
        isProjectTrusted: () => false,
        sessionManager: { getBranch: () => [] },
        ui: {
          theme: { fg: (_color: string, text: string) => text },
          setStatus: () => {},
          notify: (message: string) => notifications.push(message),
        },
      } as unknown as ExtensionContext;

      const harness = extensionHarness();
      registerExtension(harness.pi);
      await harness.handler("session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );
      const result = await harness.handler("tool_call")(
        { toolName: "bash", toolCallId: "global", input: {} },
        ctx,
      );

      assert.deepStrictEqual(result, {
        block: true,
        reason: 'pi-assert: assertion "global" rejected bash — `false`',
      });
      assert.ok(!notifications.some((message) => message.includes("failed to parse")));
      assert.equal(readFileSync(projectPath, "utf8"), "{ malformed and untrusted");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("index synthetic result dispatch", () => {
  it("awaits detached handlers without changing the originating block", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-assert-index-results-"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          passes: {
            description: "pass first",
            hook: "tool_call",
            shell: "printf '%s' \"$PI_REASONING_LEVEL\" > reasoning.log",
            default: true,
          },
          blocks: {
            description: "then block",
            hook: "tool_call",
            shell: "exit 6",
            default: true,
          },
          "failing-handler": {
            description: "handler reporting must be isolated",
            hook: "assert_result",
            shell: "false",
            default: true,
          },
          logger: {
            description: "record every result",
            hook: "assert_result",
            filter: {
              assertionRef: "^local/",
              outcome: ["pass", "block"],
            },
            shell: "printf '%s\\n' \"$PI_EVENT_PAYLOAD\" >> handled.log",
            default: true,
          },
        },
      }));

      const ctx = {
        cwd: root,
        hasUI: true,
        isProjectTrusted: () => true,
        sessionManager: { getBranch: () => [] },
        ui: {
          theme: { fg: (_color: string, text: string) => text },
          setStatus: () => {},
          notify: (message: string) => {
            if (message.includes("assert_result")) {
              throw new Error("synthetic reporting failed");
            }
          },
        },
      } as unknown as ExtensionContext;

      const harness = extensionHarness();
      registerExtension(harness.pi);
      await harness.handler("session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );

      const result = await harness.handler("tool_call")(
        { toolName: "bash", toolCallId: "call-1", input: { command: "echo hi" } },
        ctx,
      );
      assert.deepStrictEqual(result, {
        block: true,
        reason: 'pi-assert: assertion "blocks" rejected bash — `exit 6`',
      });
      assert.equal(readFileSync(join(root, "reasoning.log"), "utf8"), "high");

      const payloads = readFileSync(join(root, "handled.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { assertionRef: string; outcome: string });
      assert.deepStrictEqual(payloads.map(({ assertionRef, outcome }) => ({
        assertionRef,
        outcome,
      })), [
        { assertionRef: "local/passes", outcome: "pass" },
        { assertionRef: "local/blocks", outcome: "block" },
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("index effect and outcome translation", () => {
  it("delivers ordered effects best-effort before corrective feedback", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-assert-index-effects-"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          "end-check": {
            description: "request a correction",
            hook: "agent_end",
            shell: "false",
            default: true,
          },
          "failing-handler": {
            description: "present before the summary",
            hook: "assert_result",
            shell: "false",
            default: true,
          },
        },
      }));

      const deliveries: string[] = [];
      let notificationCount = 0;
      let checkingEffects = false;
      const ctx = {
        cwd: root,
        hasUI: true,
        isProjectTrusted: () => true,
        sessionManager: { getBranch: () => [] },
        ui: {
          theme: { fg: (_color: string, text: string) => text },
          setStatus: () => {},
          notify: (message: string) => {
            deliveries.push(`present:${message}`);
            notificationCount++;
            if (checkingEffects && notificationCount === 1) {
              throw new Error("first delivery failed");
            }
          },
        },
      } as unknown as ExtensionContext;

      const harness = extensionHarness();
      (harness.pi as unknown as {
        sendMessage: (message: { content: string }) => void;
      }).sendMessage = (message) => {
        deliveries.push(`corrective:${message.content}`);
      };
      registerExtension(harness.pi);
      await harness.handler("session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );
      deliveries.length = 0;
      notificationCount = 0;
      checkingEffects = true;

      await harness.handler("agent_start")({}, ctx);
      await harness.handler("agent_end")({ messages: [] }, ctx);

      assert.equal(deliveries.length, 3);
      assert.match(deliveries[0]!, /assert_result assertion failed/);
      assert.match(deliveries[1]!, /pi-assert ran 1 command/);
      assert.match(deliveries[2]!, /^corrective:1 assertion failed/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("translates a patch in headless mode without relying on UI delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-assert-index-patch-"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          redact: {
            description: "suppress results",
            hook: "tool_result",
            shell: "false",
            default: true,
          },
        },
      }));

      const ctx = {
        cwd: root,
        hasUI: false,
        isProjectTrusted: () => true,
        sessionManager: { getBranch: () => [] },
        ui: {
          theme: { fg: (_color: string, text: string) => text },
          setStatus: () => {},
          notify: () => {},
        },
      } as unknown as ExtensionContext;

      const harness = extensionHarness();
      registerExtension(harness.pi);
      await harness.handler("session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );
      ctx.ui.notify = () => {
        throw new Error("headless notification should not run");
      };

      const details = { duration: 4 };
      const patch = await harness.handler("tool_result")(
        {
          toolName: "read",
          toolCallId: "result-1",
          input: { path: "secret" },
          content: [{ type: "text", text: "secret" }],
          isError: false,
          details,
        },
        ctx,
      ) as { content: Array<{ type: string; text: string }>; details: unknown; isError: boolean };

      assert.equal(patch.isError, true);
      assert.strictEqual(patch.details, details);
      assert.match(patch.content[0]!.text, /original tool result was suppressed/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
