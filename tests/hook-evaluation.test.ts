import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Hook, NativeHook } from "../pi-assert/domain/entry.js";
import type {
  ActiveAssertion,
} from "../pi-assert/hook-evaluation/index.js";
import {
  HookEvaluation,
  createActiveAssertionSet,
  type HookEventMap,
  type HookExecutionContext,
  type HookEvaluationResult,
} from "../pi-assert/hook-evaluation/index.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pi-assert-hook-evaluation-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function caseDirectory(name: string): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function assertion(
  name: string,
  hook: Hook,
  shell = "true",
  extra: Partial<ActiveAssertion> = {},
): ActiveAssertion {
  return {
    name,
    source: "local",
    description: "test assertion",
    hook,
    shell,
    ...extra,
  };
}

function assertionWithAction(
  name: string,
  hook: Hook,
  action: Omit<NonNullable<ActiveAssertion["action"]>, "outcome"> & {
    outcome?: NonNullable<ActiveAssertion["action"]>["outcome"];
  },
  extra: Partial<ActiveAssertion> = {},
): ActiveAssertion {
  return {
    name,
    source: "local",
    description: "test Assertion with Action",
    hook,
    shell: "true",
    action: { outcome: "pass", ...action } as NonNullable<ActiveAssertion["action"]>,
    ...extra,
  };
}

function context(
  cwd: string,
  extra: Partial<HookExecutionContext> = {},
): HookExecutionContext {
  return {
    cwd,
    metadata: {},
    ...extra,
  };
}

const toolCall = {
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: "echo hi" },
};

const toolResult = {
  ...toolCall,
  content: [{ type: "text" as const, text: "hello" }],
  isError: false,
};

async function evaluate<H extends NativeHook>(
  evaluator: HookEvaluation,
  hook: H,
  event: HookEventMap[H],
  assertions: readonly ActiveAssertion[],
  cwd = root,
  executionContext: HookExecutionContext = context(cwd),
): Promise<HookEvaluationResult> {
  return evaluator.evaluate(
    hook,
    event,
    executionContext,
    createActiveAssertionSet(assertions),
  );
}

function presentationMessages(result: HookEvaluationResult): string[] {
  return result.effects.flatMap((effect) =>
    effect.type === "present" ? [effect.message] : []
  );
}

describe("Hook Evaluation native outcomes", () => {
  it("aggregates a block while continuing matching tool-call Assertions", async () => {
    const cwd = caseDirectory("tool-call-block");
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("passes", "tool_call", "true"),
        assertion("blocks", "tool_call", "exit 7"),
        assertion("not-run", "tool_call", "touch not-run"),
      ],
      cwd,
    );

    assert.equal(result.outcome, "block");
    if (result.outcome === "block") {
      assert.equal(
        result.reason,
        'pi-assert: assertion "blocks" rejected bash — `exit 7`',
      );
    }
    assert.equal(existsSync(join(cwd, "not-run")), true);
    assert.deepEqual(
      result.executionReport?.executions.map(({ assertionRef, passed }) => ({
        assertionRef,
        passed,
      })),
      [
        { assertionRef: "local/passes", passed: true },
        { assertionRef: "local/blocks", passed: false },
        { assertionRef: "local/not-run", passed: true },
      ],
    );
  });

  it("includes every tool failure in one block or replacement patch", async () => {
    const call = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("first", "tool_call", "false"),
        assertion("second", "tool_call", "exit 7"),
      ],
    );
    assert.equal(call.outcome, "block");
    if (call.outcome === "block") {
      assert.match(call.reason, /2 assertions rejected bash/);
      assert.match(call.reason, /assertion "first"/);
      assert.match(call.reason, /assertion "second"/);
    }

    const toolOutput = await evaluate(
      new HookEvaluation(),
      "tool_result",
      toolResult,
      [
        assertion("first", "tool_result", "false"),
        assertion("second", "tool_result", "exit 9"),
      ],
    );
    assert.equal(toolOutput.outcome, "patch");
    if (toolOutput.outcome === "patch") {
      const text = toolOutput.patch.content?.[0];
      assert.ok(text?.type === "text");
      assert.match(text.text, /assertion "first"/);
      assert.match(text.text, /assertion "second"/);
    }
  });

  it("passes when filters miss or matching shells pass", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("write-only", "tool_call", "false", {
          filter: { toolName: "^write$" },
        }),
        assertion("nested", "tool_call", "true", {
          filter: { "request.target.path": "(^|/)\\.env$" },
        }),
        assertion("passes", "tool_call", "true", {
          filter: { toolName: "ash$" },
        }),
      ],
    );
    assert.equal(result.outcome, "pass");
  });

  it("matches nested regex fields and strict scalar filters", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      {
        toolName: "vendor_write",
        toolCallId: "nested",
        input: {
          request: { target: { path: "/app/.env" } },
          retries: 2,
          dryRun: false,
        },
      },
      [assertion("nested", "tool_call", "false", {
        filter: {
          toolName: "_write$",
          "request.target.path": "(^|/)\\.env$",
          retries: 2,
          dryRun: false,
        },
      })],
    );
    assert.equal(result.outcome, "block");
  });

  it("uses the native tool name over a shadowing input field", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      {
        toolName: "bash",
        toolCallId: "shadow",
        input: { toolName: "write" },
      },
      [assertion("bash", "tool_call", "false", {
        filter: { toolName: "^bash$" },
      })],
    );
    assert.equal(result.outcome, "block");
  });

  it("suppresses a completed tool result with an immutable patch", async () => {
    const details = { duration: 12 };
    const result = await evaluate(
      new HookEvaluation(),
      "tool_result",
      { ...toolResult, details },
      [assertion("redact", "tool_result", "false")],
    );

    assert.equal(result.outcome, "patch");
    if (result.outcome === "patch") {
      assert.equal(result.patch.isError, true);
      assert.strictEqual(result.patch.details, details);
      assert.match(
        result.patch.content?.[0]?.type === "text"
          ? result.patch.content[0].text
          : "",
        /original tool result was suppressed/,
      );
      assert.ok(Object.isFrozen(result.patch));
      assert.ok(Object.isFrozen(result.patch.content));
    }
  });

  it("aggregates turn_end failures into one report effect", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 4 },
      [
        assertion("one", "turn_end", "false", { filter: { turnIndex: 4 } }),
        assertion("two", "turn_end", "exit 2"),
      ],
    );
    assert.equal(result.outcome, "report");
    assert.equal(result.effects.length, 1);
    assert.equal(result.effects[0]?.type, "present");
    assert.match(presentationMessages(result)[0] ?? "", /2 turn_end assertions failed/);
    assert.match(presentationMessages(result)[0] ?? "", /\*\*one\*\*/);
    assert.match(presentationMessages(result)[0] ?? "", /\*\*two\*\*/);
    assert.deepEqual(
      result.executionReport?.executions.map((execution) => execution.assertionRef),
      ["local/one", "local/two"],
    );
  });

  it("reports all agent_settled failures", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "agent_settled",
      {},
      [
        assertion("one", "agent_settled", "false"),
        assertion("two", "agent_settled", "false"),
      ],
    );
    assert.equal(result.outcome, "report");
    assert.match(presentationMessages(result)[0] ?? "", /2 agent_settled/);
  });

  it("cancels session switches and forks after aggregating failures", async () => {
    const evaluator = new HookEvaluation();
    const switching = await evaluate(
      evaluator,
      "session_before_switch",
      { reason: "new" },
      [
        assertion("new-only", "session_before_switch", "false", {
          filter: { reason: "^new$" },
        }),
        assertion("always", "session_before_switch", "false"),
      ],
    );
    assert.equal(switching.outcome, "cancel");
    if (switching.outcome === "cancel") {
      assert.match(switching.reason, /session switch cancelled by 2 assertions/);
    }

    const forking = await evaluate(
      evaluator,
      "session_before_fork",
      { entryId: "entry-1", position: "at" },
      [
        assertion("clone-only", "session_before_fork", "false", {
          filter: { position: "^at$" },
        }),
        assertion("always", "session_before_fork", "false"),
      ],
    );
    assert.equal(forking.outcome, "cancel");
    if (forking.outcome === "cancel") {
      assert.match(forking.reason, /session fork cancelled by 2 assertions/);
    }
  });

  it("returns an immutable report containing only actual shell executions", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [assertion("pass", "tool_call", "true", { source: "owner/rules" })],
    );
    assert.deepEqual(Object.keys(result).sort(), [
      "effects",
      "executionReport",
      "outcome",
    ]);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.effects));
    assert.ok(Object.isFrozen(result.executionReport));
    assert.ok(Object.isFrozen(result.executionReport?.executions));
    assert.equal(result.executionReport?.executions.length, 1);
    const execution = result.executionReport?.executions[0];
    assert.equal(execution?.assertionRef, "owner/rules/pass");
    assert.equal(execution?.hook, "tool_call");
    assert.equal(execution?.passed, true);
    assert.ok((execution?.durationMs ?? -1) >= 0);
    assert.ok(Object.isFrozen(execution));
  });
});

describe("Assertion Invocation semantics", () => {
  it("runs filter then when then shell with one shared environment", async () => {
    const cwd = caseDirectory("when-shell-environment");
    const print =
      "printf '%s|%s|%s|%s|%s\\n' \"$PI_ASSERT_REF\" \"$PI_ASSERT_HOOK\" \"$PI_ASSERT_RUN_ID\" \"$PI_EVENT\" \"$PI_SESSION_ID\"";
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [assertion("identity", "tool_call", `${print} > shell.log`, {
        filter: { toolName: "^bash$", command: "echo" },
        when: `${print} > when.log`,
        source: "owner/rules",
      })],
      cwd,
      context(cwd, { metadata: { PI_SESSION_ID: "session-123" } }),
    );

    assert.equal(result.outcome, "pass");
    const whenIdentity = readFileSync(join(cwd, "when.log"), "utf8").trim();
    const shellIdentity = readFileSync(join(cwd, "shell.log"), "utf8").trim();
    assert.equal(shellIdentity, whenIdentity);
    assert.equal(result.executionReport?.executions.length, 1);
    const [ref, hook, runId, event, session] = shellIdentity.split("|");
    assert.equal(ref, "owner/rules/identity");
    assert.equal(hook, "tool_call");
    assert.match(runId ?? "", UUID_PATTERN);
    assert.equal(event, "tool_call");
    assert.equal(session, "session-123");
  });

  it("uses distinct run IDs for sibling invocations", async () => {
    const cwd = caseDirectory("sibling-run-ids");
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 1 },
      [
        assertion("one", "turn_end", "printf '%s\\n' \"$PI_ASSERT_RUN_ID\" >> ids.log"),
        assertion("two", "turn_end", "printf '%s\\n' \"$PI_ASSERT_RUN_ID\" >> ids.log"),
      ],
      cwd,
    );
    assert.equal(result.outcome, "pass");
    const ids = readFileSync(join(cwd, "ids.log"), "utf8").trim().split("\n");
    assert.equal(ids.length, 2);
    assert.match(ids[0] ?? "", UUID_PATTERN);
    assert.match(ids[1] ?? "", UUID_PATTERN);
    assert.notEqual(ids[0], ids[1]);
  });

  it("exposes stable tool-result and bounded lifecycle environments", async () => {
    const cwd = caseDirectory("event-environments");
    const metadata = {
      PI_SESSION_ID: "session-9",
      PI_PROVIDER: "provider",
      PI_MODEL: "model",
      PI_REASONING_LEVEL: "high",
      PI_MODE: "json",
      PI_PROJECT_TRUSTED: "true" as const,
      PI_CONTEXT_TOKENS: "12",
      PI_CONTEXT_WINDOW: "100",
      PI_CONTEXT_PERCENT: "12",
    };
    const result = await evaluate(
      new HookEvaluation(),
      "tool_result",
      {
        toolName: "read",
        toolCallId: "result-1",
        input: { path: ".env" },
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "text", text: "second" },
        ],
        isError: true,
      },
      [assertion(
        "environment",
        "tool_result",
        "test \"$PI_EVENT\" = tool_result && " +
          "test \"$PI_TOOL_NAME\" = read && " +
          "test \"$PI_TOOL_CALL_ID\" = result-1 && " +
          "test \"$PI_TOOL_INPUT\" = '{\"path\":\".env\"}' && " +
          "test \"$PI_TOOL_RESULT\" = 'first\nsecond' && " +
          "test \"$PI_TOOL_IS_ERROR\" = true && " +
          "test \"$PI_SESSION_ID\" = session-9 && " +
          "test \"$PI_REASONING_LEVEL\" = high",
      )],
      cwd,
      context(cwd, { metadata }),
    );
    assert.equal(result.outcome, "pass");

    const lifecycle = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 3, rich: "not exposed" } as HookEventMap["turn_end"],
      [assertion(
        "payload",
        "turn_end",
        "printf '%s' \"$PI_EVENT_PAYLOAD\" > payload.json",
      )],
      cwd,
    );
    assert.equal(lifecycle.outcome, "pass");
    assert.deepEqual(
      JSON.parse(readFileSync(join(cwd, "payload.json"), "utf8")),
      { event: "turn_end", turnIndex: 3 },
    );
  });

  it("treats an ordinary non-zero when as a skip", async () => {
    const cwd = caseDirectory("when-skip");
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("skip", "tool_call", "touch should-not-run", { when: "exit 9" }),
        assertion("pass", "tool_call", "true"),
      ],
      cwd,
    );
    assert.equal(result.outcome, "pass");
    assert.equal(existsSync(join(cwd, "should-not-run")), false);
    assert.deepEqual(
      result.executionReport?.executions.map((execution) => execution.assertionRef),
      ["local/pass"],
    );
  });

  it("omits a report when filters miss and ordinary when checks skip", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("miss", "tool_call", "true", {
          filter: { toolName: "^read$" },
        }),
        assertion("skip", "tool_call", "true", { when: "exit 9" }),
      ],
    );
    assert.equal(result.outcome, "pass");
    assert.equal(result.executionReport, undefined);
  });

  it("fails closed when a when process cannot execute", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [assertion("broken-when", "tool_call", "true", {
        when: String.fromCharCode(0),
      })],
    );
    assert.equal(result.outcome, "block");
    if (result.outcome === "block") {
      assert.match(result.reason, /during when/);
      assert.ok(!result.reason.includes("`true`"));
    }
    assert.equal(result.executionReport, undefined);
  });

  it("does not report a main shell that failed before spawning", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [assertion("broken-shell", "tool_call", String.fromCharCode(0))],
    );
    assert.equal(result.outcome, "block");
    assert.equal(result.executionReport, undefined);
  });

  it("runs shells in the supplied working directory", async () => {
    const cwd = caseDirectory("working-directory");
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [assertion("cwd", "tool_call", "test \"$PWD\" = \"$PI_CWD\" && touch marker")],
      cwd,
    );
    assert.equal(result.outcome, "pass");
    assert.ok(existsSync(join(cwd, "marker")));
  });

  it("fails closed on timeout", { timeout: 8_000 }, async () => {
    const startedAt = Date.now();
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [assertion("slow", "tool_call", "sleep 30")],
    );
    assert.equal(result.outcome, "block");
    assert.ok(Date.now() - startedAt < 8_000);
  });

  it("fails closed when aborted during a tool assertion", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [assertion("slow", "tool_call", "sleep 30")],
      root,
      context(root, { signal: controller.signal }),
    );
    assert.equal(result.outcome, "block");
  });

  it("skips already-aborted report-only turn hooks", async () => {
    const cwd = caseDirectory("already-aborted-report");
    const controller = new AbortController();
    controller.abort();
    const result = await evaluate(
      new HookEvaluation(),
      "agent_end",
      {},
      [assertion("would-run", "agent_end", "touch marker; false")],
      cwd,
      context(cwd, { signal: controller.signal }),
    );
    assert.equal(result.outcome, "pass");
    assert.equal(existsSync(join(cwd, "marker")), false);
  });

  it("strips stale managed environment while inheriting unrelated values", async () => {
    const previousSession = process.env.PI_SESSION_ID;
    const previousAgent = process.env.PI_CODING_AGENT;
    process.env.PI_SESSION_ID = "stale";
    process.env.PI_CODING_AGENT = "true";
    try {
      const result = await evaluate(
        new HookEvaluation(),
        "tool_call",
        toolCall,
        [assertion(
          "environment",
          "tool_call",
          "test \"$PI_SESSION_ID\" = current && test \"$PI_CODING_AGENT\" = true",
        )],
        root,
        context(root, { metadata: { PI_SESSION_ID: "current" } }),
      );
      assert.equal(result.outcome, "pass");
    } finally {
      if (previousSession === undefined) delete process.env.PI_SESSION_ID;
      else process.env.PI_SESSION_ID = previousSession;
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT;
      else process.env.PI_CODING_AGENT = previousAgent;
    }
  });
});

describe("Active Assertion Set", () => {
  it("copies and freezes its collection, assertions, and nested filters", async () => {
    const names = ["bash"];
    const rule = assertion("frozen", "tool_call", "false", {
      filter: { toolName: names },
    });
    const activeSet = createActiveAssertionSet([rule]);
    assert.ok(Object.isFrozen(activeSet));
    assert.equal(activeSet.size, 1);

    names.push("write");
    rule.shell = "true";
    rule.filter = undefined;

    const evaluator = new HookEvaluation();
    const write = await evaluator.evaluate(
      "tool_call",
      { toolName: "write", toolCallId: "write", input: {} },
      context(root),
      activeSet,
    );
    assert.equal(write.outcome, "pass");

    const bash = await evaluator.evaluate(
      "tool_call",
      toolCall,
      context(root),
      activeSet,
    );
    assert.equal(bash.outcome, "block");
  });

  it("captures one set and metadata snapshot for origin and handlers", async () => {
    const cwd = caseDirectory("captured-set-and-metadata");
    const metadata = { PI_SESSION_ID: "captured" };
    const origin = assertion("origin", "tool_call", "sleep 0.05; true");
    const handler = assertion(
      "handler",
      "assert_result",
      "printf '%s' \"$PI_SESSION_ID\" > captured.log",
    );
    const activeSet = createActiveAssertionSet([origin, handler]);
    const evaluation = new HookEvaluation().evaluate(
      "tool_call",
      toolCall,
      context(cwd, { metadata }),
      activeSet,
    );

    metadata.PI_SESSION_ID = "changed";
    handler.shell = "false";
    const result = await evaluation;
    assert.equal(result.outcome, "pass");
    assert.equal(readFileSync(join(cwd, "captured.log"), "utf8"), "captured");
  });
});

describe("owned Action evaluation", () => {
  it("skips already-aborted turn-end Assertions before traversal", async () => {
    const signal = AbortSignal.abort();
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 1 },
      [
        assertionWithAction("always", "turn_end", { type: "interrupt" }),
        assertionWithAction("gated", "turn_end", { type: "shutdown" }, {
          when: "true",
        }),
      ],
      root,
      context(root, { signal }),
    );

    assert.equal(result.outcome, "pass");
    assert.deepEqual(result.effects, []);
    assert.equal(result.executionReport, undefined);
  });

  it("shares one fresh identity between each passing precondition and action request", async () => {
    const cwd = caseDirectory("action-identities");
    const identityCheck = (name: string) =>
      `test "$PI_ASSERT_REF" = "local/${name}" && ` +
      "test \"$PI_ASSERT_HOOK\" = tool_call && " +
      "test \"$PI_EVENT\" = tool_call && " +
      "test \"$PI_TOOL_NAME\" = bash && " +
      `printf '%s' "$PI_ASSERT_RUN_ID" > ${name}.id`;
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertionWithAction("first", "tool_call", { type: "interrupt" }, {
          filter: { toolName: "^bash$" },
          when: identityCheck("first"),
        }),
        assertionWithAction("second", "tool_call", { type: "shutdown" }, {
          when: identityCheck("second"),
        }),
      ],
      cwd,
    );

    const effects = result.effects.filter((effect) => effect.type === "request-action");
    assert.equal(effects.length, 2);
    assert.equal(readFileSync(join(cwd, "first.id"), "utf8"), effects[0]?.runId);
    assert.equal(readFileSync(join(cwd, "second.id"), "utf8"), effects[1]?.runId);
    assert.match(effects[0]?.runId ?? "", UUID_PATTERN);
    assert.match(effects[1]?.runId ?? "", UUID_PATTERN);
    assert.notEqual(effects[0]?.runId, effects[1]?.runId);
    assert.deepEqual(
      result.executionReport?.executions.map((execution) => execution.assertionRef),
      ["local/first", "local/second"],
    );
  });

  it("requests each matching owned Action after aggregate traversal", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("blocks", "tool_call", "false"),
        assertion("not-run", "tool_call", "true"),
        assertionWithAction("message", "tool_call", {
          type: "message",
          message: "blocked",
          delivery: "followUp",
        }),
        assertionWithAction("miss", "tool_call", { type: "interrupt" }, {
          filter: { toolName: "^read$" },
        }),
        assertionWithAction("skip", "tool_call", { type: "shutdown" }, {
          when: "false",
        }),
        assertionWithAction("interrupt", "tool_call", { type: "interrupt" }),
      ],
    );

    assert.equal(result.outcome, "block");
    const effects = result.effects.filter((effect) => effect.type === "request-action");
    assert.deepEqual(effects.map((effect) => effect.assertionRef), [
      "local/message",
      "local/interrupt",
    ]);
    assert.deepEqual(
      result.executionReport?.actionRequests.map((request) => ({
        ref: request.assertionRef,
        type: request.actionType,
      })),
      [
        { ref: "local/message", type: "message" },
        { ref: "local/interrupt", type: "interrupt" },
      ],
    );
    assert.ok(Object.isFrozen(result.executionReport?.actionRequests));
  });

  it("lets a failure Action select a precondition infrastructure result", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertionWithAction("broken-when", "tool_call", {
          type: "interrupt",
          outcome: "block",
          code: null,
        }, {
          when: "bad\0command",
        }),
        assertionWithAction("sibling", "tool_call", { type: "shutdown" }),
      ],
    );

    assert.equal(result.outcome, "block");
    assert.deepEqual(result.effects.map((effect) => effect.type), [
      "request-action",
      "request-action",
    ]);
    assert.deepEqual(
      result.executionReport?.actionRequests.map((request) => ({
        ref: request.assertionRef,
        outcome: request.outcome,
      })),
      [
        { ref: "local/broken-when", outcome: "block" },
        { ref: "local/sibling", outcome: "pass" },
      ],
    );
  });

  it("uses exact true/false as ordinary accounted command results", async () => {
    const cwd = caseDirectory("shortcut-results");
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 4 },
      [
        assertionWithAction("exact-true", "turn_end", {
          type: "interrupt",
          code: 0,
        }),
        assertionWithAction("exact-false", "turn_end", {
          type: "shutdown",
          outcome: "report",
          code: 1,
        }, { shell: "false" }),
        assertion("compound", "turn_end", "false || true"),
        assertion("not-trimmed", "turn_end", " true && touch ordinary-shell"),
      ],
      cwd,
    );

    assert.equal(result.outcome, "report");
    assert.equal(existsSync(join(cwd, "ordinary-shell")), true);
    assert.deepEqual(
      result.executionReport?.executions.map(({ assertionRef, passed }) => ({
        assertionRef,
        passed,
      })),
      [
        { assertionRef: "local/exact-true", passed: true },
        { assertionRef: "local/exact-false", passed: false },
        { assertionRef: "local/compound", passed: true },
        { assertionRef: "local/not-trimmed", passed: true },
      ],
    );
    const requested = result.effects.filter(
      (effect) => effect.type === "request-action",
    );
    assert.deepEqual(
      requested.map((effect) => ({ ref: effect.assertionRef, action: effect.action })),
      [
        { ref: "local/exact-true", action: { type: "interrupt" } },
        { ref: "local/exact-false", action: { type: "shutdown" } },
      ],
      "selector metadata is not part of Action Requests",
    );
  });

  it("fails an already-aborted shortcut with code null and selects its failure Action", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [assertionWithAction("aborted", "tool_call", {
        type: "interrupt",
        outcome: "block",
        code: null,
      })],
      root,
      context(root, { signal: AbortSignal.abort() }),
    );

    assert.equal(result.outcome, "block");
    assert.equal(result.executionReport?.executions.length, 0);
    assert.deepEqual(
      result.executionReport?.actionRequests.map(({ assertionRef, outcome }) => ({
        assertionRef,
        outcome,
      })),
      [{ assertionRef: "local/aborted", outcome: "block" }],
    );
  });

  it("ANDs scalar/list outcome and code selectors against each local result", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertionWithAction("matches", "tool_call", {
          type: "interrupt",
          outcome: ["pass", "block"],
          code: [0, 1],
        }, { shell: "false" }),
        assertionWithAction("wrong-code", "tool_call", {
          type: "shutdown",
          outcome: "block",
          code: null,
        }, { shell: "false" }),
        assertionWithAction("pass-but-code-misses", "tool_call", {
          type: "compact",
          outcome: ["pass", "block"],
          code: [1, null],
        }),
      ],
    );

    assert.equal(result.outcome, "block");
    assert.deepEqual(
      result.effects
        .filter((effect) => effect.type === "request-action")
        .map((effect) => effect.assertionRef),
      ["local/matches"],
    );
  });

  it("can react separately to every originating Assertion outcome", async () => {
    const watcher = (outcome: "pass" | "block" | "patch" | "cancel" | "report") =>
      assertionWithAction("watch", "assert_result", { type: "interrupt" }, {
        filter: { outcome },
      });
    const cases = [
      await evaluate(
        new HookEvaluation(),
        "tool_call",
        toolCall,
        [assertion("origin", "tool_call", "true"), watcher("pass")],
      ),
      await evaluate(
        new HookEvaluation(),
        "tool_call",
        toolCall,
        [assertion("origin", "tool_call", "false"), watcher("block")],
      ),
      await evaluate(
        new HookEvaluation(),
        "tool_result",
        toolResult,
        [assertion("origin", "tool_result", "false"), watcher("patch")],
      ),
      await evaluate(
        new HookEvaluation(),
        "session_before_switch",
        { reason: "new" },
        [
          assertion("origin", "session_before_switch", "false"),
          watcher("cancel"),
        ],
      ),
      await evaluate(
        new HookEvaluation(),
        "turn_end",
        { turnIndex: 1 },
        [assertion("origin", "turn_end", "false"), watcher("report")],
      ),
    ];

    assert.deepEqual(
      cases.map((result) => {
        const requests = result.executionReport?.actionRequests ?? [];
        assert.equal(requests.length, 1);
        return requests[0]?.originatingResult?.outcome;
      }),
      ["pass", "block", "patch", "cancel", "report"],
    );
  });

  it("dispatches synthetic actions result-major with origin association", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 3 },
      [
        assertion("passes", "turn_end", "true"),
        assertion("fails", "turn_end", "false"),
        assertionWithAction("first", "assert_result", { type: "interrupt" }),
        assertionWithAction("second", "assert_result", {
          type: "emit-custom-event",
          name: "test:event",
          data: { value: 1 },
        }),
      ],
    );

    const actions = result.effects.filter((effect) => effect.type === "request-action");
    assert.deepEqual(actions.map((effect) => effect.assertionRef), [
      "local/first",
      "local/second",
      "local/first",
      "local/second",
    ]);
    assert.deepEqual(
      result.executionReport?.actionRequests.map((request) =>
        request.originatingResult?.assertionRef
      ),
      ["local/passes", "local/passes", "local/fails", "local/fails"],
    );
    const eventAction = actions[1]?.action;
    assert.ok(eventAction && eventAction.type === "emit-custom-event");
    assert.ok(Object.isFrozen(eventAction));
    assert.ok(Object.isFrozen(eventAction.data));
  });
});

describe("synthetic assert_result phase", () => {
  it("awaits handlers in result-major, configured-handler order", async () => {
    const cwd = caseDirectory("synthetic-order");
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 2 },
      [
        assertion("origin-pass", "turn_end", "true"),
        assertion("origin-fail", "turn_end", "exit 7"),
        assertion(
          "first",
          "assert_result",
          "sleep 0.02; printf 'first:%s\\n' \"$PI_EVENT_PAYLOAD\" >> order.log",
        ),
        assertion(
          "second",
          "assert_result",
          "printf 'second:%s\\n' \"$PI_EVENT_PAYLOAD\" >> order.log",
        ),
      ],
      cwd,
    );

    assert.equal(result.outcome, "report");
    const lines = readFileSync(join(cwd, "order.log"), "utf8").trim().split("\n");
    assert.deepEqual(lines.map((line) => line.slice(0, line.indexOf(":"))), [
      "first",
      "second",
      "first",
      "second",
    ]);
    assert.match(lines[0] ?? "", /"outcome":"pass","code":0/);
    assert.match(lines[2] ?? "", /"outcome":"report","code":7/);

    const executions = result.executionReport?.executions ?? [];
    assert.deepEqual(executions.map((execution) => execution.assertionRef), [
      "local/origin-pass",
      "local/origin-fail",
      "local/first",
      "local/second",
      "local/first",
      "local/second",
    ]);
    assert.deepEqual(
      executions.slice(2).map((execution) =>
        execution.originatingResult?.assertionRef
      ),
      [
        "local/origin-pass",
        "local/origin-pass",
        "local/origin-fail",
        "local/origin-fail",
      ],
    );
    assert.ok(Object.isFrozen(executions[2]?.originatingResult));
  });

  it("matches assertion refs by regex, outcomes exactly, and codes strictly", async () => {
    const cwd = caseDirectory("synthetic-filters");
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 1 },
      [
        assertion("passes", "turn_end", "true"),
        assertion("fails", "turn_end", "exit 7"),
        assertion("matching", "assert_result", "printf 'match\\n' >> match.log", {
          filter: {
            assertionRef: "^local/fails$",
            runId: "^[0-9a-f-]+$",
            outcome: "report",
            code: 7,
          },
        }),
        assertion("not-regex", "assert_result", "touch bad", {
          filter: { outcome: "r.*" },
        }),
        assertion("wrong-code", "assert_result", "touch bad", {
          filter: { code: 8 },
        }),
        assertionWithAction("matching-action", "assert_result", { type: "interrupt" }, {
          filter: {
            assertionRef: "^local/fails$",
            runId: "^[0-9a-f-]+$",
            outcome: "report",
            code: 7,
          },
        }),
        assertionWithAction("wrong-action", "assert_result", { type: "shutdown" }, {
          filter: { outcome: "r.*" },
        }),
      ],
      cwd,
    );
    assert.equal(result.outcome, "report");
    assert.equal(readFileSync(join(cwd, "match.log"), "utf8"), "match\n");
    assert.equal(existsSync(join(cwd, "bad")), false);
    assert.deepEqual(
      result.effects
        .filter((effect) => effect.type === "request-action")
        .map((effect) => effect.assertionRef),
      ["local/matching-action"],
    );
  });

  it("detaches handlers from the originating abort signal", async () => {
    const cwd = caseDirectory("synthetic-detached");
    const controller = new AbortController();
    controller.abort();
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("origin", "tool_call", "true"),
        assertion("handler", "assert_result", "touch handled"),
        assertionWithAction("action", "assert_result", { type: "interrupt" }, {
          when: "true",
        }),
      ],
      cwd,
      context(cwd, { signal: controller.signal }),
    );
    assert.equal(result.outcome, "block");
    assert.ok(existsSync(join(cwd, "handled")));
    assert.ok(
      result.effects.some((effect) =>
        effect.type === "request-action" && effect.assertionRef === "local/action"
      ),
    );
  });

  it("keeps origin and handler invocation identities separate", async () => {
    const cwd = caseDirectory("synthetic-identities");
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("origin", "tool_call", "true"),
        assertion(
          "handler",
          "assert_result",
          "printf '%s|%s\\n' \"$PI_ASSERT_RUN_ID\" \"$PI_EVENT_PAYLOAD\" > identities.log",
        ),
      ],
      cwd,
    );
    assert.equal(result.outcome, "pass");
    const line = readFileSync(join(cwd, "identities.log"), "utf8").trim();
    const separator = line.indexOf("|");
    const handlerRunId = line.slice(0, separator);
    const payload = JSON.parse(line.slice(separator + 1)) as { runId: string };
    assert.match(handlerRunId, UUID_PATTERN);
    assert.match(payload.runId, UUID_PATTERN);
    assert.notEqual(handlerRunId, payload.runId);
  });

  it("isolates handler errors and failures while continuing siblings", async () => {
    const cwd = caseDirectory("synthetic-isolation");
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("origin", "tool_call", "true"),
        assertion("bad-filter", "assert_result", "true", {
          filter: { assertionRef: "[" },
        }),
        assertion("fails", "assert_result", "false"),
        assertion("sibling", "assert_result", "touch sibling"),
        assertionWithAction("bad-action-filter", "assert_result", { type: "interrupt" }, {
          filter: { assertionRef: "[" },
        }),
        assertionWithAction("action-sibling", "assert_result", { type: "shutdown" }),
      ],
      cwd,
    );

    assert.equal(result.outcome, "pass");
    assert.ok(existsSync(join(cwd, "sibling")));
    assert.deepEqual(result.effects.map((effect) => effect.type), [
      "present",
      "present",
      "request-action",
      "present",
    ]);
    assert.match(presentationMessages(result)[0] ?? "", /bad-filter.*failed to execute/);
    assert.match(
      presentationMessages(result)[1] ?? "",
      /bad-action-filter.*failed to execute/,
    );
    assert.match(presentationMessages(result)[2] ?? "", /1 assert_result assertion failed/);
  });

  it("suppresses recursion when a result handler fails", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("origin", "tool_call", "true"),
        assertion("handler", "assert_result", "false"),
      ],
    );
    assert.equal(result.outcome, "pass");
    assert.equal(result.effects.length, 1);
    assert.match(presentationMessages(result)[0] ?? "", /assert_result assertion failed/);
    assert.deepEqual(
      result.executionReport?.executions.map((execution) => ({
        assertionRef: execution.assertionRef,
        origin: execution.originatingResult?.assertionRef,
      })),
      [
        { assertionRef: "local/origin", origin: undefined },
        { assertionRef: "local/handler", origin: "local/origin" },
      ],
    );
  });
});

describe("session policy state", () => {
  it("deduplicates corrective retries and clears the fingerprint after a pass", async () => {
    const evaluator = new HookEvaluation();
    await evaluate(
      evaluator,
      "tool_call",
      toolCall,
      [assertion("tool", "tool_call", "true")],
    );

    const failing = [assertion("clean", "agent_end", "false")];
    const first = await evaluate(evaluator, "agent_end", {}, failing);
    assert.equal(first.outcome, "report");
    assert.deepEqual(first.effects.map((effect) => effect.type), [
      "request-corrective-turn",
    ]);
    assert.deepEqual(
      first.executionReport?.executions.map((execution) => execution.assertionRef),
      ["local/clean"],
    );

    const repeated = await evaluate(evaluator, "agent_end", {}, failing);
    assert.deepEqual(repeated.effects.map((effect) => effect.type), [
      "present",
    ]);
    assert.match(presentationMessages(repeated)[0] ?? "", /automatic retry stopped/);

    const passing = await evaluate(
      evaluator,
      "agent_end",
      {},
      [assertion("clean", "agent_end", "true")],
    );
    assert.equal(passing.outcome, "pass");

    const afterPass = await evaluate(evaluator, "agent_end", {}, failing);
    assert.equal(afterPass.effects.at(-1)?.type, "request-corrective-turn");
  });

  it("keeps execution accounting local to each native event", async () => {
    const evaluator = new HookEvaluation();
    const tool = await evaluate(
      evaluator,
      "tool_call",
      toolCall,
      [
        assertion("tool", "tool_call", "true"),
        assertionWithAction("tool-action", "tool_call", { type: "interrupt" }),
      ],
    );
    const end = await evaluate(
      evaluator,
      "agent_end",
      {},
      [
        assertion("end", "agent_end", "true"),
        assertionWithAction("end-action", "agent_end", { type: "shutdown" }),
      ],
    );
    assert.deepEqual(
      tool.executionReport?.executions.map((execution) => execution.assertionRef),
      ["local/tool", "local/tool-action"],
    );
    assert.deepEqual(
      end.executionReport?.executions.map((execution) => execution.assertionRef),
      ["local/end", "local/end-action"],
    );
    assert.deepEqual(
      tool.executionReport?.actionRequests.map((request) => request.assertionRef),
      ["local/tool-action"],
    );
    assert.deepEqual(
      end.executionReport?.actionRequests.map((request) => request.assertionRef),
      ["local/end-action"],
    );
  });

  it("allows independent tool evaluations to overlap", async () => {
    const cwd = caseDirectory("parallel-evaluations");
    const evaluator = new HookEvaluation();
    const waitFor = (own: string, sibling: string) =>
      `touch ${own}; i=0; while [ ! -f ${sibling} ] && [ $i -lt 200 ]; do sleep 0.01; i=$((i + 1)); done; test -f ${sibling}`;

    const [first, second] = await Promise.all([
      evaluate(
        evaluator,
        "tool_call",
        { ...toolCall, toolCallId: "parallel-a" },
        [
          assertion("a", "tool_call", waitFor("a.started", "b.started")),
          assertionWithAction("action-a", "tool_call", { type: "interrupt" }),
        ],
        cwd,
      ),
      evaluate(
        evaluator,
        "tool_call",
        { ...toolCall, toolCallId: "parallel-b" },
        [
          assertion("b", "tool_call", waitFor("b.started", "a.started")),
          assertionWithAction("action-b", "tool_call", { type: "shutdown" }),
        ],
        cwd,
      ),
    ]);

    assert.equal(first.outcome, "pass");
    assert.equal(second.outcome, "pass");
    assert.deepEqual(
      first.executionReport?.executions.map((execution) => execution.assertionRef),
      ["local/a", "local/action-a"],
    );
    assert.deepEqual(
      second.executionReport?.executions.map((execution) => execution.assertionRef),
      ["local/b", "local/action-b"],
    );
    assert.deepEqual(
      first.executionReport?.actionRequests.map((request) => request.assertionRef),
      ["local/action-a"],
    );
    assert.deepEqual(
      second.executionReport?.actionRequests.map((request) => request.assertionRef),
      ["local/action-b"],
    );
  });
});

describe("unexpected failures fail closed", () => {
  const invalidFilter = { toolName: "[" };

  it("blocks tool calls and still dispatches completed invocation results", async () => {
    const cwd = caseDirectory("fail-closed-tool-call");
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        assertion("completed", "tool_call", "true"),
        assertion("crashes", "tool_call", "true", { filter: invalidFilter }),
        assertion("later-sibling", "tool_call", "true"),
        assertion(
          "handler",
          "assert_result",
          "printf '%s\\n' \"$PI_EVENT_PAYLOAD\" >> completed.log",
        ),
      ],
      cwd,
    );
    assert.equal(result.outcome, "block");
    if (result.outcome === "block") {
      assert.match(result.reason, /guard failed to execute; call blocked/);
    }
    const records = readFileSync(join(cwd, "completed.log"), "utf8").trim().split("\n");
    assert.equal(records.length, 2);
    assert.match(records[0] ?? "", /"assertionRef":"local\/completed"/);
    assert.match(records[1] ?? "", /"assertionRef":"local\/later-sibling"/);
    assert.ok(!records.some((record) => record.includes("local/crashes")));
  });

  it("suppresses tool results", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_result",
      toolResult,
      [assertion("crashes", "tool_result", "true", { filter: invalidFilter })],
    );
    assert.equal(result.outcome, "patch");
    if (result.outcome === "patch") {
      assert.equal(result.patch.isError, true);
      assert.match(result.reason, /result suppressed/);
    }
  });

  it("cancels both cancellable session changes", async () => {
    const evaluator = new HookEvaluation();
    const switching = await evaluate(
      evaluator,
      "session_before_switch",
      { reason: "new" },
      [assertion("crashes", "session_before_switch", "true", {
        filter: { reason: "[" },
      })],
    );
    assert.equal(switching.outcome, "cancel");

    const forking = await evaluate(
      evaluator,
      "session_before_fork",
      { entryId: "entry", position: "at" },
      [assertion("crashes", "session_before_fork", "true", {
        filter: { position: "[" },
      })],
    );
    assert.equal(forking.outcome, "cancel");
  });

  it("turn and settled infrastructure errors become presentation feedback", async () => {
    for (const [hook, event] of [
      ["turn_end", { turnIndex: 1 }],
      ["agent_settled", {}],
    ] as const) {
      const result = await evaluate(
        new HookEvaluation(),
        hook,
        event,
        [assertion("crashes", hook, "true", {
          filter: { event: "[" },
        })],
      );
      assert.equal(result.outcome, "report");
      assert.equal(result.effects[0]?.type, "present");
      assert.match(presentationMessages(result)[0] ?? "", /failed to execute/);
    }
  });

  it("agent_end infrastructure errors never request a corrective turn", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "agent_end",
      {},
      [assertion("crashes", "agent_end", "true", {
        filter: { event: "[" },
      })],
    );
    assert.equal(result.outcome, "report");
    assert.deepEqual(result.effects.map((effect) => effect.type), ["present"]);
    assert.match(presentationMessages(result)[0] ?? "", /failed to execute/);
  });
});
