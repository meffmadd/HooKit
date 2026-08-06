/**
 * Tests for durable Execution Reports for Execution Waves built by
 * `ExecutionReporter` and rendered by `renderExecutionEntry`
 * (`pi-assert/ui/execution-report.ts`).
 *
 * The contract under test is externally visible report construction, append
 * ordering, timing, and rendering — not private accumulator fields. Timing
 * uses an injected deterministic monotonic clock.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent";

import {
  ExecutionReporter,
  renderExecutionEntry,
  type ExecutionReportEntryData,
  type ExecutionTrigger,
} from "../pi-assert/ui/execution-report.js";
import type {
  ActionRequestExecution,
  AssertionExecution,
  AssertionExecutionReport,
  OriginatingAssertionResult,
} from "../pi-assert/hook-evaluation/index.js";

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

function toolTrigger(
  toolName: string,
  toolCallId: string,
  event: "tool_call" | "tool_result" = "tool_call",
): ExecutionTrigger {
  return { event, toolName, toolCallId };
}

function makeOrigin(
  assertionRef = "parent-ref",
  runId = "parent-run",
  outcome: OriginatingAssertionResult["outcome"] = "block",
): OriginatingAssertionResult {
  return { assertionRef, runId, outcome };
}

function makeExecution(
  partial: Partial<AssertionExecution> = {},
): AssertionExecution {
  return {
    assertionRef: "assert-something",
    runId: "run-abc",
    hook: "tool_call",
    durationMs: 12.4,
    passed: true,
    ...partial,
  };
}

function makeAction(
  partial: Partial<ActionRequestExecution> = {},
): ActionRequestExecution {
  return {
    assertionRef: "assert-something",
    runId: "run-abc",
    hook: "tool_call",
    actionType: "message",
    outcome: "patch",
    ...partial,
  };
}

function makeReport(
  executions: readonly AssertionExecution[] = [],
  actionRequests: readonly ActionRequestExecution[] = [],
): AssertionExecutionReport {
  return { executions, actionRequests };
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
      customType: "pi-assert-execution",
      data,
    },
    { expanded },
    renderTheme,
  );
  assert.ok(component, "entry renderer returned no component");
  return component.render(width).map((line) => line.trimEnd()).join("\n");
}

describe("ExecutionReporter wave collection", () => {
  it("builds one report for a lone segment and flushes it at the first different hook", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    const observation = reporter.begin(
      "tool_call",
      toolTrigger("read", "call-1"),
    );
    clock.advance(5);
    reporter.complete(
      observation,
      makeReport([makeExecution({ durationMs: 2 })], []),
    );
    // Still pending: no report until a boundary hook begins.
    assert.equal(entries.length, 0);

    const boundary = reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.hook, "tool_call");
    assert.equal(entry.criticalPathMs, 5);
    assert.equal(entry.segments.length, 1);
    assert.deepEqual(entry.segments[0]!.trigger, {
      event: "tool_call",
      toolName: "read",
      toolCallId: "call-1",
    });
    assert.equal(entry.segments[0]!.executions.length, 1);

    reporter.complete(boundary, makeReport());
  });

  it("merges many same-hook segments into one report through the same pipeline", () => {
    const entries: ExecutionReportEntryData[] = [];
    const reporter = makeReporter(entries);

    for (const id of ["call-1", "call-2", "call-3"]) {
      const observation = reporter.begin(
        "tool_call",
        toolTrigger("bash", id),
      );
      reporter.complete(
        observation,
        makeReport([makeExecution({ assertionRef: id })], []),
      );
    }
    assert.equal(entries.length, 0);

    reporter.begin("tool_result", toolTrigger("bash", "call-3", "tool_result"));
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.hook, "tool_call");
    assert.equal(entry.segments.length, 3);
    assert.deepEqual(
      entry.segments.map((segment) => segment.trigger.toolCallId),
      ["call-1", "call-2", "call-3"],
    );
  });

  it("keeps collecting across the same tool hook and flushes at a non-tool boundary", () => {
    const entries: ExecutionReportEntryData[] = [];
    const reporter = makeReporter(entries);

    const one = reporter.begin("tool_result", toolTrigger("read", "r1", "tool_result"));
    reporter.complete(one, makeReport([makeExecution()]));
    const two = reporter.begin("tool_result", toolTrigger("read", "r2", "tool_result"));
    reporter.complete(two, makeReport([makeExecution()]));
    reporter.begin("agent_end", { event: "agent_end" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.hook, "tool_result");
  });

  it("assigns segment order at begin so overlapping completions cannot reorder", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    const first = reporter.begin("tool_call", toolTrigger("read", "call-1"));
    const second = reporter.begin("tool_call", toolTrigger("read", "call-2"));
    // The second observation completes first.
    clock.advance(3);
    reporter.complete(
      second,
      makeReport([makeExecution({ assertionRef: "second-exec" })], []),
    );
    clock.advance(4);
    reporter.complete(
      first,
      makeReport([makeExecution({ assertionRef: "first-exec" })], []),
    );
    reporter.begin("agent_settled", { event: "agent_settled" });

    const entry = entries[0]!;
    assert.deepEqual(
      entry.segments.map((segment) => segment.trigger.toolCallId),
      ["call-1", "call-2"],
    );
    assert.equal(entry.segments[0]!.executions[0]!.assertionRef, "first-exec");
    assert.equal(entry.segments[1]!.executions[0]!.assertionRef, "second-exec");
  });

  it("appends ordinary hooks immediately as a one-segment report", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(500);
    const reporter = makeReporter(entries, clock);

    const observation = reporter.begin("turn_end", { event: "turn_end", turnIndex: 2 });
    clock.advance(12);
    reporter.complete(
      observation,
      makeReport([makeExecution({ durationMs: 3 })], []),
    );
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.hook, "turn_end");
    assert.equal(entry.criticalPathMs, 12);
    assert.equal(entry.segments.length, 1);
    assert.deepEqual(entry.segments[0]!.trigger, {
      event: "turn_end",
      turnIndex: 2,
    });
  });

  it("appends nothing for an entirely empty wave", () => {
    const entries: ExecutionReportEntryData[] = [];
    const reporter = makeReporter(entries);

    const one = reporter.begin("tool_call", toolTrigger("read", "c1"));
    reporter.complete(one);
    const two = reporter.begin("tool_call", toolTrigger("read", "c2"));
    reporter.complete(two);
    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });
    assert.equal(entries.length, 0);
  });
});

describe("ExecutionReporter critical-path timing", () => {
  it("uses the union of serial tool_call intervals, excluding framework gaps", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    const first = reporter.begin("tool_call", toolTrigger("bash", "c1"));
    clock.advance(10);
    reporter.complete(first, makeReport([makeExecution()]));

    clock.advance(50); // framework gap between preflights
    const second = reporter.begin("tool_call", toolTrigger("bash", "c2"));
    assert.equal(second.startMs, 1060);
    clock.advance(20);
    reporter.complete(second, makeReport([makeExecution()]));

    reporter.begin("tool_result", toolTrigger("bash", "c2"));
    assert.equal(entries[0]!.criticalPathMs, 30);
  });

  it("measures the tool_result critical tail as max(end) - max(start)", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(2000);
    const reporter = makeReporter(entries, clock);

    const first = reporter.begin("tool_result", toolTrigger("read", "r1", "tool_result"));
    clock.advance(5);
    reporter.complete(first, makeReport([makeExecution()]));

    // The final/underlying result enters processing later.
    const second = reporter.begin("tool_result", toolTrigger("read", "r2", "tool_result"));
    assert.equal(second.startMs, 2005);
    clock.advance(3);
    reporter.complete(second, makeReport([makeExecution()]));

    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });
    const entry = entries[0]!;
    assert.equal(entry.hook, "tool_result");
    assert.equal(entry.criticalPathMs, 3); // maxEnd(2008) - maxStart(2005)
  });

  it("computes the tail across segments when the slowest end and latest start differ", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(2000);
    const reporter = makeReporter(entries, clock);

    const early = reporter.begin("tool_result", toolTrigger("read", "early", "tool_result"));
    clock.advance(5);
    const late = reporter.begin("tool_result", toolTrigger("read", "late", "tool_result"));
    clock.advance(3);
    reporter.complete(late, makeReport([makeExecution()]));
    clock.advance(2);
    reporter.complete(early, makeReport([makeExecution()]));

    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });
    // early: [2000, 2010], late: [2005, 2008] -> 2010 - 2005 = 5
    assert.equal(entries[0]!.criticalPathMs, 5);
  });

  it("includes empty tool segments in timing and command totals", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(3000);
    const reporter = makeReporter(entries, clock);

    const empty = reporter.begin("tool_call", toolTrigger("read", "empty"));
    clock.advance(7);
    reporter.complete(empty);

    const busy = reporter.begin("tool_call", toolTrigger("bash", "busy"));
    clock.advance(3);
    reporter.complete(busy, makeReport([makeExecution()]));

    reporter.begin("tool_result", toolTrigger("bash", "busy", "tool_result"));
    const entry = entries[0]!;
    assert.equal(entry.criticalPathMs, 10); // both intervals, no gap
    assert.equal(entry.segments.length, 2);
  });

  it("clamps non-finite and oversized critical-path intervals", () => {
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

      const observation = reporter.begin(
        "tool_call",
        toolTrigger("read", "bounded"),
      );
      current = endMs;
      reporter.complete(observation, makeReport([makeExecution()]));
      reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });

      assert.equal(entries[0]!.criticalPathMs, expected);
    }
  });
});

describe("ExecutionReporter snapshots", () => {
  it("returns immutable bounded snapshots without retained source references", () => {
    const entries: ExecutionReportEntryData[] = [];
    const reporter = makeReporter(entries);
    const origin = makeOrigin();
    const execution = makeExecution({ originatingResult: origin });
    const action = makeAction({
      originatingResult: makeOrigin("other", "other-run"),
    });

    const observation = reporter.begin(
      "tool_call",
      toolTrigger("read\u0000  \u0001tool", "call-\u0007id"),
    );
    reporter.complete(observation, makeReport([execution], [action]));
    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });

    const entry = entries[0]!;
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.segments));
    const segment = entry.segments[0]!;
    assert.ok(Object.isFrozen(segment));
    assert.ok(Object.isFrozen(segment.trigger));
    assert.ok(Object.isFrozen(segment.executions));
    assert.ok(Object.isFrozen(segment.executions[0]));
    assert.ok(Object.isFrozen(segment.executions[0].originatingResult));
    assert.ok(Object.isFrozen(segment.actionRequests));
    assert.ok(Object.isFrozen(segment.actionRequests[0]));
    assert.ok(Object.isFrozen(segment.actionRequests[0].originatingResult));

    // Sanitization from the source report.
    assert.equal((segment.trigger as { toolName: string }).toolName, "read tool");
    assert.equal((segment.trigger as { toolCallId: string }).toolCallId, "call- id");

    // Copies, not retained references.
    assert.notStrictEqual(segment.executions[0], execution);
    assert.notStrictEqual(segment.executions[0].originatingResult, origin);
    assert.notStrictEqual(segment.actionRequests[0].originatingResult, execution.originatingResult);

    execution.durationMs = 999;
    execution.assertionRef = "mutated";
    execution.runId = "mutated-run";
    origin.runId = "mutated-origin";
    action.outcome = "cancel";
    action.runId = "mutated-action";

    assert.equal(segment.executions[0].durationMs, 12);
    assert.equal(segment.executions[0].assertionRef, "assert-something");
    assert.equal(segment.executions[0].originatingResult?.runId, "parent-run");
    assert.equal(segment.actionRequests[0].outcome, "patch");
    assert.equal(segment.actionRequests[0].runId, "run-abc");
  });

  it("drops writer input whose trigger does not match its hook", () => {
    const entries: ExecutionReportEntryData[] = [];
    const reporter = makeReporter(entries);

    const observation = reporter.begin(
      "tool_call",
      { event: "turn_end", turnIndex: 1 },
    );
    reporter.complete(observation, makeReport([makeExecution()]));
    reporter.begin("tool_result", toolTrigger("read", "c1", "tool_result"));

    assert.deepEqual(entries, []);
  });

  it("round-trips through an unversioned hook/criticalPathMs/segments shape", () => {
    const entries: ExecutionReportEntryData[] = [];
    const reporter = makeReporter(entries);

    const observation = reporter.begin("tool_call", toolTrigger("bash", "c1"));
    reporter.complete(observation, makeReport([makeExecution()]));
    reporter.begin("tool_result", toolTrigger("bash", "c1", "tool_result"));

    const entry = entries[0]!;
    assert.deepEqual(Object.keys(entry).sort(), [
      "criticalPathMs",
      "hook",
      "segments",
    ]);
    assert.equal(entry.hook, "tool_call");
    assert.equal(typeof entry.criticalPathMs, "number");
    assert.ok(Array.isArray(entry.segments));
    const segment = entry.segments[0]!;
    assert.deepEqual(Object.keys(segment).sort(), [
      "actionRequests",
      "executions",
      "trigger",
    ]);
    // Every segment trigger must equal the top-level hook.
    for (const pending of entry.segments) {
      assert.equal(pending.trigger.event, entry.hook);
    }
  });
});

describe("ExecutionReporter shutdown and failure", () => {
  it("flushes completed observations and discards open ones on shutdown", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    const done = reporter.begin("tool_call", toolTrigger("read", "c1"));
    clock.advance(3);
    reporter.complete(done, makeReport([makeExecution()]));
    const open = reporter.begin("tool_call", toolTrigger("read", "c2"));
    clock.advance(10);
    // Never completed.
    void open;

    reporter.flush();
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.segments.length, 1);
    assert.equal(entry.segments[0]!.trigger.toolCallId, "c1");
    assert.equal(entry.criticalPathMs, 3);

    // Idempotent; the open observation is never invented into a partial row.
    reporter.flush();
    assert.equal(entries.length, 1);
  });

  it("drops a failed append without retrying, merging, or poisoning later waves", () => {
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

    const call = reporter.begin("tool_call", toolTrigger("read", "c1"));
    clock.advance(2);
    reporter.complete(call, makeReport([makeExecution()]));
    const boundary = reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });
    assert.equal(entries.length, 0, "dropped report is not appended");
    assert.equal(failures, 1);

    clock.advance(2);
    reporter.complete(
      boundary,
      makeReport([makeExecution({ assertionRef: "later" })], []),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.hook, "turn_end");
    assert.equal(entries[0]!.segments[0]!.executions[0]!.assertionRef, "later");
    assert.equal(entries.length, 1, "the failed wave is never merged or retried");
  });
});

describe("ExecutionReport rendering", () => {
  it("shows command count, critical-path delay, actions, and a per-tool breakdown", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    for (const [index, id] of ["c1", "c2", "c3"].entries()) {
      const observation = reporter.begin(
        "tool_call",
        toolTrigger(index % 2 === 0 ? "bash" : "read", id),
      );
      clock.advance(8);
      reporter.complete(
        observation,
        makeReport(
          [makeExecution({ assertionRef: `exec-${id}` })],
          index === 2
            ? [makeAction({ assertionRef: "steer", actionType: "message" })]
            : [],
        ),
      );
    }
    reporter.begin("turn_end", { event: "turn_end", turnIndex: 1 });

    const entry = entries[0]!;
    const collapsed = renderEntry(entry, false);
    assert.match(collapsed, /pi-assert ran 3 commands in 24ms and requested 1 action · tool_call bash ×2, read ×1/);
    assert.match(collapsed, /\(ctrl\+o to expand\)/);

    const expanded = renderEntry(entry, true);
    assert.ok(!expanded.includes("to expand"));
    assert.match(expanded, /tool_call bash · id c1/);
    assert.match(expanded, /tool_call read · id c2/);
    assert.match(expanded, /tool_call bash · id c3/);
    assert.match(expanded, /✓ exec-c1/);
    assert.match(expanded, /→ steer · message requested/);
  });

  it("renders action-only reports and keeps empty segments out of the expanded view", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(1000);
    const reporter = makeReporter(entries, clock);

    const empty = reporter.begin("tool_call", toolTrigger("read", "empty"));
    clock.advance(2);
    reporter.complete(empty);

    const busy = reporter.begin("tool_call", toolTrigger("bash", "busy"));
    clock.advance(2);
    reporter.complete(
      busy,
      makeReport([], [makeAction({ assertionRef: "notify-only" })]),
    );
    reporter.begin("tool_result", toolTrigger("bash", "busy", "tool_result"));

    const entry = entries[0]!;
    const collapsed = renderEntry(entry, false);
    assert.match(collapsed, /pi-assert requested 1 action in 4ms · tool_call read ×1, bash ×1/);

    const expanded = renderEntry(entry, true);
    assert.ok(!expanded.includes("empty"), "empty segment header omitted");
    assert.match(expanded, /tool_call bash · id busy/);
    assert.match(expanded, /→ notify-only · message requested/);
  });

  it("keeps the per-tool breakdown in first-seen tool order for mixed tools", () => {
    const entries: ExecutionReportEntryData[] = [];
    const reporter = makeReporter(entries);

    for (const [name, id] of [
      ["bash", "c1"],
      ["read", "c2"],
      ["bash", "c3"],
      ["read", "c4"],
      ["read", "c5"],
    ] as const) {
      const observation = reporter.begin("tool_call", toolTrigger(name, id));
      reporter.complete(
        observation,
        name === "bash" ? makeReport([makeExecution()]) : undefined,
      );
    }
    reporter.begin("tool_result", toolTrigger("read", "c5", "tool_result"));

    assert.match(
      renderEntry(entries[0]!, false),
      /· tool_call bash ×2, read ×3/,
    );
  });

  it("renders an ordinary hook report using the common single-report layout", () => {
    const entries: ExecutionReportEntryData[] = [];
    const clock = makeClock(500);
    const reporter = makeReporter(entries, clock);

    const observation = reporter.begin("turn_end", { event: "turn_end", turnIndex: 3 });
    clock.advance(9);
    reporter.complete(
      observation,
      makeReport([
        makeExecution({ assertionRef: "turn-pass", durationMs: 2, passed: true }),
        makeExecution({ assertionRef: "turn-fail", durationMs: 4, passed: false }),
      ], []),
    );

    const entry = entries[0]!;
    assert.match(
      renderEntry(entry, false),
      /pi-assert ran 2 commands in 9ms · turn_end 3/,
    );
    const expanded = renderEntry(entry, true);
    assert.match(expanded, /✓ turn-pass\s+\d+ms/);
    assert.match(expanded, /✗ turn-fail\s+\d+ms/);
    assert.ok(!expanded.includes("to expand"));
  });

  it("renders malformed and historical payloads as an unavailable fallback", () => {
    // Historical pre-Wave versioned payload.
    assert.equal(
      renderEntry({
        version: 3,
        trigger: { event: "tool_call", toolName: "bash", toolCallId: "old" },
        executions: [
          {
            assertionRef: "local/old",
            runId: "old-run",
            hook: "tool_call",
            durationMs: 3,
            passed: true,
          },
        ],
        actionRequests: [],
      }, true).trim(),
      "pi-assert execution summary unavailable",
    );

    // Malformed: negative critical path, empty segments, unknown hook, trigger mismatch.
    for (const malformed of [
      { hook: "tool_call", criticalPathMs: -1, segments: [{ event: "x" }] },
      { hook: "tool_call", criticalPathMs: 2, segments: [] },
      { hook: "not-a-hook", criticalPathMs: 2, segments: [{ event: "x" }] },
      {
        hook: "tool_call",
        criticalPathMs: 2,
        segments: [{
          trigger: { event: "turn_end", turnIndex: 1 },
          executions: [makeExecution()],
          actionRequests: [],
        }],
      },
      {
        hook: "tool_call",
        criticalPathMs: Number.MAX_SAFE_INTEGER,
        segments: [{
          trigger: toolTrigger("read", "oversized"),
          executions: [makeExecution()],
          actionRequests: [],
        }],
      },
    ]) {
      assert.equal(
        renderEntry(malformed, true).trim(),
        "pi-assert execution summary unavailable",
      );
    }

    // Malformed: a non-tool report must contain exactly one segment.
    assert.equal(
      renderEntry({
        hook: "turn_end",
        criticalPathMs: 2,
        segments: [
          {
            trigger: { event: "turn_end", turnIndex: 1 },
            executions: [makeExecution({ hook: "tool_call" })],
            actionRequests: [],
          },
          {
            trigger: { event: "turn_end", turnIndex: 1 },
            executions: [makeExecution({ hook: "tool_call" })],
            actionRequests: [],
          },
        ],
      }, true).trim(),
      "pi-assert execution summary unavailable",
    );
  });
});
