/**
 * Tests for durable Execution Reports for combined Execution Waves built by
 * `ExecutionReporter` and rendered by `renderExecutionEntry`
 * (`HooKit/ui/execution-report.ts`).
 *
 * The contract under test is externally visible report construction, append
 * ordering, timing, and rendering — not private accumulator fields. Timing
 * uses an injected deterministic monotonic clock. Every wave is bracketed by
 * `toolStarted`/`toolEnded` lifecycle events, as the Pi adapter does.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent";

import {
  ExecutionReporter,
  renderExecutionEntry,
  type ExecutionReportEntryData,
  type ExecutionEventContext,
} from "../hookit/ui/execution-report.js";
import type {
  HookExecutionReport,
  EvaluationReportRow,
} from "../hookit/hook-evaluation/index.js";

function makeClock(start = 1000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makeReporter(
  entries: ExecutionReportEntryData[],
  clock = makeClock(),
): ExecutionReporter {
  return new ExecutionReporter({
    now: clock.now,
    append: (entry) => entries.push(entry),
  });
}

function toolEventContext(
  toolName: string,
  toolCallId: string,
  event: "tool_call" | "tool_result" = "tool_call",
): ExecutionEventContext {
  return { event, toolName, toolCallId };
}

function makeHookRow(
  partial: Partial<Extract<EvaluationReportRow, { type: "hook" }>> = {},
): EvaluationReportRow {
  return {
    type: "hook",
    hookRef: "local/guard",
    durationMs: 3,
    passed: true,
    ...partial,
  };
}

function makeActionRow(
  partial: Partial<Extract<EvaluationReportRow, { type: "action" }>> = {},
): EvaluationReportRow {
  return {
    type: "action",
    hookRef: "local/act",
    actionType: "message",
    outcome: "pass",
    ...partial,
  };
}

function makeReport(rows: readonly EvaluationReportRow[] = []): HookExecutionReport {
  return { rows };
}

const renderTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
} as unknown as Theme;

const renderer = renderExecutionEntry as EntryRenderer<unknown>;

function renderEntry(
  data: unknown,
  expanded: boolean,
  width = 120,
): string {
  const component = renderer(
    {
      type: "custom",
      id: "entry-test",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      customType: "hookit-execution",
      data,
    },
    { expanded },
    renderTheme,
  );
  assert.ok(component, "entry renderer returned no component");
  return component.render(width).map((line) => line.trimEnd()).join("\n");
}

/** Drive one complete tool through lifecycle + a single call observation. */
function completeTool(
  reporter: ExecutionReporter,
  clock: ReturnType<typeof makeClock>,
  toolName: string,
  toolCallId: string,
  rows: readonly EvaluationReportRow[],
  event: "tool_call" | "tool_result" = "tool_call",
): void {
  reporter.toolStarted(toolName, toolCallId);
  const observation = reporter.begin(
    event,
    toolEventContext(toolName, toolCallId, event),
  );
  clock.advance(3);
  reporter.complete(observation, makeReport(rows));
  reporter.toolEnded(toolName, toolCallId);
}

describe("ExecutionReporter tool lifecycle collection", () => {
  it("1. builds one combined report for a parallel wave in begin order", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    // A starts first.
    reporter.toolStarted("bash", "A");
    const callA = reporter.begin("tool_call", toolEventContext("bash", "A"));
    clock.advance(5);
    reporter.complete(callA, makeReport([makeHookRow({ hookRef: "local/a" })]));

    // B starts second.
    reporter.toolStarted("read", "B");
    const callB = reporter.begin("tool_call", toolEventContext("read", "B"));
    clock.advance(4);
    reporter.complete(callB, makeReport([makeHookRow({ hookRef: "local/b" })]));

    // B results and ends first.
    const resultB = reporter.begin("tool_result", toolEventContext("read", "B", "tool_result"));
    clock.advance(3);
    reporter.complete(resultB, makeReport([makeHookRow({ hookRef: "local/b2" })]));
    reporter.toolEnded("read", "B");

    // A results and ends last.
    const resultA = reporter.begin("tool_result", toolEventContext("bash", "A", "tool_result"));
    clock.advance(7);
    reporter.complete(resultA, makeReport([makeHookRow({ hookRef: "local/a2" })]));
    reporter.toolEnded("bash", "A");

    // The wave stays pending until a non-tool boundary begins.
    assert.equal(entries.length, 0);
    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });

    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.type, "tool-wave");
    // duration = last end (1019) - first start (1000)
    assert.equal(entry.durationMs, 19);
    // segment order is begin order: call A, call B, result B, result A
    assert.deepEqual(
      entry.segments.map((segment) => segment.eventContext.toolCallId),
      ["A", "B", "B", "A"],
    );
    assert.deepEqual(
      entry.segments.map((segment) => segment.eventContext.event),
      ["tool_call", "tool_call", "tool_result", "tool_result"],
    );
    // tool breakdown counts A and B once each.
    assert.deepEqual(entry.tools.map((tool) => tool.toolCallId), ["A", "B"]);
    assert.match(
      renderEntry(entry, false),
      /HooKit guarded 2 tools with 4 Hooks in 19ms · bash ×1, read ×1/,
    );
  });

  it("2. sequential wave duration spans first start through last end", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    completeTool(reporter, clock, "bash", "T1", [makeHookRow()]);
    clock.advance(4); // transition to the second tool
    completeTool(reporter, clock, "read", "T2", [makeHookRow()]);

    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });
    const entry = entries[0]!;
    assert.equal(entry.type, "tool-wave");
    // T1: [1000, 1003]; 4ms transition; T2: [1007, 1010].
    // One end-to-end duration: last end (1010) - first start (1000) = 10.
    assert.equal(entry.durationMs, 10);
    assert.deepEqual(entry.tools.map((tool) => tool.toolCallId), ["T1", "T2"]);
  });

  it("3. blocked tool receives a finite duration from start + immediate end", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    reporter.toolStarted("bash", "blocked");
    const call = reporter.begin("tool_call", toolEventContext("bash", "blocked"));
    clock.advance(2);
    reporter.complete(
      call,
      makeReport([
        makeHookRow({ hookRef: "local/block", passed: false }),
        makeActionRow({ hookRef: "local/block", actionType: "interrupt", outcome: "block" }),
      ]),
    );
    reporter.toolEnded("bash", "blocked");

    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });
    const entry = entries[0]!;
    assert.equal(entry.type, "tool-wave");
    assert.equal(entry.durationMs, 2);
    const expanded = renderEntry(entry, true);
    assert.match(expanded, /✗ local\/block/);
    assert.match(expanded, /→ local\/block · interrupt requested · block/);
  });

  it("4. a tool without matching Hooks still contributes to duration and breakdown", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    // read/empty has no rows but is a completed tool.
    reporter.toolStarted("read", "empty");
    const emptyCall = reporter.begin("tool_call", toolEventContext("read", "empty"));
    clock.advance(2);
    reporter.complete(emptyCall, makeReport([]));
    reporter.toolEnded("read", "empty");

    // bash/busy gives the wave its report data.
    reporter.toolStarted("bash", "busy");
    const busyCall = reporter.begin("tool_call", toolEventContext("bash", "busy"));
    clock.advance(3);
    reporter.complete(busyCall, makeReport([makeHookRow()]));
    reporter.toolEnded("bash", "busy");

    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });
    const entry = entries[0]!;
    assert.equal(entry.type, "tool-wave");
    // duration spans empty's start (1000) through busy's end (1005).
    assert.equal(entry.durationMs, 5);
    assert.deepEqual(entry.tools.map((tool) => tool.toolCallId), ["empty", "busy"]);
    assert.match(
      renderEntry(entry, false),
      /guarded 2 tools with 1 Hook in 5ms · read ×1, bash ×1/,
    );
    // The empty segment stays persisted in Pi order but adds no expanded view.
    assert.deepEqual(
      entry.segments.map((segment) => segment.eventContext.toolCallId),
      ["empty", "busy"],
    );
    const expanded = renderEntry(entry, true);
    assert.ok(!expanded.includes("id empty"), "empty segment header omitted");
  });

  it("5. appends nothing for an entirely empty wave", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    completeTool(reporter, clock, "read", "c1", []);
    completeTool(reporter, clock, "read", "c2", []);
    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });
    assert.deepEqual(entries, []);
  });

  it("6. non-tool Hook Evaluation duration is its outer callback interval and appends immediately", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(500);
    const reporter = makeReporter(entries, clock);

    const observation = reporter.begin("turn_end", { event: "turn_end", turnIndex: 2 });
    clock.advance(12);
    reporter.complete(observation, makeReport([makeHookRow({ durationMs: 3 })]));

    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.type, "event");
    assert.equal(entry.durationMs, 12);
    assert.deepEqual(entry.segment.eventContext, { event: "turn_end", turnIndex: 2 });
    assert.match(
      renderEntry(entry, false),
      /HooKit ran 1 Hook in 12ms · turn_end 2/,
    );
  });

  it("a non-tool Hook Evaluation with no rows appends nothing", () => {
    const entries: ExecutionReportEntryData[] = [];
    const reporter = makeReporter(entries);
    const observation = reporter.begin("agent_end", { event: "agent_end" });
    reporter.complete(observation, makeReport([]));
    assert.deepEqual(entries, []);
  });
});

describe("ExecutionReporter shutdown and failure", () => {
  it("7. flushes a complete pending wave once and is idempotent", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    completeTool(reporter, clock, "read", "c1", [makeHookRow()]);
    assert.equal(entries.length, 0);
    reporter.flush();
    assert.equal(entries.length, 1);
    reporter.flush();
    assert.equal(entries.length, 1);
  });

  it("7. discards an incomplete wave rather than assigning an end", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    reporter.toolStarted("read", "mid-flight");
    const observation = reporter.begin("tool_call", toolEventContext("read", "mid-flight"));
    clock.advance(10);
    reporter.complete(observation, makeReport([makeHookRow()]));
    // No toolEnded: the wave has no valid interval.
    reporter.flush();
    assert.deepEqual(entries, []);
  });

  it("7. drops a failed append without retrying, merging, or poisoning later waves", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(500);
    let failures = 0;
    const reporter = new ExecutionReporter({
      now: clock.now,
      append: (entry) => {
        if (failures === 0) {
          failures++;
          throw new Error("append failed");
        }
        entries.push(entry);
      },
    });

    completeTool(reporter, clock, "read", "c1", [makeHookRow()]);
    reporter.flush();
    assert.equal(entries.length, 0, "dropped report is not appended");
    assert.equal(failures, 1);

    completeTool(reporter, clock, "read", "c2", [makeHookRow()]);
    reporter.flush();
    assert.equal(entries.length, 1, "a later wave still appends");
  });

  it("8. cleans and bounds labels while keeping source references out", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    const toolName = `rea\u0000  \u0001d${"x".repeat(600)}`;
    const toolCallId = `call\u0007id${"y".repeat(300)}`;
    const hookRef = `local/\u0000guard\u0001${"z".repeat(600)}`;
    reporter.toolStarted(toolName, toolCallId);
    const observation = reporter.begin(
      "tool_call",
      toolEventContext(toolName, toolCallId),
    );
    reporter.complete(
      observation,
      makeReport([makeHookRow({ hookRef })]),
    );
    reporter.toolEnded(toolName, toolCallId);
    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });

    const entry = entries[0]!;
    assert.equal(entry.type, "tool-wave");
    assert.match(entry.tools[0]!.toolName, /^rea d/);
    assert.equal(entry.tools[0]!.toolName.length, 512);
    assert.match(entry.tools[0]!.toolCallId, /^call id/);
    assert.equal(entry.tools[0]!.toolCallId.length, 256);
    assert.deepEqual(entry.segments[0]!.eventContext, {
      event: "tool_call",
      toolName: entry.tools[0]!.toolName,
      toolCallId: entry.tools[0]!.toolCallId,
    });
    assert.match(entry.segments[0]!.rows[0]!.hookRef, /^local\/ guard/);
    assert.equal(entry.segments[0]!.rows[0]!.hookRef.length, 512);
  });

  it("8. clamps non-finite and oversized Hook row durations", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    reporter.toolStarted("read", "rows-bounded");
    const observation = reporter.begin(
      "tool_call",
      toolEventContext("read", "rows-bounded"),
    );
    reporter.complete(
      observation,
      makeReport([
        makeHookRow({ hookRef: "local/nan", durationMs: Number.NaN }),
        makeHookRow({
          hookRef: "local/infinity",
          durationMs: Number.POSITIVE_INFINITY,
        }),
        makeHookRow({
          hookRef: "local/oversized",
          durationMs: Number.MAX_SAFE_INTEGER,
        }),
        makeHookRow({ hookRef: "local/negative", durationMs: -1 }),
      ]),
    );
    reporter.toolEnded("read", "rows-bounded");
    reporter.flush();

    const entry = entries[0]!;
    assert.equal(entry.type, "tool-wave");
    assert.deepEqual(
      entry.segments[0]!.rows.map((row) =>
        row.type === "hook" ? row.durationMs : undefined
      ),
      [0, 2_147_483_647, 2_147_483_647, 0],
    );
    assert.ok(!JSON.stringify(entry).includes('"durationMs":null'));
  });

  it("8. clamps non-finite and oversized wave durations", () => {
    for (const [endMs, expected] of [
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 2_147_483_647],
      [Number.MAX_SAFE_INTEGER, 2_147_483_647],
    ] as const) {
      const entries: ExecutionReportEntryData[] = [];
      let current = 0;
      const reporter = new ExecutionReporter({
        now: () => current,
        append: (entry) => entries.push(entry),
      });

      reporter.toolStarted("read", "bounded");
      const observation = reporter.begin("tool_call", toolEventContext("read", "bounded"));
      reporter.complete(observation, makeReport([makeHookRow()]));
      current = endMs;
      reporter.toolEnded("read", "bounded");
      reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });

      assert.equal(entries[0]!.type === "tool-wave" && entries[0]!.durationMs, expected);
    }
  });
});

describe("ExecutionReport rendering", () => {
  it("9. renders ordered rows flat with inline origin annotations", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    reporter.toolStarted("bash", "p");
    const call = reporter.begin("tool_call", toolEventContext("bash", "p"));
    clock.advance(2);
    reporter.complete(
      call,
      makeReport([
        makeHookRow({ hookRef: "local/protect-env", durationMs: 8 }),
        makeActionRow({
          hookRef: "local/protect-env",
          actionType: "interrupt",
          outcome: "block",
        }),
        makeHookRow({
          hookRef: "owner/hooks/audit",
          durationMs: 3,
          origin: { hookRef: "local/protect-env", outcome: "block" },
        }),
        makeActionRow({
          hookRef: "owner/hooks/audit",
          actionType: "message",
          outcome: "report",
          origin: { hookRef: "local/protect-env", outcome: "block" },
        }),
      ]),
    );
    reporter.toolEnded("bash", "p");
    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });

    const expanded = renderEntry(entries[0]!, true);
    assert.ok(expanded.includes("tool_call bash · id p"));
    assert.ok(
      expanded.includes("✓ local/protect-env") && /8ms/.test(expanded),
      "hook row shows its individual duration",
    );
    assert.ok(
      expanded.includes("→ local/protect-env · interrupt requested · block"),
      "native Action row shows type and owner outcome",
    );
    assert.ok(
      expanded.includes("✓ owner/hooks/audit") &&
        expanded.includes("· from local/protect-env block"),
      "synthetic Hook row carries the projected origin",
    );
    assert.ok(
      expanded.includes("→ owner/hooks/audit · message requested · report") &&
        expanded.includes("· from local/protect-env block"),
      "synthetic Action row carries owner outcome and origin",
    );
    // No causal reconstruction glyphs or depth markers.
    assert.ok(!expanded.includes("↳"));
  });

  it("9. standalone Action rows render without synthetic result rows", () => {
    const entries: ExecutionReportEntryData[] = [];
    const reporter = makeReporter(entries);
    const clock = makeClock(1000);

    reporter.toolStarted("read", "w");
    const observation = reporter.begin("tool_result", toolEventContext("read", "w", "tool_result"));
    clock.advance(2);
    reporter.complete(
      observation,
      makeReport([
        // A when-infrastructure failure selected an Action with no main shell row.
        makeActionRow({ actionType: "shutdown", outcome: "cancel" }),
      ]),
    );
    reporter.toolEnded("read", "w");
    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });

    const expanded = renderEntry(entries[0]!, true);
    assert.match(
      expanded,
      /→ local\/act · shutdown requested · cancel/,
    );
    assert.ok(
      !expanded.includes("· result"),
      "no synthetic display-only result row is created",
    );
  });

  it("9. keeps tool segments in Pi event order", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    reporter.toolStarted("bash", "A");
    const callA = reporter.begin("tool_call", toolEventContext("bash", "A"));
    clock.advance(2);
    reporter.complete(callA, makeReport([makeHookRow()]));
    reporter.toolStarted("read", "B");
    const callB = reporter.begin("tool_call", toolEventContext("read", "B"));
    clock.advance(2);
    reporter.complete(callB, makeReport([makeHookRow()]));
    const resultB = reporter.begin("tool_result", toolEventContext("read", "B", "tool_result"));
    clock.advance(2);
    reporter.complete(resultB, makeReport([makeHookRow()]));
    reporter.toolEnded("read", "B");
    const resultA = reporter.begin("tool_result", toolEventContext("bash", "A", "tool_result"));
    clock.advance(2);
    reporter.complete(resultA, makeReport([makeHookRow()]));
    reporter.toolEnded("bash", "A");
    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });

    const expanded = renderEntry(entries[0]!, true);
    const callAIndex = expanded.indexOf("tool_call bash · id A");
    const callBIndex = expanded.indexOf("tool_call read · id B");
    const resultBIndex = expanded.indexOf("tool_result read · id B");
    const resultAIndex = expanded.indexOf("tool_result bash · id A");
    assert.ok(callAIndex >= 0 && callBIndex >= 0 && resultBIndex >= 0 && resultAIndex >= 0);
    assert.ok(
      callAIndex < callBIndex && callBIndex < resultBIndex && resultBIndex < resultAIndex,
      "segments render in begin order",
    );
  });

  it("9. rejects malformed current-type shapes as an unavailable fallback", () => {
    const malformed: unknown[] = [
      { type: "tool-wave", durationMs: -1, tools: [], segments: [] },
      { type: "tool-wave", durationMs: 2, tools: [], segments: [{ eventContext: toolEventContext("read", "x") }] },
      { type: "tool-wave", durationMs: 2, tools: [{ toolName: "r", toolCallId: "x" }], segments: [] },
      {
        type: "tool-wave",
        durationMs: 2,
        tools: [{ toolName: "r", toolCallId: "x" }],
        segments: [{
          eventContext: { event: "turn_end", turnIndex: 1 },
          rows: [makeHookRow()],
        }],
      },
      {
        type: "tool-wave",
        durationMs: 2,
        tools: [{ toolName: "r", toolCallId: "x" }],
        segments: [{
          eventContext: toolEventContext("read", "x"),
          rows: [{
            type: "hook",
            hookRef: "local/guard",
            durationMs: 1,
            passed: true,
            invocationId: "bad-invocation",
          }],
        }],
      },
      {
        type: "tool-wave",
        durationMs: 2,
        tools: [{ toolName: "r", toolCallId: "x" }],
        segments: [{
          eventContext: toolEventContext("read", "x"),
          rows: [{
            ...makeHookRow(),
            origin: {
              hookRef: "local/origin",
              outcome: "pass",
              invocationId: "bad-origin-invocation",
            },
          }],
        }],
      },
      {
        type: "tool-wave",
        durationMs: Number.MAX_SAFE_INTEGER + 100,
        tools: [{ toolName: "r", toolCallId: "x" }],
        segments: [{ eventContext: toolEventContext("read", "x"), rows: [makeHookRow()] }],
      },
      { type: "event", durationMs: 2, segment: [] },
      {
        type: "event",
        durationMs: 2,
        segment: { eventContext: toolEventContext("read", "x"), rows: [makeHookRow()] },
      },
    ];
    for (const bad of malformed) {
      assert.equal(
        renderEntry(bad, true).trim(),
        "HooKit execution summary unavailable",
        JSON.stringify(bad),
      );
    }
  });
});
