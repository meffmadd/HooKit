import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";

import registerExtension from "../pi-assert/index.js";
import {
  globalFilePath,
  projectFilePath,
} from "../pi-assert/config.js";

type EventHandler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

interface CapturedEntry {
  customType: string;
  data: unknown;
}

interface ExtensionHarness {
  pi: ExtensionAPI;
  entries: CapturedEntry[];
  messages: Array<{ content: string }>;
  handler: (event: string) => EventHandler;
  renderer: (customType: string) => EntryRenderer<unknown>;
}

function extensionHarness(): ExtensionHarness {
  const handlers = new Map<string, EventHandler[]>();
  const renderers = new Map<string, EntryRenderer<unknown>>();
  const entries: CapturedEntry[] = [];
  const messages: Array<{ content: string }> = [];
  const pi = {
    on(event: string, handler: EventHandler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand() {},
    registerEntryRenderer(
      customType: string,
      renderer: EntryRenderer<unknown>,
    ) {
      renderers.set(customType, renderer);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendMessage(message: { content: string }) {
      messages.push(message);
    },
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;

  return {
    pi,
    entries,
    messages,
    handler(event: string): EventHandler {
      const registered = handlers.get(event);
      assert.ok(registered?.length, `missing ${event} handler`);
      return registered[0];
    },
    renderer(customType: string): EntryRenderer<unknown> {
      const renderer = renderers.get(customType);
      assert.ok(renderer, `missing ${customType} renderer`);
      return renderer;
    },
  };
}

const renderTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
} as unknown as Theme;

function renderEntry(
  harness: ExtensionHarness,
  index: number,
  expanded: boolean,
  width = 120,
): string {
  const captured = harness.entries[index];
  assert.ok(captured, `missing captured entry ${index}`);
  const renderer = harness.renderer(captured.customType);
  const component = renderer(
    {
      type: "custom",
      id: `entry-${index}`,
      parentId: null,
      timestamp: new Date(0).toISOString(),
      customType: captured.customType,
      data: captured.data,
    },
    { expanded },
    renderTheme,
  );
  assert.ok(component, "entry renderer returned no component");
  return component.render(width).map((line) => line.trimEnd()).join("\n");
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
      (harness.pi as unknown as { appendEntry: () => void }).appendEntry = () => {
        throw new Error("execution entry unavailable");
      };
      const result = await harness.handler("tool_call")(
        { toolName: "bash", toolCallId: "global", input: {} },
        ctx,
      );

      assert.deepStrictEqual(result, {
        block: true,
        reason: 'pi-assert: assertion "global" rejected bash — `false`',
      });
      assert.ok(!notifications.some((message) => message.includes("failed to parse")));
      assert.ok(notifications.some((message) => message.includes("rejected bash")));
      assert.equal(readFileSync(projectPath, "utf8"), "{ malformed and untrusted");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("index execution entries", () => {
  it("appends one context-neutral, expandable entry per tool-call event", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-assert-index-executions-"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          passes: {
            description: "observe successful checks",
            hook: "tool_call",
            shell: "true",
            default: true,
          },
          "turn-pass": {
            description: "first aggregate check",
            hook: "turn_end",
            shell: "true",
            default: true,
          },
          "turn-fail": {
            description: "second aggregate check",
            hook: "turn_end",
            shell: "false",
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
          notify: () => {},
        },
      } as unknown as ExtensionContext;

      const harness = extensionHarness();
      registerExtension(harness.pi);
      await harness.handler("session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );

      for (const toolCallId of ["call-1", "call-2"]) {
        const result = await harness.handler("tool_call")(
          { toolName: "bash", toolCallId, input: { command: "echo hi" } },
          ctx,
        );
        assert.equal(result, undefined);
      }

      assert.equal(harness.entries.length, 2);
      assert.equal(harness.messages.length, 0);
      const firstData = harness.entries[0]?.data as {
        trigger: { event: string; toolName: string; toolCallId: string };
        executions: Array<{
          assertionRef: string;
          durationMs: number;
          passed: boolean;
        }>;
      };
      assert.deepEqual(firstData.trigger, {
        event: "tool_call",
        toolName: "bash",
        toolCallId: "call-1",
      });
      assert.equal(firstData.executions.length, 1);
      assert.equal(firstData.executions[0]?.assertionRef, "local/passes");
      assert.equal(firstData.executions[0]?.passed, true);
      assert.ok((firstData.executions[0]?.durationMs ?? -1) >= 0);

      const collapsed = renderEntry(harness, 0, false);
      assert.match(
        collapsed,
        /^\n pi-assert ran 1 command in \d+ms · tool_call bash \(ctrl\+o to expand\)\n$/,
      );
      assert.ok(!collapsed.includes("local/passes"));
      assert.ok(!collapsed.includes("call-1"));

      const expanded = renderEntry(harness, 0, true);
      assert.match(expanded, /^\n pi-assert ran 1 command/m);
      assert.match(expanded, /\n   tool-call id: call-1/);
      assert.match(expanded, /✓ local\/passes\s+\d+ms/);
      assert.ok(!expanded.includes("to expand"));
      assert.equal(
        firstData.executions.reduce(
          (total, execution) => total + execution.durationMs,
          0,
        ),
        Number(collapsed.match(/in (\d+)ms/)?.[1]),
      );

      await harness.handler("turn_end")({ turnIndex: 2 }, ctx);
      assert.equal(harness.entries.length, 3);
      assert.match(
        renderEntry(harness, 2, false),
        /^\n pi-assert ran 2 commands in \d+ms · turn_end 2 \(ctrl\+o to expand\)\n$/,
      );
      const expandedTurn = renderEntry(harness, 2, true);
      assert.match(expandedTurn, /✓ local\/turn-pass\s+\d+ms/);
      assert.match(expandedTurn, /✗ local\/turn-fail\s+\d+ms/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not append entries for filter misses or ordinary when skips", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-assert-index-skips-"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          miss: {
            description: "different tool",
            hook: "tool_call",
            filter: { toolName: "^read$" },
            shell: "true",
            default: true,
          },
          skip: {
            description: "precondition skips",
            hook: "tool_call",
            when: "false",
            shell: "true",
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
          notify: () => {},
        },
      } as unknown as ExtensionContext;
      const harness = extensionHarness();
      registerExtension(harness.pi);
      await harness.handler("session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );
      await harness.handler("tool_call")(
        { toolName: "bash", toolCallId: "skipped", input: {} },
        ctx,
      );
      assert.deepEqual(harness.entries, []);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists bounded mixed summaries and nests synthetic actions under their origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-assert-index-mixed-actions-"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          origin: {
            description: "origin",
            hook: "tool_call",
            shell: "true",
            default: true,
          },
          native: {
            description: "native action",
            hook: "tool_call",
            action: {
              type: "message",
              outcome: "pass",
              message: "NATIVE_SECRET",
              delivery: "followUp",
            },
            default: true,
          },
          after: {
            description: "synthetic action",
            hook: "assert_result",
            action: {
              type: "message",
              outcome: "pass",
              message: "SYNTHETIC_SECRET",
              delivery: "nextTurn",
            },
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
          notify: () => {},
        },
      } as unknown as ExtensionContext;
      const harness = extensionHarness();
      registerExtension(harness.pi);
      await harness.handler("session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );

      await harness.handler("tool_call")(
        { toolName: "bash", toolCallId: "mixed", input: {} },
        ctx,
      );

      assert.equal(harness.messages.length, 3);
      assert.equal(harness.entries.length, 1);
      const persisted = JSON.stringify(harness.entries[0]?.data);
      assert.ok(!persisted.includes("NATIVE_SECRET"));
      assert.ok(!persisted.includes("SYNTHETIC_SECRET"));
      assert.match(
        renderEntry(harness, 0, false),
        /ran 4 commands in \d+ms and requested 3 actions · tool_call bash/,
      );
      assert.match(
        renderEntry(harness, 0, true),
        /↳ → local\/after · message requested/,
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues rendering historical version-1 command summaries", () => {
    const harness = extensionHarness();
    registerExtension(harness.pi);
    harness.entries.push({
      customType: "pi-assert-execution",
      data: {
        version: 1,
        trigger: {
          event: "tool_call",
          toolName: "bash",
          toolCallId: "historical",
        },
        executions: [{
          assertionRef: "local/old",
          runId: "old-run",
          hook: "tool_call",
          durationMs: 3,
          passed: true,
        }],
      },
    });
    assert.match(
      renderEntry(harness, 0, false),
      /pi-assert ran 1 command in 3ms · tool_call bash/,
    );
  });

  it("renders malformed historical payloads locally instead of throwing", () => {
    const harness = extensionHarness();
    registerExtension(harness.pi);
    harness.entries.push({
      customType: "pi-assert-execution",
      data: { version: 0, executions: "older-shape" },
    });
    assert.equal(
      renderEntry(harness, 0, true).trim(),
      "pi-assert execution summary unavailable",
    );
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

      assert.equal(harness.entries.length, 1);
      const expanded = renderEntry(harness, 0, true, 160);
      assert.match(expanded, /pi-assert ran 6 commands in \d+ms · tool_call bash/);
      assert.match(
        expanded,
        /✓ local\/passes[\s\S]*↳ ✗ local\/failing-handler[\s\S]*↳ ✓ local\/logger/,
      );
      assert.match(
        expanded,
        /✗ local\/blocks[\s\S]*↳ ✗ local\/failing-handler[\s\S]*↳ ✓ local\/logger/,
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("index effect and outcome translation", () => {
  it("continues ordered feedback when execution-entry delivery fails", async () => {
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
            description: "present before corrective feedback",
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
      (harness.pi as unknown as {
        appendEntry: () => void;
      }).appendEntry = () => {
        deliveries.push("entry");
        throw new Error("entry delivery failed");
      };

      await harness.handler("agent_end")({ messages: [] }, ctx);

      assert.equal(deliveries.length, 3);
      assert.equal(deliveries[0], "entry");
      assert.match(deliveries[1]!, /assert_result assertion failed/);
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
      assert.equal(harness.entries.length, 1);
      assert.match(
        renderEntry(harness, 0, false),
        /^\n pi-assert ran 1 command in \d+ms · tool_result read \(ctrl\+o to expand\)\n$/,
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("index owned Action delivery", () => {
  it("maps every action onto supported Pi APIs in configured order", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-assert-index-actions-"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          interrupt: {
            description: "stop work",
            hook: "tool_call",
            action: { type: "interrupt", outcome: "pass" },
            default: true,
          },
          shutdown: {
            description: "exit",
            hook: "tool_call",
            action: { type: "shutdown", outcome: "pass", interrupt: true },
            default: true,
          },
          drain: {
            description: "exit without interrupting",
            hook: "tool_call",
            action: { type: "shutdown", outcome: "pass" },
            default: true,
          },
          compact: {
            description: "summarize",
            hook: "tool_call",
            action: {
              type: "compact",
              outcome: "pass",
              instructions: "Keep decisions",
            },
            default: true,
          },
          compactDefault: {
            description: "summarize with defaults",
            hook: "tool_call",
            action: { type: "compact", outcome: "pass" },
            default: true,
          },
          steer: {
            description: "steer",
            hook: "tool_call",
            action: {
              type: "message",
              outcome: "pass",
              message: "steer now",
              delivery: "steer",
              triggerTurn: true,
            },
            default: true,
          },
          later: {
            description: "later",
            hook: "tool_call",
            action: {
              type: "message",
              outcome: "pass",
              message: "follow later",
              delivery: "followUp",
            },
            default: true,
          },
          next: {
            description: "next",
            hook: "tool_call",
            action: {
              type: "message",
              outcome: "pass",
              message: "next prompt",
              delivery: "nextTurn",
            },
            default: true,
          },
          event: {
            description: "integration",
            hook: "tool_call",
            action: {
              type: "emit-custom-event",
              outcome: "pass",
              name: "session_start",
              data: { safe: true },
            },
            default: true,
          },
        },
      }));

      const calls: Array<{ type: string; value?: unknown }> = [];
      let compactError: ((error: Error) => void) | undefined;
      const ctx = {
        cwd: root,
        hasUI: true,
        isProjectTrusted: () => true,
        sessionManager: { getBranch: () => [] },
        abort: () => calls.push({ type: "abort" }),
        shutdown: () => calls.push({ type: "shutdown" }),
        compact: (options: { customInstructions?: string; onError?: (error: Error) => void }) => {
          calls.push({ type: "compact", value: options.customInstructions });
          compactError = options.onError;
        },
        ui: {
          theme: { fg: (_color: string, text: string) => text },
          setStatus: () => {},
          notify: (message: string) => calls.push({ type: "notify", value: message }),
        },
      } as unknown as ExtensionContext;

      const harness = extensionHarness();
      (harness.pi as unknown as {
        sendMessage: (message: unknown, options: unknown) => void;
        events: { emit: (name: string, data: unknown) => void };
      }).sendMessage = (message, options) => {
        calls.push({ type: "message", value: { message, options } });
      };
      (harness.pi as unknown as {
        events: { emit: (name: string, data: unknown) => void };
      }).events = {
        emit: (name, data) => calls.push({ type: "event", value: { name, data } }),
      };
      registerExtension(harness.pi);
      await harness.handler("session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );
      calls.length = 0;

      const result = await harness.handler("tool_call")(
        { toolName: "bash", toolCallId: "actions", input: {} },
        ctx,
      );
      assert.equal(result, undefined);
      assert.deepEqual(calls.map((call) => call.type), [
        "abort",
        "abort",
        "shutdown",
        "shutdown",
        "compact",
        "compact",
        "message",
        "message",
        "message",
        "event",
      ]);
      assert.equal(calls[4]?.value, "Keep decisions");
      assert.equal(calls[5]?.value, undefined);
      assert.deepEqual(calls[6]?.value, {
        message: { customType: "pi-assert", content: "steer now", display: true },
        options: { deliverAs: "steer", triggerTurn: true },
      });
      assert.deepEqual(calls[8]?.value, {
        message: { customType: "pi-assert", content: "next prompt", display: true },
        options: { deliverAs: "nextTurn", triggerTurn: false },
      });
      assert.deepEqual(calls[9]?.value, {
        name: "session_start",
        data: { safe: true },
      });

      assert.equal(harness.entries.length, 1);
      const data = harness.entries[0]?.data as {
        executions: unknown[];
        actionRequests: Array<{ actionType: string }>;
      };
      assert.equal(data.executions.length, 9);
      assert.deepEqual(data.actionRequests.map((request) => request.actionType), [
        "interrupt",
        "shutdown",
        "shutdown",
        "compact",
        "compact",
        "message",
        "message",
        "message",
        "emit-custom-event",
      ]);
      assert.match(
        renderEntry(harness, 0, false),
        /pi-assert ran 9 commands in \d+ms and requested 9 actions · tool_call bash/,
      );
      assert.match(renderEntry(harness, 0, true), /local\/event · emit-custom-event requested/);

      compactError?.(new Error("compact exploded"));
      assert.match(String(calls.at(-1)?.value), /compact exploded/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a native block and continues after one action delivery throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-assert-index-action-failure-"));
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          block: {
            description: "block",
            hook: "tool_call",
            shell: "false",
            default: true,
          },
          broken: {
            description: "broken message",
            hook: "tool_call",
            action: {
              type: "message",
              outcome: "pass",
              message: "x",
              delivery: "steer",
            },
            default: true,
          },
          sibling: {
            description: "still emitted",
            hook: "tool_call",
            action: {
              type: "emit-custom-event",
              outcome: "pass",
              name: "test:sibling",
            },
            default: true,
          },
        },
      }));
      const notices: string[] = [];
      const events: string[] = [];
      const ctx = {
        cwd: root,
        hasUI: true,
        isProjectTrusted: () => true,
        sessionManager: { getBranch: () => [] },
        ui: {
          theme: { fg: (_color: string, text: string) => text },
          setStatus: () => {},
          notify: (message: string) => notices.push(message),
        },
      } as unknown as ExtensionContext;
      const harness = extensionHarness();
      (harness.pi as unknown as { sendMessage: () => void }).sendMessage = () => {
        throw new Error("message failed");
      };
      (harness.pi as unknown as {
        events: { emit: (name: string) => void };
      }).events = { emit: (name) => events.push(name) };
      registerExtension(harness.pi);
      await harness.handler("session_start")(
        { type: "session_start", reason: "startup" },
        ctx,
      );
      notices.length = 0;

      const result = await harness.handler("tool_call")(
        { toolName: "bash", toolCallId: "blocked", input: {} },
        ctx,
      );
      assert.deepEqual(result, {
        block: true,
        reason: 'pi-assert: assertion "block" rejected bash — `false`',
      });
      assert.deepEqual(events, ["test:sibling"]);
      assert.ok(notices.some((message) => message.includes("message failed")));
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
