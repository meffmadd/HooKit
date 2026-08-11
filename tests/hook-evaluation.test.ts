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

import type { Event, NativeEvent } from "../hookit/domain/entry.js";
import { adapterFor } from "../hookit/hook-evaluation/adapters.js";
import { invokeHooks } from "../hookit/hook-evaluation/invocations.js";
import type {
  ActiveHook,
} from "../hookit/hook-evaluation/index.js";
import {
  HookEvaluation,
  createActiveHookSet,
  type HookExecutionReport,
  type EvaluationReportRow,
  type EventMap,
  type EvaluationContext,
  type HookEvaluationResult,
} from "../hookit/hook-evaluation/index.js";

/** Ordered hook rows of one report (or none). */
function hookRows(
  report?: HookExecutionReport,
): Array<Extract<EvaluationReportRow, { type: "hook" }>> {
  return (report?.rows ?? []).filter(
    (row): row is Extract<EvaluationReportRow, { type: "hook" }> =>
      row.type === "hook",
  );
}

/** Ordered action rows of one report (or none). */
function actionRows(
  report?: HookExecutionReport,
): Array<Extract<EvaluationReportRow, { type: "action" }>> {
  return (report?.rows ?? []).filter(
    (row): row is Extract<EvaluationReportRow, { type: "action" }> =>
      row.type === "action",
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "HooKit-hook-evaluation-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function caseDirectory(name: string): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function hook(
  name: string,
  event: Event,
  shell = "true",
  extra: Partial<ActiveHook> = {},
): ActiveHook {
  return {
    name,
    source: "local",
    description: "test hook",
    event,    shell,
    ...extra,
  };
}

function hookWithAction(
  name: string,
  event: Event,
  action: Omit<NonNullable<ActiveHook["action"]>, "outcome"> & {
    outcome?: NonNullable<ActiveHook["action"]>["outcome"];
  },
  extra: Partial<ActiveHook> = {},
): ActiveHook {
  return {
    name,
    source: "local",
    description: "test Hook with Action",
    event,    shell: "true",
    action: { outcome: "pass", ...action } as NonNullable<ActiveHook["action"]>,
    ...extra,
  };
}

function context(
  cwd: string,
  extra: Partial<EvaluationContext> = {},
): EvaluationContext {
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

async function evaluate<H extends NativeEvent>(
  evaluator: HookEvaluation,
  event: H,
  payload: EventMap[H],
  hooks: readonly ActiveHook[],
  cwd = root,
  executionContext: EvaluationContext = context(cwd),
): Promise<HookEvaluationResult> {
  return evaluator.evaluate(
    event,
    payload,
    executionContext,
    createActiveHookSet(hooks),
  );
}

function presentationMessages(result: HookEvaluationResult): string[] {
  return result.effects.flatMap((effect) =>
    effect.type === "present" ? [effect.message] : []
  );
}

describe("Hook Evaluation native outcomes", () => {
  it("aggregates a block while continuing matching tool-call Hooks", async () => {
    const cwd = caseDirectory("tool-call-block");
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        hook("passes", "tool_call", "true"),
        hook("blocks", "tool_call", "exit 7"),
        hook("not-run", "tool_call", "touch not-run"),
      ],
      cwd,
    );

    assert.equal(result.outcome, "block");
    if (result.outcome === "block") {
      assert.equal(
        result.reason,
        'hookit: hook "blocks" rejected bash — `exit 7`',
      );
    }
    assert.equal(existsSync(join(cwd, "not-run")), true);
    assert.deepEqual(
      hookRows(result.executionReport).map(({ hookRef, passed }) => ({
        hookRef,
        passed,
      })),
      [
        { hookRef: "local/passes", passed: true },
        { hookRef: "local/blocks", passed: false },
        { hookRef: "local/not-run", passed: true },
      ],
    );
  });

  it("includes every tool failure in one block or replacement patch", async () => {
    const call = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        hook("first", "tool_call", "false"),
        hook("second", "tool_call", "exit 7"),
      ],
    );
    assert.equal(call.outcome, "block");
    if (call.outcome === "block") {
      assert.match(call.reason, /2 hooks rejected bash/);
      assert.match(call.reason, /hook "first"/);
      assert.match(call.reason, /hook "second"/);
    }

    const toolOutput = await evaluate(
      new HookEvaluation(),
      "tool_result",
      toolResult,
      [
        hook("first", "tool_result", "false"),
        hook("second", "tool_result", "exit 9"),
      ],
    );
    assert.equal(toolOutput.outcome, "patch");
    if (toolOutput.outcome === "patch") {
      const text = toolOutput.patch.content?.[0];
      assert.ok(text?.type === "text");
      assert.match(text.text, /hook "first"/);
      assert.match(text.text, /hook "second"/);
    }
  });

  it("passes when filters miss or matching shells pass", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        hook("write-only", "tool_call", "false", {
          filter: { toolName: "^write$" },
        }),
        hook("nested", "tool_call", "true", {
          filter: { "request.target.path": "(^|/)\\.env$" },
        }),
        hook("passes", "tool_call", "true", {
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
      [hook("nested", "tool_call", "false", {
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
      [hook("bash", "tool_call", "false", {
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
      [hook("redact", "tool_result", "false")],
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
        hook("one", "turn_end", "false", { filter: { turnIndex: 4 } }),
        hook("two", "turn_end", "exit 2"),
      ],
    );
    assert.equal(result.outcome, "report");
    assert.equal(result.effects.length, 1);
    assert.equal(result.effects[0]?.type, "present");
    assert.match(presentationMessages(result)[0] ?? "", /2 turn_end hooks failed/);
    assert.match(presentationMessages(result)[0] ?? "", /\*\*one\*\*/);
    assert.match(presentationMessages(result)[0] ?? "", /\*\*two\*\*/);
    assert.deepEqual(
      hookRows(result.executionReport).map((row) => row.hookRef),
      ["local/one", "local/two"],
    );
  });

  it("reports all agent_settled failures", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "agent_settled",
      {},
      [
        hook("one", "agent_settled", "false"),
        hook("two", "agent_settled", "false"),
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
        hook("new-only", "session_before_switch", "false", {
          filter: { reason: "^new$" },
        }),
        hook("always", "session_before_switch", "false"),
      ],
    );
    assert.equal(switching.outcome, "cancel");
    if (switching.outcome === "cancel") {
      assert.match(switching.reason, /session switch cancelled by 2 hooks/);
    }

    const forking = await evaluate(
      evaluator,
      "session_before_fork",
      { entryId: "entry-1", position: "at" },
      [
        hook("clone-only", "session_before_fork", "false", {
          filter: { position: "^at$" },
        }),
        hook("always", "session_before_fork", "false"),
      ],
    );
    assert.equal(forking.outcome, "cancel");
    if (forking.outcome === "cancel") {
      assert.match(forking.reason, /session fork cancelled by 2 hooks/);
    }
  });

  it("returns an immutable report containing only actual shell executions", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [hook("pass", "tool_call", "true", { source: "owner/hooks" })],
    );
    assert.deepEqual(Object.keys(result).sort(), [
      "effects",
      "executionReport",
      "outcome",
    ]);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.effects));
    assert.ok(Object.isFrozen(result.executionReport));
    assert.ok(Object.isFrozen(result.executionReport?.rows));
    assert.equal(hookRows(result.executionReport).length, 1);
    const row = hookRows(result.executionReport)[0];
    assert.equal(row?.hookRef, "owner/hooks/pass");
    assert.equal(row?.type, "hook");
    assert.equal(row?.passed, true);
    assert.ok((row?.durationMs ?? -1) >= 0);
    assert.ok(Object.isFrozen(row));
    // Reporting rows carry no invocation identity or evaluated Event.
    assert.ok(!("runId" in (row ?? {})), "no runId on a report row");
    assert.ok(!("evaluatedEvent" in (row ?? {})), "no Event on a report row");
  });
});

describe("Hook Invocation semantics", () => {
  it("freezes each individual Hook Result at Invocation creation", async () => {
    const batch = await invokeHooks(
      [hook("immutable", "tool_call")],
      adapterFor("tool_call"),
      toolCall,
      context(root),
    );

    assert.equal(batch.invocations.length, 1);
    assert.equal(batch.invocations[0]!.result.evaluatedEvent, "tool_call");
    assert.ok(Object.isFrozen(batch.invocations[0]!.result));
  });

  it("runs filter then when then shell with one shared environment", async () => {
    const cwd = caseDirectory("when-shell-environment");
    const print =
      "printf '%s|%s|%s|%s|%s\\n' \"$PI_HOOK_REF\" \"$PI_HOOK_EVENT\" \"$PI_HOOK_RUN_ID\" \"$PI_EVENT\" \"$PI_SESSION_ID\"";
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [hook("identity", "tool_call", `${print} > shell.log`, {
        filter: { toolName: "^bash$", command: "echo" },
        when: `${print} > when.log`,
        source: "owner/hooks",
      })],
      cwd,
      context(cwd, { metadata: { PI_SESSION_ID: "session-123" } }),
    );

    assert.equal(result.outcome, "pass");
    const whenIdentity = readFileSync(join(cwd, "when.log"), "utf8").trim();
    const shellIdentity = readFileSync(join(cwd, "shell.log"), "utf8").trim();
    assert.equal(shellIdentity, whenIdentity);
    assert.equal(hookRows(result.executionReport).length, 1);
    const [ref, hookEvent, runId, event, session] = shellIdentity.split("|");
    assert.equal(ref, "owner/hooks/identity");
    assert.equal(hookEvent, "tool_call");
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
        hook("one", "turn_end", "printf '%s\\n' \"$PI_HOOK_RUN_ID\" >> ids.log"),
        hook("two", "turn_end", "printf '%s\\n' \"$PI_HOOK_RUN_ID\" >> ids.log"),
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
      [hook(
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
      { turnIndex: 3, rich: "not exposed" } as EventMap["turn_end"],
      [hook(
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
        hook("skip", "tool_call", "touch should-not-run", { when: "exit 9" }),
        hook("pass", "tool_call", "true"),
      ],
      cwd,
    );
    assert.equal(result.outcome, "pass");
    assert.equal(existsSync(join(cwd, "should-not-run")), false);
    assert.deepEqual(
      hookRows(result.executionReport).map((row) => row.hookRef),
      ["local/pass"],
    );
  });

  it("omits a report when filters miss and ordinary when checks skip", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        hook("miss", "tool_call", "true", {
          filter: { toolName: "^read$" },
        }),
        hook("skip", "tool_call", "true", { when: "exit 9" }),
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
      [hook("broken-when", "tool_call", "true", {
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
      [hook("broken-shell", "tool_call", String.fromCharCode(0))],
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
      [hook("cwd", "tool_call", "test \"$PWD\" = \"$PI_CWD\" && touch marker")],
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
      [hook("slow", "tool_call", "sleep 30")],
    );
    assert.equal(result.outcome, "block");
    assert.ok(Date.now() - startedAt < 8_000);
  });

  it("fails closed when aborted during a tool Hook Invocation", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [hook("slow", "tool_call", "sleep 30")],
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
      [hook("would-run", "agent_end", "touch marker; false")],
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
        [hook(
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

describe("Active Hook Set", () => {
  it("copies its ordered membership while reusing immutable catalog Hooks", async () => {
    const first = hook("first", "tool_call", "false");
    const second = hook("second", "tool_call", "true");
    const input = [first, second];
    const activeSet = createActiveHookSet(input);
    assert.ok(Object.isFrozen(activeSet));
    assert.equal(activeSet.size, 2);

    // Later activation or catalog replacement cannot affect the captured set:
    // membership is copied, not aliased.
    input.length = 0;
    input.push(hook("replacement", "tool_call", "true"));

    const result = await new HookEvaluation().evaluate(
      "tool_call",
      toolCall,
      context(root),
      activeSet,
    );
    // The captured `first` (shell false) still blocks; the replacement is not
    // part of this set.
    assert.equal(result.outcome, "block");
  });

  it("captures one set and metadata snapshot for origin and handlers", async () => {
    const cwd = caseDirectory("captured-set-and-metadata");
    const metadata = { PI_SESSION_ID: "captured" };
    // Catalog-owned Hooks are already immutable; capture reuses them.
    const origin = Object.freeze(hook("origin", "tool_call", "sleep 0.05; true"));
    const handler = Object.freeze(hook(
      "handler",
      "hook_result",
      "printf '%s' \"$PI_SESSION_ID\" > captured.log",
    ));
    const activeSet = createActiveHookSet([origin, handler]);
    const evaluation = new HookEvaluation().evaluate(
      "tool_call",
      toolCall,
      context(cwd, { metadata }),
      activeSet,
    );

    // Mutating runtime metadata after capture must not affect the running
    // evaluation (the metadata snapshot is taken at callback entry).
    metadata.PI_SESSION_ID = "changed";
    const result = await evaluation;
    assert.equal(result.outcome, "pass");
    assert.equal(readFileSync(join(cwd, "captured.log"), "utf8"), "captured");
  });
});

describe("owned Action evaluation", () => {
  it("skips already-aborted turn-end Hooks before traversal", async () => {
    const signal = AbortSignal.abort();
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 1 },
      [
        hookWithAction("always", "turn_end", { type: "interrupt" }),
        hookWithAction("gated", "turn_end", { type: "shutdown" }, {
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
      `test "$PI_HOOK_REF" = "local/${name}" && ` +
      "test \"$PI_HOOK_EVENT\" = tool_call && " +
      "test \"$PI_EVENT\" = tool_call && " +
      "test \"$PI_TOOL_NAME\" = bash && " +
      `printf '%s' "$PI_HOOK_RUN_ID" > ${name}.id`;
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        hookWithAction("first", "tool_call", { type: "interrupt" }, {
          filter: { toolName: "^bash$" },
          when: identityCheck("first"),
        }),
        hookWithAction("second", "tool_call", { type: "shutdown" }, {
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
      hookRows(result.executionReport).map((row) => row.hookRef),
      ["local/first", "local/second"],
    );
  });

  it("requests each matching owned Action after aggregate traversal", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        hook("blocks", "tool_call", "false"),
        hook("not-run", "tool_call", "true"),
        hookWithAction("message", "tool_call", {
          type: "message",
          message: "blocked",
          delivery: "followUp",
        }),
        hookWithAction("miss", "tool_call", { type: "interrupt" }, {
          filter: { toolName: "^read$" },
        }),
        hookWithAction("skip", "tool_call", { type: "shutdown" }, {
          when: "false",
        }),
        hookWithAction("interrupt", "tool_call", { type: "interrupt" }),
      ],
    );

    assert.equal(result.outcome, "block");
    const effects = result.effects.filter((effect) => effect.type === "request-action");
    assert.deepEqual(effects.map((effect) => effect.hookRef), [
      "local/message",
      "local/interrupt",
    ]);
    assert.deepEqual(
      actionRows(result.executionReport).map((request) => ({
        ref: request.hookRef,
        type: request.actionType,
      })),
      [
        { ref: "local/message", type: "message" },
        { ref: "local/interrupt", type: "interrupt" },
      ],
    );
    assert.ok(Object.isFrozen(result.executionReport?.rows));
  });

  it("lets a failure Action select a precondition infrastructure result", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        hookWithAction("broken-when", "tool_call", {
          type: "interrupt",
          outcome: "block",
          code: null,
        }, {
          when: "bad\0command",
        }),
        hookWithAction("sibling", "tool_call", { type: "shutdown" }),
      ],
    );

    assert.equal(result.outcome, "block");
    assert.deepEqual(result.effects.map((effect) => effect.type), [
      "request-action",
      "request-action",
    ]);
    assert.deepEqual(
      actionRows(result.executionReport).map((request) => ({
        ref: request.hookRef,
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
        hookWithAction("exact-true", "turn_end", {
          type: "interrupt",
          code: 0,
        }),
        hookWithAction("exact-false", "turn_end", {
          type: "shutdown",
          outcome: "report",
          code: 1,
        }, { shell: "false" }),
        hook("compound", "turn_end", "false || true"),
        hook("not-trimmed", "turn_end", " true && touch ordinary-shell"),
      ],
      cwd,
    );

    assert.equal(result.outcome, "report");
    assert.equal(existsSync(join(cwd, "ordinary-shell")), true);
    assert.deepEqual(
      hookRows(result.executionReport).map(({ hookRef, passed }) => ({
        hookRef,
        passed,
      })),
      [
        { hookRef: "local/exact-true", passed: true },
        { hookRef: "local/exact-false", passed: false },
        { hookRef: "local/compound", passed: true },
        { hookRef: "local/not-trimmed", passed: true },
      ],
    );
    const requested = result.effects.filter(
      (effect) => effect.type === "request-action",
    );
    assert.deepEqual(
      requested.map((effect) => ({ ref: effect.hookRef, action: effect.action })),
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
      [hookWithAction("aborted", "tool_call", {
        type: "interrupt",
        outcome: "block",
        code: null,
      })],
      root,
      context(root, { signal: AbortSignal.abort() }),
    );

    assert.equal(result.outcome, "block");
    assert.equal(hookRows(result.executionReport).length, 0);
    assert.deepEqual(
      actionRows(result.executionReport).map(({ hookRef, outcome }) => ({
        hookRef,
        outcome,
      })),
      [{ hookRef: "local/aborted", outcome: "block" }],
    );
  });

  it("ANDs scalar/list outcome and code selectors against each local result", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        hookWithAction("matches", "tool_call", {
          type: "interrupt",
          outcome: ["pass", "block"],
          code: [0, 1],
        }, { shell: "false" }),
        hookWithAction("wrong-code", "tool_call", {
          type: "shutdown",
          outcome: "block",
          code: null,
        }, { shell: "false" }),
        hookWithAction("pass-but-code-misses", "tool_call", {
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
        .map((effect) => effect.hookRef),
      ["local/matches"],
    );
  });

  it("can react separately to every originating Hook outcome", async () => {
    const watcher = (outcome: "pass" | "block" | "patch" | "cancel" | "report") =>
      hookWithAction("watch", "hook_result", { type: "interrupt" }, {
        filter: { outcome },
      });
    const cases = [
      await evaluate(
        new HookEvaluation(),
        "tool_call",
        toolCall,
        [hook("origin", "tool_call", "true"), watcher("pass")],
      ),
      await evaluate(
        new HookEvaluation(),
        "tool_call",
        toolCall,
        [hook("origin", "tool_call", "false"), watcher("block")],
      ),
      await evaluate(
        new HookEvaluation(),
        "tool_result",
        toolResult,
        [hook("origin", "tool_result", "false"), watcher("patch")],
      ),
      await evaluate(
        new HookEvaluation(),
        "session_before_switch",
        { reason: "new" },
        [
          hook("origin", "session_before_switch", "false"),
          watcher("cancel"),
        ],
      ),
      await evaluate(
        new HookEvaluation(),
        "turn_end",
        { turnIndex: 1 },
        [hook("origin", "turn_end", "false"), watcher("report")],
      ),
    ];

    assert.deepEqual(
      cases.map((result) => {
        const requests = actionRows(result.executionReport);
        assert.equal(requests.length, 1);
        return requests[0]?.origin?.outcome;
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
        hook("passes", "turn_end", "true"),
        hook("fails", "turn_end", "false"),
        hookWithAction("first", "hook_result", { type: "interrupt" }),
        hookWithAction("second", "hook_result", {
          type: "emit-custom-event",
          name: "test:event",
          data: { value: 1 },
        }),
      ],
    );

    const actions = result.effects.filter((effect) => effect.type === "request-action");
    assert.deepEqual(actions.map((effect) => effect.hookRef), [
      "local/first",
      "local/second",
      "local/first",
      "local/second",
    ]);
    assert.deepEqual(
      actionRows(result.executionReport).map((row) =>
        row.origin?.hookRef
      ),
      ["local/passes", "local/passes", "local/fails", "local/fails"],
    );
    const eventAction = actions[1]?.action;
    assert.ok(eventAction && eventAction.type === "emit-custom-event");
    assert.ok(Object.isFrozen(eventAction));
    assert.ok(Object.isFrozen(eventAction.data));
  });

  it("exposes one ordered result-major report row sequence", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 2 },
      [
        hook("first", "turn_end", "true"),
        hookWithAction("steer", "turn_end", { type: "interrupt" }),
        hook("second", "turn_end", "false"),
        hook("after", "hook_result", "true"),
      ],
    );

    // For each originating Hook Result: its Hook row, owned Action row, then its
    // synthetic `hook_result` rows — one ordered sequence.
    const rows = result.executionReport?.rows ?? [];
    assert.deepEqual(
      rows.map((row) =>
        row.type === "hook"
          ? `a:${row.hookRef}`
          : `x:${row.hookRef}`
      ),
      [
        "a:local/first",  // origin 1
        "a:local/after",  // synthetic for origin 1
        "a:local/steer",  // origin 2
        "x:local/steer",  // its owned Action row directly after its Hook
        "a:local/after",  // synthetic for origin 2
        "a:local/second", // origin 3
        "a:local/after",  // synthetic for origin 3
      ],
    );
    // The owned Action row directly follows its owner's Hook row.
    const interruptIndex = rows.findIndex(
      (row) => row.type === "action" && row.hookRef === "local/steer",
    );
    assert.ok(interruptIndex > 0);
    assert.equal(rows[interruptIndex - 1]?.type, "hook");
    assert.equal(rows[interruptIndex - 1]?.hookRef, "local/steer");
  });

  it("measures a passing when plus shell in the reported duration", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [hook("slow-when", "tool_call", "true", { when: "sleep 0.06" })],
    );
    const row = hookRows(result.executionReport)[0];
    assert.ok(row, "a passing when still yields a Hook row");
    assert.ok(
      (row?.durationMs ?? 0) >= 50,
      "duration includes the passing when interval",
    );
  });
});

describe("synthetic hook_result phase", () => {
  it("awaits handlers in result-major, configured-handler order", async () => {
    const cwd = caseDirectory("synthetic-order");
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 2 },
      [
        hook("origin-pass", "turn_end", "true"),
        hook("origin-fail", "turn_end", "exit 7"),
        hook(
          "first",
          "hook_result",
          "sleep 0.02; printf 'first:%s\\n' \"$PI_EVENT_PAYLOAD\" >> order.log",
        ),
        hook(
          "second",
          "hook_result",
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

    const rows = result.executionReport?.rows ?? [];
    const executions = rows.filter(
      (row): row is Extract<EvaluationReportRow, { type: "hook" }> =>
        row.type === "hook",
    );
    assert.deepEqual(executions.map((row) => row.hookRef), [
      "local/origin-pass",
      "local/first",
      "local/second",
      "local/origin-fail",
      "local/first",
      "local/second",
    ]);
    // Synthetic handler rows carry the projected origin; they are interleaved
    // result-major (originating row, then its handlers).
    const synthetic = executions.filter((row) => row.origin !== undefined);
    assert.deepEqual(
      synthetic.map((row) => row.origin?.hookRef),
      [
        "local/origin-pass",
        "local/origin-pass",
        "local/origin-fail",
        "local/origin-fail",
      ],
    );
    assert.ok(Object.isFrozen(executions[1]?.origin));
  });

  it("matches hook refs by regex, outcomes exactly, and codes strictly", async () => {
    const cwd = caseDirectory("synthetic-filters");
    const result = await evaluate(
      new HookEvaluation(),
      "turn_end",
      { turnIndex: 1 },
      [
        hook("passes", "turn_end", "true"),
        hook("fails", "turn_end", "exit 7"),
        hook("matching", "hook_result", "printf 'match\\n' >> match.log", {
          filter: {
            hookRef: "^local/fails$",
            runId: "^[0-9a-f-]+$",
            outcome: "report",
            code: 7,
          },
        }),
        hook("not-regex", "hook_result", "touch bad", {
          filter: { outcome: "r.*" },
        }),
        hook("wrong-code", "hook_result", "touch bad", {
          filter: { code: 8 },
        }),
        hookWithAction("matching-action", "hook_result", { type: "interrupt" }, {
          filter: {
            hookRef: "^local/fails$",
            runId: "^[0-9a-f-]+$",
            outcome: "report",
            code: 7,
          },
        }),
        hookWithAction("wrong-action", "hook_result", { type: "shutdown" }, {
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
        .map((effect) => effect.hookRef),
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
        hook("origin", "tool_call", "true"),
        hook("handler", "hook_result", "touch handled"),
        hookWithAction("action", "hook_result", { type: "interrupt" }, {
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
        effect.type === "request-action" && effect.hookRef === "local/action"
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
        hook("origin", "tool_call", "true"),
        hook(
          "handler",
          "hook_result",
          "printf '%s|%s\\n' \"$PI_HOOK_RUN_ID\" \"$PI_EVENT_PAYLOAD\" > identities.log",
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
        hook("origin", "tool_call", "true"),
        hook("bad-filter", "hook_result", "true", {
          filter: { hookRef: "[" },
        }),
        hook("fails", "hook_result", "false"),
        hook("sibling", "hook_result", "touch sibling"),
        hookWithAction("bad-action-filter", "hook_result", { type: "interrupt" }, {
          filter: { hookRef: "[" },
        }),
        hookWithAction("action-sibling", "hook_result", { type: "shutdown" }),
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
    assert.match(presentationMessages(result)[2] ?? "", /1 hook_result hook failed/);
  });

  it("suppresses recursion when a result handler fails", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_call",
      toolCall,
      [
        hook("origin", "tool_call", "true"),
        hook("handler", "hook_result", "false"),
      ],
    );
    assert.equal(result.outcome, "pass");
    assert.equal(result.effects.length, 1);
    assert.match(presentationMessages(result)[0] ?? "", /hook_result hook failed/);
    assert.deepEqual(
      hookRows(result.executionReport).map((row) => ({
        hookRef: row.hookRef,
        origin: row.origin?.hookRef,
      })),
      [
        { hookRef: "local/origin", origin: undefined },
        { hookRef: "local/handler", origin: "local/origin" },
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
      [hook("tool", "tool_call", "true")],
    );

    const failing = [hook("clean", "agent_end", "false")];
    const first = await evaluate(evaluator, "agent_end", {}, failing);
    assert.equal(first.outcome, "report");
    assert.deepEqual(first.effects.map((effect) => effect.type), [
      "request-corrective-turn",
    ]);
    assert.deepEqual(
      hookRows(first.executionReport).map((row) => row.hookRef),
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
      [hook("clean", "agent_end", "true")],
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
        hook("tool", "tool_call", "true"),
        hookWithAction("tool-action", "tool_call", { type: "interrupt" }),
      ],
    );
    const end = await evaluate(
      evaluator,
      "agent_end",
      {},
      [
        hook("end", "agent_end", "true"),
        hookWithAction("end-action", "agent_end", { type: "shutdown" }),
      ],
    );
    assert.deepEqual(
      hookRows(tool.executionReport).map((row) => row.hookRef),
      ["local/tool", "local/tool-action"],
    );
    assert.deepEqual(
      hookRows(end.executionReport).map((row) => row.hookRef),
      ["local/end", "local/end-action"],
    );
    assert.deepEqual(
      actionRows(tool.executionReport).map((row) => row.hookRef),
      ["local/tool-action"],
    );
    assert.deepEqual(
      actionRows(end.executionReport).map((row) => row.hookRef),
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
          hook("a", "tool_call", waitFor("a.started", "b.started")),
          hookWithAction("action-a", "tool_call", { type: "interrupt" }),
        ],
        cwd,
      ),
      evaluate(
        evaluator,
        "tool_call",
        { ...toolCall, toolCallId: "parallel-b" },
        [
          hook("b", "tool_call", waitFor("b.started", "a.started")),
          hookWithAction("action-b", "tool_call", { type: "shutdown" }),
        ],
        cwd,
      ),
    ]);

    assert.equal(first.outcome, "pass");
    assert.equal(second.outcome, "pass");
    assert.deepEqual(
      hookRows(first.executionReport).map((row) => row.hookRef),
      ["local/a", "local/action-a"],
    );
    assert.deepEqual(
      hookRows(second.executionReport).map((row) => row.hookRef),
      ["local/b", "local/action-b"],
    );
    assert.deepEqual(
      actionRows(first.executionReport).map((row) => row.hookRef),
      ["local/action-a"],
    );
    assert.deepEqual(
      actionRows(second.executionReport).map((row) => row.hookRef),
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
        hook("completed", "tool_call", "true"),
        hook("crashes", "tool_call", "true", { filter: invalidFilter }),
        hook("later-sibling", "tool_call", "true"),
        hook(
          "handler",
          "hook_result",
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
    assert.match(records[0] ?? "", /"hookRef":"local\/completed"/);
    assert.match(records[1] ?? "", /"hookRef":"local\/later-sibling"/);
    assert.ok(!records.some((record) => record.includes("local/crashes")));
  });

  it("suppresses tool results", async () => {
    const result = await evaluate(
      new HookEvaluation(),
      "tool_result",
      toolResult,
      [hook("crashes", "tool_result", "true", { filter: invalidFilter })],
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
      [hook("crashes", "session_before_switch", "true", {
        filter: { reason: "[" },
      })],
    );
    assert.equal(switching.outcome, "cancel");

    const forking = await evaluate(
      evaluator,
      "session_before_fork",
      { entryId: "entry", position: "at" },
      [hook("crashes", "session_before_fork", "true", {
        filter: { position: "[" },
      })],
    );
    assert.equal(forking.outcome, "cancel");
  });

  it("turn and settled infrastructure errors become presentation feedback", async () => {
    for (const [kind, event] of [
      ["turn_end", { turnIndex: 1 }],
      ["agent_settled", {}],
    ] as const) {
      const result = await evaluate(
        new HookEvaluation(),
        kind,
        event,
        [hook("crashes", kind, "true", {
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
      [hook("crashes", "agent_end", "true", {
        filter: { event: "[" },
      })],
    );
    assert.equal(result.outcome, "report");
    assert.deepEqual(result.effects.map((effect) => effect.type), ["present"]);
    assert.match(presentationMessages(result)[0] ?? "", /failed to execute/);
  });
});
