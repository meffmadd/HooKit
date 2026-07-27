import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getHookAdapter } from "../pi-assert/adapters.js";
import type { Hook } from "../pi-assert/domain/entry.js";
import type {
  Assert,
  ExtensionContext,
  ShellAssert,
} from "../pi-assert/engine.js";
import {
  dispatchAssertResults,
  executeHookAssertsWithResults,
  type AssertionResultRecord,
} from "../pi-assert/executor.js";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pi-assert-results-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function assertion(
  name: string,
  hook: Hook,
  shell = "true",
  extra: Partial<ShellAssert> = {},
): ShellAssert {
  return {
    name,
    source: "local",
    description: "test",
    hook,
    shell,
    default: false,
    ...extra,
  };
}

const toolEvent = {
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: "echo hi" },
};

function compact(results: readonly AssertionResultRecord[]) {
  return results.map(({ assertionRef, outcome, code }) => ({
    assertionRef,
    outcome,
    code,
  }));
}

describe("canonical assertion results", () => {
  it("records passes and the first fail-fast block in execution order", async () => {
    const execution = await executeHookAssertsWithResults(
      [
        assertion("passes", "tool_call", "true"),
        assertion("blocks", "tool_call", "exit 7"),
        assertion("not-run", "tool_call", "true"),
      ],
      getHookAdapter("tool_call"),
      toolEvent,
      { cwd: root },
    );

    assert.equal(execution.outcome?.action, "block");
    assert.ok(Object.isFrozen(execution));
    assert.ok(Object.isFrozen(execution.outcome));
    assert.ok(Object.isFrozen(execution.results));
    assert.deepStrictEqual(compact(execution.results), [
      { assertionRef: "local/passes", outcome: "pass", code: 0 },
      { assertionRef: "local/blocks", outcome: "block", code: 7 },
    ]);
    assert.ok(execution.results.every(Object.isFrozen));
  });

  it("uses patch, cancel, and report from the originating adapter", async () => {
    const patch = await executeHookAssertsWithResults(
      [assertion("patches", "tool_result", "exit 2")],
      getHookAdapter("tool_result"),
      { ...toolEvent, content: [], isError: false },
      { cwd: root },
    );
    assert.equal(patch.outcome?.action, "patch");
    assert.equal(patch.results[0]?.outcome, "patch");
    assert.equal(patch.results[0]?.code, 2);

    const cancel = await executeHookAssertsWithResults(
      [
        assertion("switch-pass", "session_before_switch", "true"),
        assertion("cancels-a", "session_before_switch", "exit 3"),
        assertion("cancels-b", "session_before_switch", "exit 8"),
      ],
      getHookAdapter("session_before_switch"),
      { reason: "new" },
      { cwd: root },
    );
    assert.equal(cancel.outcome?.action, "cancel");
    assert.deepStrictEqual(
      cancel.results.map(({ outcome, code }) => ({ outcome, code })),
      [
        { outcome: "pass", code: 0 },
        { outcome: "cancel", code: 3 },
        { outcome: "cancel", code: 8 },
      ],
    );

    const report = await executeHookAssertsWithResults(
      [
        assertion("passes", "turn_end", "true"),
        assertion("reports-a", "turn_end", "exit 4"),
        assertion("reports-b", "turn_end", "exit 5"),
      ],
      getHookAdapter("turn_end"),
      { turnIndex: 1 },
      { cwd: root },
    );
    assert.equal(report.outcome?.action, "report");
    assert.deepStrictEqual(
      report.results.map(({ outcome, code }) => ({ outcome, code })),
      [
        { outcome: "pass", code: 0 },
        { outcome: "report", code: 4 },
        { outcome: "report", code: 5 },
      ],
    );
  });

  it("emits no result for filter misses or ordinary when skips", async () => {
    const execution = await executeHookAssertsWithResults(
      [
        assertion("filter-miss", "tool_call", "false", {
          filter: { toolName: "^write$" },
        }),
        assertion("when-skip", "tool_call", "false", { when: "exit 9" }),
        assertion("runs", "tool_call", "true"),
      ],
      getHookAdapter("tool_call"),
      toolEvent,
      { cwd: root },
    );

    assert.equal(execution.outcome, undefined);
    assert.deepStrictEqual(compact(execution.results), [
      { assertionRef: "local/runs", outcome: "pass", code: 0 },
    ]);
  });

  it("emits the adapter action with code null for when execution failures", async () => {
    const execution = await executeHookAssertsWithResults(
      [
        assertion("broken-when", "tool_call", "true", {
          when: String.fromCharCode(0),
        }),
        assertion("not-run", "tool_call", "true"),
      ],
      getHookAdapter("tool_call"),
      toolEvent,
      { cwd: root },
    );

    assert.equal(execution.outcome?.action, "block");
    assert.deepStrictEqual(compact(execution.results), [
      { assertionRef: "local/broken-when", outcome: "block", code: null },
    ]);
  });
});

describe("assert_result dispatch", () => {
  it("dispatches in result-major and configured-handler order", async () => {
    const cwd = join(root, "ordering");
    mkdirSync(cwd, { recursive: true });
    const handlers: Assert[] = [
      assertion(
        "first",
        "assert_result",
        "printf 'first:%s\\n' \"$PI_EVENT_PAYLOAD\" >> order.log",
      ),
      assertion(
        "second",
        "assert_result",
        "printf 'second:%s\\n' \"$PI_EVENT_PAYLOAD\" >> order.log",
      ),
    ];
    const results: AssertionResultRecord[] = [
      Object.freeze({
        event: "assert_result",
        assertionRef: "local/a",
        outcome: "pass",
        code: 0,
      }),
      Object.freeze({
        event: "assert_result",
        assertionRef: "local/b",
        outcome: "block",
        code: 1,
      }),
    ];

    await dispatchAssertResults(handlers, results, { cwd });

    const lines = readFileSync(join(cwd, "order.log"), "utf8").trim().split("\n");
    assert.deepStrictEqual(lines.map((line) => line.split(":", 1)[0]), [
      "first",
      "second",
      "first",
      "second",
    ]);
    assert.match(lines[0]!, /"outcome":"pass","code":0/);
    assert.match(lines[2]!, /"outcome":"block","code":1/);
  });

  it("matches assertionRef by regex, outcome exactly, and code strictly", async () => {
    const cwd = join(root, "filters");
    mkdirSync(cwd, { recursive: true });
    const handlers: Assert[] = [
      assertion("matching", "assert_result", "printf 'match\\n' >> filters.log", {
        filter: {
          assertionRef: "^local/origin$",
          outcome: ["pass", "block"],
          code: [0, 1],
        },
      }),
      // Hand-built entries can bypass config validation; the adapter still
      // treats outcome as exact rather than as a regex.
      assertion("not-a-regex", "assert_result", "printf 'bad\\n' >> filters.log", {
        filter: { outcome: "p.*" },
      }),
      assertion("wrong-code", "assert_result", "printf 'bad\\n' >> filters.log", {
        filter: { code: 2 },
      }),
      assertion("null-code", "assert_result", "printf 'null\\n' >> filters.log", {
        filter: { code: null },
      }),
    ];

    await dispatchAssertResults(
      handlers,
      [
        {
          event: "assert_result",
          assertionRef: "local/origin",
          outcome: "pass",
          code: 0,
        },
        {
          event: "assert_result",
          assertionRef: "local/origin",
          outcome: "block",
          code: 1,
        },
        {
          event: "assert_result",
          assertionRef: "local/origin",
          outcome: "block",
          code: null,
        },
      ],
      { cwd },
    );

    assert.deepStrictEqual(
      readFileSync(join(cwd, "filters.log"), "utf8").trim().split("\n"),
      ["match", "match", "null"],
    );
  });

  it("detaches from an already-aborted originating signal", async () => {
    const cwd = join(root, "detached");
    mkdirSync(cwd, { recursive: true });
    const controller = new AbortController();
    controller.abort();
    const ctx: ExtensionContext = { cwd, signal: controller.signal };
    const origin = await executeHookAssertsWithResults(
      [assertion("origin", "tool_call", "true")],
      getHookAdapter("tool_call"),
      toolEvent,
      ctx,
    );
    assert.equal(origin.results[0]?.outcome, "block");
    assert.equal(origin.results[0]?.code, null);

    await dispatchAssertResults(
      [assertion("logger", "assert_result", "printf 'handled\\n' > detached.log")],
      origin.results,
      ctx,
    );

    assert.equal(readFileSync(join(cwd, "detached.log"), "utf8"), "handled\n");
  });

  it("isolates handler exceptions, failures, and reporting errors", async () => {
    const cwd = join(root, "isolation");
    mkdirSync(cwd, { recursive: true });
    let reports = 0;
    const handlers: Assert[] = [
      assertion("bad-filter", "assert_result", "true", {
        filter: { assertionRef: "[" },
      }),
      assertion("fails", "assert_result", "false"),
      assertion("sibling", "assert_result", "printf 'sibling\\n' >> siblings.log"),
    ];

    await dispatchAssertResults(
      handlers,
      [
        {
          event: "assert_result",
          assertionRef: "local/a",
          outcome: "pass",
          code: 0,
        },
        {
          event: "assert_result",
          assertionRef: "local/b",
          outcome: "report",
          code: 1,
        },
      ],
      { cwd },
      () => {
        reports++;
        throw new Error("reporting failed");
      },
    );

    assert.equal(reports, 4);
    assert.deepStrictEqual(
      readFileSync(join(cwd, "siblings.log"), "utf8").trim().split("\n"),
      ["sibling", "sibling"],
    );
  });

  it("keeps ordinary handler when skips and suppresses recursive results", async () => {
    const cwd = join(root, "recursion");
    mkdirSync(cwd, { recursive: true });
    const skipped = assertion("skipped", "assert_result", "false", { when: "false" });
    const failing = assertion("failing", "assert_result", "false");
    const result: AssertionResultRecord = {
      event: "assert_result",
      assertionRef: "local/origin",
      outcome: "pass",
      code: 0,
    };

    const direct = await executeHookAssertsWithResults(
      [skipped, failing],
      getHookAdapter("assert_result"),
      result,
      { cwd },
    );
    assert.equal(direct.outcome?.action, "report");
    assert.equal(direct.outcome?.failures.length, 1);
    assert.deepStrictEqual(direct.results, []);

    let reports = 0;
    await dispatchAssertResults([skipped, failing], [result], { cwd }, () => {
      reports++;
    });
    assert.equal(reports, 1);
  });
});
