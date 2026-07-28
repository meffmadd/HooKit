import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HOOK_ADAPTERS,
  getHookAdapter,
  hookAdapterRegistry,
} from "../pi-assert/adapters.js";
import { LIFECYCLE_HOOKS, type Hook } from "../pi-assert/domain/entry.js";
import type { Assert, ExtensionContext } from "../pi-assert/engine.js";
import {
  executeHookAsserts,
  executeSessionBeforeForkAsserts,
  executeSessionBeforeSwitchAsserts,
} from "../pi-assert/executor.js";

const ctx: ExtensionContext = { cwd: "/workspace" };

function lifecycleAssert(
  name: string,
  hook: Hook,
  shell = "false",
  filter?: Record<string, string | number>,
): Assert {
  return {
    name,
    source: "local",
    description: "test",
    hook,
    shell,
    filter,
    default: false,
  };
}

describe("hook adapter registry", () => {
  it("has one adapter for every accepted hook and no shutdown adapter", () => {
    assert.deepStrictEqual(Object.keys(HOOK_ADAPTERS), [...LIFECYCLE_HOOKS]);
    assert.strictEqual(hookAdapterRegistry.size, LIFECYCLE_HOOKS.length);
    assert.strictEqual(hookAdapterRegistry.has("session_shutdown" as Hook), false);
  });

  it("declares Pi result, aggregation, and feedback semantics", () => {
    assert.deepStrictEqual(
      Object.fromEntries(Object.entries(HOOK_ADAPTERS).map(([hook, adapter]) => [
        hook,
        [adapter.failureAction, adapter.aggregation, adapter.feedback],
      ])),
      {
        tool_call: ["block", "first", "notify-error"],
        tool_result: ["patch", "first", "notify-error"],
        turn_end: ["report", "all", "notify-error"],
        agent_end: ["report", "all", "corrective-turn"],
        agent_settled: ["report", "all", "notify-error"],
        session_before_switch: ["cancel", "all", "notify-error"],
        session_before_fork: ["cancel", "all", "notify-error"],
        assert_result: ["report", "all", "notify-error"],
      },
    );
  });

  it("projects bounded lifecycle candidates and JSON event environments", () => {
    const turn = getHookAdapter("turn_end");
    const turnEvent = { turnIndex: 4 };
    assert.deepStrictEqual(turn.candidate(turnEvent), {
      event: "turn_end",
      turnIndex: 4,
    });
    assert.deepStrictEqual(turn.buildEnv(turnEvent, ctx), {
      PI_EVENT: "turn_end",
      PI_EVENT_PAYLOAD: '{"event":"turn_end","turnIndex":4}',
      PI_CWD: "/workspace",
    });

    const switching = getHookAdapter("session_before_switch");
    const switchEvent = { reason: "resume" as const, targetSessionFile: "/tmp/s.jsonl" };
    assert.deepStrictEqual(switching.candidate(switchEvent), {
      event: "session_before_switch",
      reason: "resume",
      targetSessionFile: "/tmp/s.jsonl",
    });
    assert.equal(
      switching.buildEnv(switchEvent, ctx).PI_EVENT_PAYLOAD,
      '{"event":"session_before_switch","reason":"resume","targetSessionFile":"/tmp/s.jsonl"}',
    );

    const forking = getHookAdapter("session_before_fork");
    assert.deepStrictEqual(forking.candidate({ entryId: "abc", position: "at" }), {
      event: "session_before_fork",
      entryId: "abc",
      position: "at",
    });
    assert.deepStrictEqual(getHookAdapter("agent_settled").candidate({}), {
      event: "agent_settled",
    });

    const result = {
      event: "assert_result" as const,
      assertionRef: "local/no-rm-rf",
      runId: "00000000-0000-4000-8000-000000000020",
      outcome: "block" as const,
      code: 1,
    };
    assert.deepStrictEqual(getHookAdapter("assert_result").candidate(result), result);
    assert.deepStrictEqual(getHookAdapter("assert_result").buildEnv(result, ctx), {
      PI_EVENT: "assert_result",
      PI_EVENT_PAYLOAD:
        '{"event":"assert_result","assertionRef":"local/no-rm-rf","runId":"00000000-0000-4000-8000-000000000020","outcome":"block","code":1}',
      PI_CWD: "/workspace",
    });
  });
});

describe("adapter execution policies", () => {
  it("turn_end collects every failure and reports without a Pi control result", async () => {
    const outcome = await executeHookAsserts(
      [
        lifecycleAssert("first", "turn_end", "false", { turnIndex: 2 }),
        lifecycleAssert("second", "turn_end"),
      ],
      getHookAdapter("turn_end"),
      { turnIndex: 2 },
      ctx,
    );

    assert.equal(outcome?.action, "report");
    assert.equal(outcome?.failures.length, 2);
    assert.match(outcome?.feedbackMessage ?? "", /2 turn_end assertions failed/);
  });

  it("agent_end aggregates corrective feedback with a retry fingerprint", async () => {
    const outcome = await executeHookAsserts(
      [
        lifecycleAssert("one", "agent_end"),
        lifecycleAssert("two", "agent_end"),
      ],
      getHookAdapter("agent_end"),
      {},
      ctx,
    );

    assert.equal(outcome?.action, "report");
    assert.equal(outcome?.messages.length, 2);
    assert.equal(getHookAdapter("agent_end").feedback, "corrective-turn");
    if (outcome?.action === "report") {
      assert.equal(outcome.fingerprint, outcome.messages.join("\n"));
      assert.match(outcome.repeatedFeedbackMessage ?? "", /automatic retry stopped/);
    }
  });

  it("agent_settled is aggregate report-only feedback", async () => {
    const outcome = await executeHookAsserts(
      [
        lifecycleAssert("one", "agent_settled"),
        lifecycleAssert("two", "agent_settled"),
      ],
      getHookAdapter("agent_settled"),
      {},
      ctx,
    );

    assert.equal(outcome?.action, "report");
    assert.equal(outcome?.messages.length, 2);
    assert.equal(getHookAdapter("agent_settled").feedback, "notify-error");
    assert.equal(outcome?.action === "report" && outcome.fingerprint, undefined);
  });

  it("session switch collects failures and returns one cancellation", async () => {
    const outcome = await executeSessionBeforeSwitchAsserts(
      [
        lifecycleAssert("new-only", "session_before_switch", "false", { reason: "new" }),
        lifecycleAssert("always", "session_before_switch"),
      ],
      { reason: "new" },
      ctx,
    );

    assert.equal(outcome?.action, "cancel");
    assert.equal(outcome?.failures.length, 2);
    assert.match(outcome?.reason ?? "", /session switch cancelled by 2 assertions/);
  });

  it("session fork collects failures and returns one cancellation", async () => {
    const outcome = await executeSessionBeforeForkAsserts(
      [
        lifecycleAssert("clone-only", "session_before_fork", "false", { position: "at" }),
        lifecycleAssert("always", "session_before_fork"),
      ],
      { entryId: "entry-1", position: "at" },
      ctx,
    );

    assert.equal(outcome?.action, "cancel");
    assert.equal(outcome?.failures.length, 2);
    assert.match(outcome?.reason ?? "", /session fork cancelled by 2 assertions/);
  });

  it("report-only turn hooks skip an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await executeHookAsserts(
      [lifecycleAssert("would-fail", "turn_end")],
      getHookAdapter("turn_end"),
      { turnIndex: 0 },
      { cwd: "/workspace", signal: controller.signal },
    );
    assert.equal(outcome, undefined);
  });
});
