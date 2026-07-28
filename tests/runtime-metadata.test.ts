import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getHookAdapter } from "../pi-assert/adapters.js";
import {
  buildEnv,
  buildLifecycleEnv,
  buildPiContextMetadataSnapshot,
  buildResultEnv,
  evaluateShell,
  type ExtensionContext,
  type ShellAssert,
} from "../pi-assert/engine.js";
import {
  dispatchAssertResults,
  executeHookAssertsWithResults,
  type AssertionResultRecord,
} from "../pi-assert/executor.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pi-assert-metadata-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function fullContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: root,
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionName: () => "metadata work",
      getLeafId: () => "leaf-456",
    },
    model: { provider: "anthropic", id: "claude-test" },
    thinkingLevel: "high",
    mode: "tui",
    isProjectTrusted: () => false,
    getContextUsage: () => ({
      tokens: 12_345,
      contextWindow: 200_000,
      percent: 6.1725,
    }),
    ...overrides,
  };
}

function shellAssertion(
  name: string,
  shell: string,
  extra: Partial<ShellAssert> = {},
): ShellAssert {
  return {
    name,
    source: "owner/rules",
    description: "test metadata",
    hook: "tool_call",
    shell,
    default: false,
    ...extra,
  };
}

describe("Pi context metadata snapshots", () => {
  it("adds identical bounded utility metadata to every environment builder", () => {
    const ctx = fullContext();
    const expected = {
      PI_SESSION_ID: "session-123",
      PI_SESSION_FILE: "/tmp/session.jsonl",
      PI_SESSION_NAME: "metadata work",
      PI_SESSION_LEAF_ID: "leaf-456",
      PI_PROVIDER: "anthropic",
      PI_MODEL: "claude-test",
      PI_REASONING_LEVEL: "high",
      PI_MODE: "tui",
      PI_PROJECT_TRUSTED: "false",
      PI_CONTEXT_TOKENS: "12345",
      PI_CONTEXT_WINDOW: "200000",
      PI_CONTEXT_PERCENT: "6.1725",
    };

    const snapshot = buildPiContextMetadataSnapshot(ctx);
    assert.ok(Object.isFrozen(snapshot));
    assert.deepStrictEqual(snapshot, expected);

    const snapshottedCtx: ExtensionContext = { cwd: root, metadataSnapshot: snapshot };
    const tool = buildEnv(
      { toolName: "bash", toolCallId: "call-1", input: { command: "true" } },
      snapshottedCtx,
    );
    const result = buildResultEnv(
      {
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: "true" },
        content: [],
        isError: false,
      },
      snapshottedCtx,
    );
    const lifecycle = buildLifecycleEnv(
      "turn_end",
      { event: "turn_end", turnIndex: 1 },
      snapshottedCtx,
    );

    for (const env of [tool, result, lifecycle]) {
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(env[key], value, `${key} missing from environment`);
      }
    }
    assert.equal(tool.PI_EVENT, "tool_call");
    assert.equal(result.PI_EVENT, "tool_result");
    assert.equal(lifecycle.PI_EVENT, "turn_end");
  });

  it("falls back to the ExtensionAPI thinking-level seam", () => {
    let reads = 0;
    const snapshot = buildPiContextMetadataSnapshot({
      cwd: root,
      getThinkingLevel: () => {
        reads++;
        return "xhigh";
      },
    });

    assert.deepStrictEqual(snapshot, { PI_REASONING_LEVEL: "xhigh" });
    assert.equal(reads, 1);
  });

  it("omits unavailable optional values while preserving known zero/false values", () => {
    const snapshot = buildPiContextMetadataSnapshot({
      cwd: root,
      sessionManager: {
        getSessionId: () => "ephemeral-id",
        getSessionFile: () => undefined,
        getSessionName: () => undefined,
        getLeafId: () => null,
      },
      mode: "print",
      isProjectTrusted: () => false,
      getContextUsage: () => ({ tokens: 0, contextWindow: 128_000, percent: 0 }),
    });

    assert.deepStrictEqual(snapshot, {
      PI_SESSION_ID: "ephemeral-id",
      PI_MODE: "print",
      PI_PROJECT_TRUSTED: "false",
      PI_CONTEXT_TOKENS: "0",
      PI_CONTEXT_WINDOW: "128000",
      PI_CONTEXT_PERCENT: "0",
    });
    for (const key of [
      "PI_SESSION_FILE",
      "PI_SESSION_NAME",
      "PI_SESSION_LEAF_ID",
      "PI_PROVIDER",
      "PI_MODEL",
      "PI_REASONING_LEVEL",
    ]) {
      assert.equal(key in snapshot, false, `${key} should be unset`);
    }
  });

  it("keeps known context windows while omitting unknown token and percent usage", () => {
    const unknownUsage = buildPiContextMetadataSnapshot({
      cwd: root,
      getContextUsage: () => ({ tokens: null, contextWindow: 64_000, percent: null }),
    });
    assert.deepStrictEqual(unknownUsage, { PI_CONTEXT_WINDOW: "64000" });

    assert.deepStrictEqual(buildPiContextMetadataSnapshot({ cwd: root }), {});
  });
});

describe("executing assertion identity", () => {
  it("reuses one metadata snapshot and UUID for when and shell", async () => {
    let usageReads = 0;
    const ctx = fullContext({
      getContextUsage: () => {
        usageReads++;
        return { tokens: 100, contextWindow: 1_000, percent: 10 };
      },
    });
    const printIdentity =
      "printf '%s|%s|%s|%s|%s|%s\\n' \"$PI_ASSERT_REF\" \"$PI_ASSERT_HOOK\" \"$PI_ASSERT_RUN_ID\" \"$PI_EVENT\" \"$PI_SESSION_ID\" \"$PI_CONTEXT_TOKENS\"";
    const rule = shellAssertion("identity", `${printIdentity} > shell.log`, {
      when: `${printIdentity} > when.log`,
    });

    const first = await executeHookAssertsWithResults(
      [rule],
      getHookAdapter("tool_call"),
      { toolName: "bash", toolCallId: "call-1", input: { command: "true" } },
      ctx,
    );

    const whenIdentity = readFileSync(join(root, "when.log"), "utf8").trim();
    const shellIdentity = readFileSync(join(root, "shell.log"), "utf8").trim();
    assert.equal(shellIdentity, whenIdentity);
    const [ref, hook, runId, event, sessionId, tokens] = shellIdentity.split("|");
    assert.equal(ref, "owner/rules/identity");
    assert.equal(hook, "tool_call");
    assert.match(runId!, UUID_PATTERN);
    assert.equal(event, "tool_call");
    assert.equal(sessionId, "session-123");
    assert.equal(tokens, "100");
    assert.equal(first.results[0]?.runId, runId);
    assert.equal(usageReads, 1);

    const second = await executeHookAssertsWithResults(
      [rule],
      getHookAdapter("tool_call"),
      { toolName: "bash", toolCallId: "call-1", input: { command: "true" } },
      ctx,
    );
    assert.match(second.results[0]!.runId, UUID_PATTERN);
    assert.notEqual(second.results[0]!.runId, first.results[0]!.runId);
  });

  it("uses distinct run IDs for separate matching assertions", async () => {
    const execution = await executeHookAssertsWithResults(
      [
        shellAssertion("one", "true"),
        shellAssertion("two", "true"),
      ],
      getHookAdapter("tool_call"),
      { toolName: "bash", toolCallId: "call-2", input: { command: "true" } },
      fullContext(),
    );

    assert.equal(execution.results.length, 2);
    assert.match(execution.results[0]!.runId, UUID_PATTERN);
    assert.match(execution.results[1]!.runId, UUID_PATTERN);
    assert.notEqual(execution.results[0]!.runId, execution.results[1]!.runId);
  });
});

describe("managed inherited environment", () => {
  it("removes stale managed values while inheriting unrelated process markers", async () => {
    const keys = [
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
      "PI_PROVIDER",
      "PI_MODEL",
      "PI_CONTEXT_TOKENS",
      "PI_ASSERT_RUN_ID",
      "PI_EVENT_PAYLOAD",
      "PI_TOOL_RESULT",
      "PI_CODING_AGENT",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) process.env[key] = "stale-parent";
      process.env.PI_CODING_AGENT = "true";

      const result = await evaluateShell(
        "test \"$PI_SESSION_ID\" = current-session && " +
          "test -z \"${PI_SESSION_FILE+x}\" && " +
          "test -z \"${PI_PROVIDER+x}\" && " +
          "test -z \"${PI_MODEL+x}\" && " +
          "test -z \"${PI_CONTEXT_TOKENS+x}\" && " +
          "test -z \"${PI_ASSERT_RUN_ID+x}\" && " +
          "test -z \"${PI_EVENT_PAYLOAD+x}\" && " +
          "test -z \"${PI_TOOL_RESULT+x}\" && " +
          "test \"$PI_CODING_AGENT\" = true",
        { PI_SESSION_ID: "current-session" },
      );
      assert.ok(result.passed);
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("assert_result origin and handler metadata", () => {
  it("carries origin runId while giving a detached handler its own identity", async () => {
    let sessionReads = 0;
    let usageReads = 0;
    const controller = new AbortController();
    controller.abort();
    const ctx: ExtensionContext = {
      cwd: root,
      signal: controller.signal,
      sessionManager: {
        getSessionId: () => {
          sessionReads++;
          return "detached-session";
        },
        getSessionFile: () => undefined,
        getSessionName: () => undefined,
        getLeafId: () => null,
      },
      mode: "json",
      isProjectTrusted: () => true,
      getContextUsage: () => {
        usageReads++;
        return { tokens: 50, contextWindow: 500, percent: 10 };
      },
    };
    const originRunId = "00000000-0000-4000-8000-000000000099";
    const origin: AssertionResultRecord = {
      event: "assert_result",
      assertionRef: "owner/rules/origin",
      runId: originRunId,
      outcome: "block",
      code: 9,
    };
    const handler = shellAssertion(
      "handler",
      "printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' " +
        "\"$PI_ASSERT_REF\" \"$PI_ASSERT_HOOK\" \"$PI_ASSERT_RUN_ID\" " +
        "\"$PI_EVENT\" \"$PI_EVENT_PAYLOAD\" \"$PI_SESSION_ID\" > handler.log",
      { hook: "assert_result", source: "local" },
    );

    await dispatchAssertResults([handler], [origin], ctx);

    const [handlerRef, handlerHook, handlerRunId, event, payload, sessionId] =
      readFileSync(join(root, "handler.log"), "utf8").trim().split("\n");
    assert.equal(handlerRef, "local/handler");
    assert.equal(handlerHook, "assert_result");
    assert.match(handlerRunId!, UUID_PATTERN);
    assert.notEqual(handlerRunId, originRunId);
    assert.equal(event, "assert_result");
    assert.deepStrictEqual(JSON.parse(payload!), origin);
    assert.equal(sessionId, "detached-session");
    assert.equal(sessionReads, 1);
    assert.equal(usageReads, 1);
  });
});
