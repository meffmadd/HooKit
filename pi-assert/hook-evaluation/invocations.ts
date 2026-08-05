import { randomUUID } from "node:crypto";
import { entryRef } from "../domain/entry.js";
import type { ActiveAssertion } from "./assertions.js";
import type {
  AssertionFailure,
  HookAdapter,
} from "./adapters.js";
import { matchFilter } from "./environment.js";
import { evaluateShell } from "./shell.js";
import type {
  AssertionExecution,
  AssertionResult,
  HookExecutionContext,
  OriginatingAssertionResult,
} from "./types.js";

export interface InvocationError {
  readonly assertion: ActiveAssertion;
  readonly error: unknown;
}

export interface InvocationBatch {
  readonly executions: AssertionExecution[];
  readonly failures: AssertionFailure[];
  readonly results: AssertionResult[];
  readonly unexpectedErrors: InvocationError[];
}

interface InvocationOptions {
  readonly originatingResult?: OriginatingAssertionResult;
}

export function invocationEnvironment<E>(
  assertion: Pick<ActiveAssertion, "source" | "name" | "hook">,
  runId: string,
  adapter: HookAdapter<E>,
  event: E,
  context: HookExecutionContext,
): Record<string, string> {
  return {
    ...adapter.buildEnvironment(event, context),
    PI_ASSERT_REF: entryRef(assertion.source, assertion.name),
    PI_ASSERT_HOOK: assertion.hook,
    PI_ASSERT_RUN_ID: runId,
    PI_EVENT: adapter.hook,
  };
}

function assertionResult(
  assertion: ActiveAssertion,
  runId: string,
  outcome: AssertionResult["outcome"],
  code: number | null,
  originatingResult: OriginatingAssertionResult | undefined,
): AssertionResult {
  return {
    event: "assert_result",
    assertionRef: entryRef(assertion.source, assertion.name),
    runId,
    hook: assertion.hook,
    outcome,
    code,
    ...(assertion.action === undefined ? {} : { action: assertion.action }),
    ...(originatingResult === undefined ? {} : { originatingResult }),
  };
}

/** Execute Assertion Invocations sequentially in deterministic set order. */
export async function invokeAssertions<E>(
  assertions: readonly ActiveAssertion[],
  adapter: HookAdapter<E>,
  event: E,
  context: HookExecutionContext,
  options: InvocationOptions = {},
): Promise<InvocationBatch> {
  if (adapter.skipAssertionsIfAborted && context.signal?.aborted) {
    return {
      executions: [],
      failures: [],
      results: [],
      unexpectedErrors: [],
    };
  }

  const executions: AssertionExecution[] = [];
  const failures: AssertionFailure[] = [];
  const results: AssertionResult[] = [];
  const unexpectedErrors: InvocationError[] = [];

  for (const assertion of assertions) {
    if (assertion.hook !== adapter.hook) continue;

    try {
      const matches = adapter.matchesFilter ?? matchFilter;
      if (!matches(assertion.filter, adapter.candidate(event))) continue;

      const runId = randomUUID();
      const env = invocationEnvironment(
        assertion,
        runId,
        adapter,
        event,
        context,
      );

      if (assertion.when) {
        const whenResult = await evaluateShell(
          assertion.when,
          env,
          context.signal,
          context.cwd,
        );
        if (whenResult.code === null) {
          failures.push({
            assertion,
            phase: "when",
            command: assertion.when,
            result: whenResult,
          });
          results.push(assertionResult(
            assertion,
            runId,
            adapter.failureAction,
            null,
            options.originatingResult,
          ));
          continue;
        }
        if (!whenResult.passed) continue;
      }

      const startedAt = Date.now();
      const shellResult = await evaluateShell(
        assertion.shell,
        env,
        context.signal,
        context.cwd,
      );
      if (shellResult.started) {
        executions.push({
          assertionRef: entryRef(assertion.source, assertion.name),
          runId,
          hook: assertion.hook,
          durationMs: Math.max(0, Date.now() - startedAt),
          passed: shellResult.passed,
          ...(options.originatingResult === undefined
            ? {}
            : { originatingResult: options.originatingResult }),
        });
      }

      results.push(assertionResult(
        assertion,
        runId,
        shellResult.passed ? "pass" : adapter.failureAction,
        shellResult.code,
        options.originatingResult,
      ));

      if (!shellResult.passed) {
        failures.push({
          assertion,
          phase: "shell",
          command: assertion.shell,
          result: shellResult,
        });
      }
    } catch (error) {
      // A broken Assertion has no invented result or Action, but cannot stop
      // deterministic sibling traversal.
      unexpectedErrors.push({ assertion, error });
    }
  }

  return { executions, failures, results, unexpectedErrors };
}
