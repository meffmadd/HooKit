import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  type EntryRenderer,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";

import registerExtension from "../hookit/index.js";
import {
  globalFilePath,
  projectFilePath,
} from "../hookit/config.js";

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

function catalogCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: () => {},
      notify: () => {},
    },
  } as unknown as ExtensionContext;
}

function toolCallEvent(toolName: string, toolCallId: string): Record<string, unknown> {
  return { toolName, toolCallId, input: {} };
}

function toolResultEvent(
  toolName: string,
  toolCallId: string,
  content: Array<{ type: "text"; text: string }> = [{ type: "text", text: "ok" }],
): Record<string, unknown> {
  return { toolName, toolCallId, input: {}, content, isError: false, details: {} };
}

interface ToolLifecycleOutcome {
  readonly callResult: unknown;
  readonly resultResult?: unknown;
}

function wasBlocked(result: unknown): boolean {
  return typeof result === "object" && result !== null &&
    (result as { block?: unknown }).block === true;
}

/**
 * Emit one real Pi tool lifecycle: start → call → result (unless blocked) → end.
 * Both Hook Evaluations therefore share one lifecycle interval and identity.
 */
async function executeTool(
  harness: ExtensionHarness,
  ctx: ExtensionContext,
  toolName: string,
  toolCallId: string,
): Promise<ToolLifecycleOutcome> {
  await harness.handler("tool_execution_start")({ toolName, toolCallId }, ctx);
  try {
    const callResult = await harness.handler("tool_call")(
      toolCallEvent(toolName, toolCallId),
      ctx,
    );
    if (wasBlocked(callResult)) return { callResult };
    const resultResult = await harness.handler("tool_result")(
      toolResultEvent(toolName, toolCallId),
      ctx,
    );
    return { callResult, resultResult };
  } finally {
    await harness.handler("tool_execution_end")({ toolName, toolCallId }, ctx);
  }
}

async function startSession(
  harness: ExtensionHarness,
  ctx: ExtensionContext,
  entries: unknown,
  reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
): Promise<void> {
  const path = projectFilePath(ctx.cwd as string);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries));
  registerExtension(harness.pi);
  await harness.handler("session_start")(
    { type: "session_start", reason },
    ctx,
  );
}

async function withTemporaryHome(
  prefix: string,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    await run(root);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("config storage paths", () => {
  it("keeps the global hook config in Pi's agent directory", () => {
    assert.equal(globalFilePath(), join(getAgentDir(), "hookit.json"));
  });
});

describe("index session enablement lifecycle", () => {
  it("restores enabledEntries on resume and ignores legacy activeHooks", async () => {
    await withTemporaryHome("HooKit-index-enable-restore-", async (root) => {
      const notifications: string[] = [];
      const branch: Array<Record<string, unknown>> = [{
        type: "custom",
        customType: "hookit-config",
        data: {
          enabledEntries: ["local\x00saved"],
          activeHooks: ["local\x00legacy"],
        },
      }];
      const ctx = {
        ...catalogCtx(root),
        sessionManager: { getBranch: () => branch },
        ui: {
          theme: { fg: (_color: string, text: string) => text },
          setStatus: () => {},
          notify: (message: string) => notifications.push(message),
        },
      } as unknown as ExtensionContext;
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          saved: {
            description: "saved branch choice",
            event: "tool_call",
            shell: "false",
          },
          legacy: {
            description: "legacy choice",
            event: "tool_call",
            shell: "false",
          },
          freshDefault: {
            description: "new default ignored in saved mode",
            event: "tool_call",
            shell: "false",
            default: true,
          },
        },
      }, "resume");

      const callResult = await harness.handler("tool_call")(
        toolCallEvent("bash", "saved-branch"),
        ctx,
      );

      assert.deepEqual(callResult, {
        block: true,
        reason: 'hookit: hook "saved" rejected bash — `false`',
      });
      assert.ok(notifications.some((message) => message.includes("1 enabled")));
    });
  });

  it("restores enabledEntries for reload, fork, and clone session starts", async () => {
    await withTemporaryHome("HooKit-index-enable-rebind-", async (root) => {
      // Pi represents clone and fork with the same `fork` session-start reason.
      for (const [operation, reason] of [
        ["reload", "reload"],
        ["fork", "fork"],
        ["clone", "fork"],
      ] as const) {
        const cwd = join(root, operation);
        const ctx = {
          ...catalogCtx(cwd),
          sessionManager: {
            getBranch: () => [{
              type: "custom",
              customType: "hookit-config",
              data: { enabledEntries: ["local\x00saved"] },
            }],
          },
        } as unknown as ExtensionContext;
        const harness = extensionHarness();
        await startSession(harness, ctx, {
          local: {
            saved: {
              description: "branch choice",
              event: "tool_call",
              shell: "false",
            },
            ignoredDefault: {
              description: "ignored default",
              event: "tool_call",
              shell: "false",
              default: true,
            },
          },
        }, reason);

        assert.deepEqual(
          await harness.handler("tool_call")(
            toolCallEvent("bash", `${operation}-branch`),
            ctx,
          ),
          { block: true, reason: 'hookit: hook "saved" rejected bash — `false`' },
        );
      }
    });
  });

  it("restores changed branch enablement after session tree navigation", async () => {
    await withTemporaryHome("HooKit-index-enable-tree-", async (root) => {
      let enabledEntries = ["local\x00first"];
      const ctx = {
        ...catalogCtx(root),
        sessionManager: {
          getBranch: () => [{
            type: "custom",
            customType: "hookit-config",
            data: { enabledEntries },
          }],
        },
      } as unknown as ExtensionContext;
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          first: {
            description: "first branch choice",
            event: "tool_call",
            shell: "false",
          },
          second: {
            description: "second branch choice",
            event: "tool_call",
            shell: "false",
          },
        },
      });
      assert.deepEqual(
        await harness.handler("tool_call")(toolCallEvent("bash", "first"), ctx),
        { block: true, reason: 'hookit: hook "first" rejected bash — `false`' },
      );

      enabledEntries = ["local\x00second"];
      await harness.handler("session_tree")(
        { type: "session_tree", newLeafId: "second", oldLeafId: "first" },
        ctx,
      );

      assert.deepEqual(
        await harness.handler("tool_call")(toolCallEvent("bash", "second"), ctx),
        { block: true, reason: 'hookit: hook "second" rejected bash — `false`' },
      );
    });
  });
});

describe("index catalog authorization", () => {
  it("omits untrusted project storage before catalog creation", async () => {
    await withTemporaryHome("HooKit-index-untrusted-", async (root) => {
      const cwd = join(root, "workspace");
      const globalPath = globalFilePath();
      mkdirSync(dirname(globalPath), { recursive: true });
      writeFileSync(globalPath, JSON.stringify({
        local: {
          global: {
            description: "trusted global guard",
            event: "tool_call",
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
      const { callResult } = await executeTool(
        harness,
        ctx,
        "bash",
        "global",
      );

      assert.deepStrictEqual(callResult, {
        block: true,
        reason: 'hookit: hook "global" rejected bash — `false`',
      });
      assert.ok(!notifications.some((message) => message.includes("failed to parse")));
      assert.ok(notifications.some((message) => message.includes("rejected bash")));
      assert.equal(readFileSync(projectPath, "utf8"), "{ malformed and untrusted");
    });
  });
});

describe("index execution entries", () => {
  it("appends one combined Execution Report for an Execution Wave", async () => {
    await withTemporaryHome("HooKit-index-wave-", async (root) => {
      const ctx = catalogCtx(root);
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          passes: {
            description: "observe successful checks",
            event: "tool_call",
            shell: "true",
            default: true,
          },
          "tool-result": {
            description: "observe result checks",
            event: "tool_result",
            shell: "true",
            default: true,
          },
        },
      });

      // Three tool_call and three tool_result Hook Evaluations form ONE
      // Execution Wave for the whole batch.
      for (const toolCallId of ["call-1", "call-2", "call-3"]) {
        await executeTool(harness, ctx, "read", toolCallId);
      }
      // The combined wave stays pending: nothing is appended yet.
      assert.equal(harness.entries.length, 0);
      assert.equal(harness.messages.length, 0);

      // A non-tool boundary (turn_end) flushes one combined report.
      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);

      assert.equal(harness.entries.length, 1, "no separate call/result reports");
      const data = harness.entries[0]?.data as {
        type: string;
        durationMs: number;
        tools: Array<{ toolName: string; toolCallId: string }>;
        segments: Array<{
          eventContext: { event: string; toolName: string; toolCallId: string };
          rows: Array<{ hookRef: string; passed: boolean }>;
        }>;
      };
      assert.equal(data.type, "tool-wave");
      assert.equal(typeof data.durationMs, "number");
      assert.equal(data.segments.length, 6);
      assert.deepEqual(
        data.segments.map((segment) => `${segment.eventContext.event}:${segment.eventContext.toolCallId}`),
        [
          "tool_call:call-1",
          "tool_result:call-1",
          "tool_call:call-2",
          "tool_result:call-2",
          "tool_call:call-3",
          "tool_result:call-3",
        ],
      );
      assert.deepEqual(data.tools.map((tool) => tool.toolCallId), [
        "call-1",
        "call-2",
        "call-3",
      ]);
      for (const segment of data.segments) {
        assert.equal(segment.rows.length, 1);
        assert.equal(
          segment.rows[0]?.hookRef,
          segment.eventContext.event === "tool_call" ? "local/passes" : "local/tool-result",
        );
        assert.equal(segment.rows[0]?.passed, true);
      }

      const collapsed = renderEntry(harness, 0, false);
      assert.match(collapsed, /HooKit guarded 3 tools with 6 Hooks in \d+ms · read ×3/);
      assert.ok(!collapsed.includes("local/passes"), "collapsed omits refs");
      assert.ok(!collapsed.includes("call-1"), "collapsed omits call ids");
      assert.match(collapsed, /\(ctrl\+o to expand\)/);

      const expanded = renderEntry(harness, 0, true);
      assert.match(expanded, /tool_call read · id call-1/);
      assert.match(expanded, /tool_call read · id call-3/);
      assert.match(expanded, /✓ local\/passes\s+\d+ms/);
      assert.ok(!expanded.includes("to expand"));
    });
  });

  it("finishes tool-result Effect delivery before the matching lifecycle end", async () => {
    await withTemporaryHome("HooKit-index-effect-lifecycle-", async (root) => {
      const ctx = catalogCtx(root);
      const harness = extensionHarness();
      const timeline: string[] = [];
      (harness.pi as unknown as {
        sendMessage: () => void;
      }).sendMessage = () => timeline.push("effect");
      await startSession(harness, ctx, {
        local: {
          notify: {
            description: "deliver within the tool lifecycle",
            event: "tool_result",
            action: {
              type: "message",
              outcome: "pass",
              message: "done",
              delivery: "followUp",
            },
            default: true,
          },
        },
      });

      await harness.handler("tool_execution_start")(
        { toolName: "read", toolCallId: "effect-order" },
        ctx,
      );
      await harness.handler("tool_call")(
        toolCallEvent("read", "effect-order"),
        ctx,
      );
      // Simulate actual tool execution between call and result callbacks. The
      // durable wave duration must include this lifecycle interval.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await harness.handler("tool_result")(
        toolResultEvent("read", "effect-order"),
        ctx,
      );
      timeline.push("result-complete");
      await harness.handler("tool_execution_end")(
        { toolName: "read", toolCallId: "effect-order" },
        ctx,
      );
      timeline.push("end-complete");

      assert.deepEqual(timeline, [
        "effect",
        "result-complete",
        "end-complete",
      ]);

      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);
      const entry = harness.entries[0]?.data as {
        type: string;
        durationMs: number;
      };
      assert.equal(entry.type, "tool-wave");
      assert.ok(entry.durationMs >= 15, "duration includes actual tool time");
    });
  });

  it("flushes a combined tool_result wave at a turn_end boundary", async () => {
    await withTemporaryHome("HooKit-index-results-wave-", async (root) => {
      const ctx = catalogCtx(root);
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          redact: {
            description: "observe successful result checks",
            event: "tool_result",
            shell: "true",
            default: true,
          },
        },
      });

      for (const toolCallId of ["r1", "r2", "r3"]) {
        await executeTool(harness, ctx, "bash", toolCallId);
      }
      assert.equal(harness.entries.length, 0);

      // turn_end has no matching hook here but still flushes the wave.
      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);
      assert.equal(harness.entries.length, 1);
      const data = harness.entries[0]?.data as {
        type: string;
        segments: Array<{ eventContext: { toolCallId: string } }>;
      };
      assert.equal(data.type, "tool-wave");
      assert.deepEqual(
        data.segments.map((segment) => segment.eventContext.toolCallId),
        ["r1", "r1", "r2", "r2", "r3", "r3"],
      );
      assert.match(
        renderEntry(harness, 0, false),
        /HooKit guarded 3 tools with 3 Hooks in \d+ms · bash ×3/,
      );
    });
  });

  it("merges alternating sequential tool_call/tool_result callbacks into one wave report", async () => {
    await withTemporaryHome("HooKit-index-alternating-", async (root) => {
      const ctx = catalogCtx(root);
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          "call-check": {
            description: "observe calls",
            event: "tool_call",
            shell: "true",
            default: true,
          },
          "result-check": {
            description: "observe results",
            event: "tool_result",
            shell: "true",
            default: true,
          },
        },
      });

      for (const toolCallId of ["c1", "c2"]) {
        await executeTool(harness, ctx, "bash", toolCallId);
      }
      // The combined wave is still pending until the next boundary.
      assert.equal(harness.entries.length, 0);
      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);

      // One combined report, not separate call/result reports per tool.
      assert.equal(harness.entries.length, 1);
      const data = harness.entries[0]?.data as {
        type: string;
        segments: Array<{ eventContext: { event: string; toolCallId: string } }>;
      };
      assert.equal(data.type, "tool-wave");
      assert.deepEqual(
        data.segments.map((segment) => `${segment.eventContext.event}:${segment.eventContext.toolCallId}`),
        ["tool_call:c1", "tool_result:c1", "tool_call:c2", "tool_result:c2"],
      );
    });
  });

  it("renders a lone tool wave and an ordinary turn_end report with the common shape", async () => {
    await withTemporaryHome("HooKit-index-shapes-", async (root) => {
      const ctx = catalogCtx(root);
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          passes: {
            description: "observe successful checks",
            event: "tool_call",
            shell: "true",
            default: true,
          },
          "turn-pass": {
            description: "first aggregate check",
            event: "turn_end",
            shell: "true",
            default: true,
          },
          "turn-fail": {
            description: "second aggregate check",
            event: "turn_end",
            shell: "false",
            default: true,
          },
        },
      });

      const { callResult } = await executeTool(
        harness,
        ctx,
        "read",
        "call-1",
      );
      assert.equal(callResult, undefined);
      assert.equal(harness.entries.length, 0);

      await harness.handler("turn_end")({ turnIndex: 2 }, ctx);
      // The tool wave report precedes the non-tool turn_end report.
      assert.equal(harness.entries.length, 2);

      const wave = renderEntry(harness, 0, false);
      assert.match(
        wave,
        /HooKit guarded 1 tool with 1 Hook in \d+ms · read ×1 \(ctrl\+o to expand\)/,
      );
      const waveExpanded = renderEntry(harness, 0, true);
      assert.match(waveExpanded, /tool_call read · id call-1/);
      assert.match(waveExpanded, /✓ local\/passes\s+\d+ms/);
      assert.ok(!waveExpanded.includes("to expand"));

      const turn = renderEntry(harness, 1, false);
      assert.match(
        turn,
        /HooKit ran 2 Hooks in \d+ms · turn_end 2 \(ctrl\+o to expand\)/,
      );
      const turnExpanded = renderEntry(harness, 1, true);
      assert.match(turnExpanded, /✓ local\/turn-pass\s+\d+ms/);
      assert.match(turnExpanded, /✗ local\/turn-fail\s+\d+ms/);
    });
  });

  it("does not append entries for filter misses or ordinary when skips", async () => {
    await withTemporaryHome("HooKit-index-skips-", async (root) => {
      const ctx = catalogCtx(root);
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          miss: {
            description: "different tool",
            event: "tool_call",
            filter: { toolName: "^read$" },
            shell: "true",
            default: true,
          },
          skip: {
            description: "precondition skips",
            event: "tool_call",
            when: "false",
            shell: "true",
            default: true,
          },
        },
      });

      await executeTool(harness, ctx, "bash", "skipped");
      // Flushing an entirely empty wave produces no entry.
      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);
      assert.deepEqual(harness.entries, []);
    });
  });

  it("persists bounded mixed summaries and flattens reactive Actions after their origin", async () => {
    await withTemporaryHome("HooKit-index-mixed-actions-", async (root) => {
      const ctx = catalogCtx(root);
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          origin: {
            description: "origin",
            event: "tool_call",
            shell: "true",
            default: true,
          },
          native: {
            description: "native action",
            event: "tool_call",
            action: {
              type: "message",
              outcome: "pass",
              message: "NATIVE_SECRET",
              delivery: "followUp",
            },
            default: true,
          },
          after: {
            description: "reactive Action",
            event: "hook_result",
            action: {
              type: "message",
              outcome: "pass",
              message: "SYNTHETIC_SECRET",
              delivery: "nextTurn",
            },
            default: true,
          },
        },
      });

      await executeTool(harness, ctx, "bash", "mixed");
      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);

      assert.equal(harness.messages.length, 3);
      assert.equal(harness.entries.length, 1);
      const persisted = JSON.stringify(harness.entries[0]?.data);
      assert.ok(!persisted.includes("NATIVE_SECRET"));
      assert.ok(!persisted.includes("SYNTHETIC_SECRET"));
      assert.ok(!persisted.includes("\"invocationId\""));
      // Report rows use `type: "hook"`, so the old no-event-kind guard becomes
      // a boundedness invariant: raw tool input is never persisted.
      assert.ok(!persisted.includes("\"input\""));
      assert.match(
        renderEntry(harness, 0, false),
        /guarded 1 tool with 4 Hooks and requested 3 Actions in \d+ms · bash ×1/,
      );
      const expanded = renderEntry(harness, 0, true);
      assert.ok(!expanded.includes("↳"), "no nested causal rendering");
      assert.match(expanded, /→ local\/after · message requested · pass · from local\/origin pass/);
      assert.match(expanded, /✓ local\/after\s+\d+ms · from local\/origin pass/);
    });
  });

  it("flushes all-preflight-blocked calls at turn_end", async () => {
    await withTemporaryHome("HooKit-index-blocked-flush-", async (root) => {
      const ctx = catalogCtx(root);
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          block: {
            description: "block every call",
            event: "tool_call",
            shell: "false",
            default: true,
          },
        },
      });

      for (const toolCallId of ["b1", "b2"]) {
        const { callResult } = await executeTool(
          harness,
          ctx,
          "bash",
          toolCallId,
        );
        assert.deepStrictEqual(callResult, {
          block: true,
          reason: `hookit: hook "block" rejected bash — \`false\``,
        });
      }
      assert.equal(harness.entries.length, 0);

      // Blocked tools emit lifecycle start/end, so the wave remains valid;
      // turn_end flushes one combined report.
      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);
      assert.equal(harness.entries.length, 1);
      assert.equal(
        (harness.entries[0]?.data as { type: string }).type,
        "tool-wave",
      );
      assert.match(
        renderEntry(harness, 0, false),
        /HooKit guarded 2 tools with 2 Hooks in \d+ms · bash ×2/,
      );
    });
  });

  it("flushes pending completed reporting on session_shutdown", async () => {
    await withTemporaryHome("HooKit-index-shutdown-", async (root) => {
      const ctx = catalogCtx(root);
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          passes: {
            description: "observe successful checks",
            event: "tool_call",
            shell: "true",
            default: true,
          },
        },
      });

      await executeTool(harness, ctx, "read", "call-1");
      assert.equal(harness.entries.length, 0);

      await harness.handler("session_shutdown")(
        { type: "session_shutdown" },
        ctx,
      );
      assert.equal(harness.entries.length, 1);
      assert.match(
        renderEntry(harness, 0, false),
        /HooKit guarded 1 tool with 1 Hook in \d+ms · read ×1/,
      );
    });
  });

  it("completes an observation when callback context capture escapes", async () => {
    await withTemporaryHome("HooKit-index-capture-escape-", async (root) => {
      const ctx = catalogCtx(root);
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          passes: {
            description: "observe successful checks",
            event: "tool_call",
            shell: "true",
            default: true,
          },
        },
      });

      const sessionManager = ctx.sessionManager;
      let captureFails = true;
      Object.defineProperty(ctx, "sessionManager", {
        configurable: true,
        get: () => {
          if (captureFails) throw new Error("context capture failed");
          return sessionManager;
        },
      });

      await harness.handler("tool_execution_start")(
        { toolName: "read", toolCallId: "capture-failed" },
        ctx,
      );
      await assert.rejects(async () => {
        await harness.handler("tool_call")(
          toolCallEvent("read", "capture-failed"),
          ctx,
        );
      }, /context capture failed/);
      await harness.handler("tool_execution_end")(
        { toolName: "read", toolCallId: "capture-failed" },
        ctx,
      );

      captureFails = false;
      await executeTool(harness, ctx, "read", "capture-succeeded");
      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);

      assert.equal(harness.entries.length, 1);
      const data = harness.entries[0]!.data as {
        type: string;
        segments: Array<{
          eventContext: { toolCallId: string };
          rows: unknown[];
        }>;
      };
      assert.deepEqual(
        data.segments.map((segment) => segment.eventContext.toolCallId),
        ["capture-failed", "capture-succeeded", "capture-succeeded"],
      );
      assert.deepEqual(data.segments[0]!.rows, []);
      assert.equal(data.segments[1]!.rows.length, 1);
      assert.deepEqual(data.segments[2]!.rows, []);
    });
  });

  it("renders malformed current-type payloads as an unavailable fallback", () => {
    const harness = extensionHarness();
    registerExtension(harness.pi);
    harness.entries.push({
      customType: "hookit-execution",
      data: { type: "tool-wave", durationMs: -1, tools: [], segments: [] },
    });
    harness.entries.push({
      customType: "hookit-execution",
      data: { type: "event", durationMs: 0, segment: { eventContext: {}, rows: [] } },
    });
    for (const index of [0, 1]) {
      assert.equal(
        renderEntry(harness, index, true).trim(),
        "HooKit execution summary unavailable",
      );
    }
  });
});

describe("index Hook Result Event dispatch", () => {
  it("awaits detached handlers without changing the originating block", async () => {
    await withTemporaryHome("HooKit-index-results-", async (root) => {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          passes: {
            description: "pass first",
            event: "tool_call",
            shell: "printf '%s' \"$PI_REASONING_LEVEL\" > reasoning.log",
            default: true,
          },
          blocks: {
            description: "then block",
            event: "tool_call",
            shell: "exit 6",
            default: true,
          },
          "failing-handler": {
            description: "handler reporting must be isolated",
            event: "hook_result",
            shell: "false",
            default: true,
          },
          logger: {
            description: "record every result",
            event: "hook_result",
            filter: {
              hookRef: "^local/",
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
            if (message.includes("hook_result")) {
              throw new Error("reactive reporting failed");
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

      const { callResult } = await executeTool(
        harness,
        ctx,
        "bash",
        "call-1",
      );
      assert.deepStrictEqual(callResult, {
        block: true,
        reason: 'hookit: hook "blocks" rejected bash — `exit 6`',
      });
      assert.equal(readFileSync(join(root, "reasoning.log"), "utf8"), "high");

      const payloads = readFileSync(join(root, "handled.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { hookRef: string; outcome: string });
      assert.deepStrictEqual(payloads.map(({ hookRef, outcome }) => ({
        hookRef,
        outcome,
      })), [
        { hookRef: "local/passes", outcome: "pass" },
        { hookRef: "local/blocks", outcome: "block" },
      ]);

      // Pi emits turn_end after Hook Result Events for a preflight-blocked wave.
      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);
      assert.equal(harness.entries.length, 1);
      const expanded = renderEntry(harness, 0, true, 160);
      assert.match(
        expanded,
        /HooKit guarded 1 tool with 6 Hooks in \d+ms · bash ×1/,
      );
      // Sibling handlers still run after the failing handler and appear flat
      // right after their originating Hook Result.
      const passesPos = expanded.indexOf("✓ local/passes");
      const failingPos = expanded.indexOf("✗ local/failing-handler");
      const loggerPos = expanded.indexOf("✓ local/logger");
      const blocksPos = expanded.indexOf("✗ local/blocks");
      assert.ok(passesPos >= 0 && failingPos >= 0 && loggerPos >= 0 && blocksPos >= 0);
      assert.ok(
        passesPos < failingPos && failingPos < loggerPos && loggerPos < blocksPos,
        "passes rows, then its handlers, then the blocks rows, in result-major order",
      );
      assert.match(
        expanded,
        /✗ local\/failing-handler\s+\d+ms · from local\/passes pass/,
      );
      assert.match(
        expanded,
        /✓ local\/logger\s+\d+ms · from local\/passes pass/,
      );
      assert.match(
        expanded,
        /✗ local\/failing-handler\s+\d+ms · from local\/blocks block/,
      );
      assert.match(
        expanded,
        /✓ local\/logger\s+\d+ms · from local\/blocks block/,
      );
      assert.ok(!expanded.includes("↳"), "flat rows, no causal nesting");
    });
  });
});

describe("index effect and outcome translation", () => {
  it("uses only the first Native Event Outcome for callback control", async () => {
    await withTemporaryHome("HooKit-index-reactive-outcome-", async (root) => {
      const ctx = catalogCtx(root);
      const notifications: string[] = [];
      ctx.ui.notify = (message: string) => notifications.push(message);
      const harness = extensionHarness();
      await startSession(harness, ctx, {
        local: {
          origin: {
            description: "allow the Native Event",
            event: "tool_call",
            shell: "true",
            default: true,
          },
          reactive: {
            description: "report the Hook Result Event",
            event: "hook_result",
            shell: "false",
            default: true,
          },
        },
      });
      notifications.length = 0;

      const callbackResult = await harness.handler("tool_call")(
        toolCallEvent("bash", "reactive-report"),
        ctx,
      );

      assert.equal(callbackResult, undefined, "reactive report cannot block Pi");
      assert.equal(notifications.length, 1);
      assert.match(notifications[0] ?? "", /hook_result hook failed/);
    });
  });

  it("continues ordered feedback when execution-entry delivery fails", async () => {
    await withTemporaryHome("HooKit-index-effects-", async (root) => {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          "end-check": {
            description: "request a correction",
            event: "agent_end",
            shell: "false",
            default: true,
          },
          "failing-handler": {
            description: "present before corrective feedback",
            event: "hook_result",
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
      assert.match(deliveries[0]!, /hook_result hook failed/);
      assert.match(deliveries[1]!, /^corrective:1 hook failed/);
      assert.equal(deliveries[2], "entry");
    });
  });

  it("translates a patch in headless mode without relying on UI delivery", async () => {
    await withTemporaryHome("HooKit-index-patch-", async (root) => {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          redact: {
            description: "suppress results",
            event: "tool_result",
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
      await harness.handler("tool_execution_start")(
        { toolName: "read", toolCallId: "result-1" },
        ctx,
      );
      await harness.handler("tool_call")(
        toolCallEvent("read", "result-1"),
        ctx,
      );
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
      await harness.handler("tool_execution_end")(
        { toolName: "read", toolCallId: "result-1" },
        ctx,
      );

      assert.equal(patch.isError, true);
      assert.strictEqual(patch.details, details);
      assert.match(patch.content[0]!.text, /original tool result was suppressed/);
      // The combined tool wave report is flushed at the next boundary.
      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);
      assert.equal(harness.entries.length, 1);
      assert.match(
        renderEntry(harness, 0, false),
        /HooKit guarded 1 tool with 1 Hook in \d+ms · read ×1 \(ctrl\+o to expand\)/,
      );
    });
  });
});

describe("index owned Action delivery", () => {
  it("maps every action onto supported Pi APIs in configured order", async () => {
    await withTemporaryHome("HooKit-index-actions-", async (root) => {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          interrupt: {
            description: "stop work",
            event: "tool_call",
            action: { type: "interrupt", outcome: "pass" },
            default: true,
          },
          shutdown: {
            description: "exit",
            event: "tool_call",
            action: { type: "shutdown", outcome: "pass", interrupt: true },
            default: true,
          },
          drain: {
            description: "exit without interrupting",
            event: "tool_call",
            action: { type: "shutdown", outcome: "pass" },
            default: true,
          },
          compact: {
            description: "summarize",
            event: "tool_call",
            action: {
              type: "compact",
              outcome: "pass",
              instructions: "Keep decisions",
            },
            default: true,
          },
          compactDefault: {
            description: "summarize with defaults",
            event: "tool_call",
            action: { type: "compact", outcome: "pass" },
            default: true,
          },
          steer: {
            description: "steer",
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
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
            event: "tool_call",
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

      const { callResult } = await executeTool(
        harness,
        ctx,
        "bash",
        "actions",
      );
      assert.equal(callResult, undefined);
      await harness.handler("turn_end")({ turnIndex: 1 }, ctx);
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
        message: { customType: "hookit", content: "steer now", display: true },
        options: { deliverAs: "steer", triggerTurn: true },
      });
      assert.deepEqual(calls[8]?.value, {
        message: { customType: "hookit", content: "next prompt", display: true },
        options: { deliverAs: "nextTurn", triggerTurn: false },
      });
      assert.deepEqual(calls[9]?.value, {
        name: "session_start",
        data: { safe: true },
      });

      assert.equal(harness.entries.length, 1);
      const data = harness.entries[0]?.data as {
        type: string;
        segments: Array<{ rows: Array<{ type: string; actionType?: string }> }>;
      };
      assert.equal(data.type, "tool-wave");
      assert.deepEqual(
        data.segments.map((segment) => segment.rows.length),
        [18, 0],
      );
      const rows = data.segments.flatMap((segment) => segment.rows);
      assert.equal(rows.filter((row) => row.type === "hook").length, 9);
      assert.deepEqual(
        rows
          .filter((row): row is { type: "action"; actionType: string } =>
            row.type === "action" && "actionType" in row)
          .map((row) => row.actionType),
        [
          "interrupt",
          "shutdown",
          "shutdown",
          "compact",
          "compact",
          "message",
          "message",
          "message",
          "emit-custom-event",
        ],
      );
      assert.match(
        renderEntry(harness, 0, false),
        /HooKit guarded 1 tool with 9 Hooks and requested 9 Actions in \d+ms · bash ×1/,
      );
      assert.match(renderEntry(harness, 0, true), /local\/event · emit-custom-event requested · pass/);

      compactError?.(new Error("compact exploded"));
      assert.match(String(calls.at(-1)?.value), /compact exploded/);
    });
  });

  it("keeps a native block and continues after one action delivery throws", async () => {
    await withTemporaryHome("HooKit-index-action-failure-", async (root) => {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          block: {
            description: "block",
            event: "tool_call",
            shell: "false",
            default: true,
          },
          broken: {
            description: "broken message",
            event: "tool_call",
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
            event: "tool_call",
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

      const { callResult } = await executeTool(
        harness,
        ctx,
        "bash",
        "blocked",
      );
      assert.deepEqual(callResult, {
        block: true,
        reason: 'hookit: hook "block" rejected bash — `false`',
      });
      assert.deepEqual(events, ["test:sibling"]);
      assert.ok(notices.some((message) => message.includes("message failed")));
    });
  });
});

describe("index session guard dispatch", () => {
  it("returns cancellation even when failure feedback throws", async () => {
    await withTemporaryHome("HooKit-index-hooks-", async (root) => {
      const path = projectFilePath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        local: {
          switch: {
            description: "block switches",
            event: "session_before_switch",
            shell: "false",
            default: true,
          },
          fork: {
            description: "block forks",
            event: "session_before_fork",
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
    });
  });
});
