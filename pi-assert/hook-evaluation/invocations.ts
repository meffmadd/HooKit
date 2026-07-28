import { randomUUID } from "node:crypto";
import { entryRef, type AssertResultEvent } from "../domain/entry.js";
import type { ActiveAssertion } from "./assertions.js";
import type {
  AssertionFailure,
  HookAdapter,
} from "./adapters.js";
import { matchFilter } from "./environment.js";
import { evaluateShell } from "./shell.js";
import type { HookExecutionContext } from "./types.js";

export interface ExecutionRecord {
  readonly name: string;
  readonly hook: string;
  readonly durationMs: number;
  readonly passed: boolean;
}

export interface InvocationBatch {
  readonly failures: AssertionFailure[];
  readonly results: AssertResultEvent[];
  readonly unexpectedError?: unknown;
}

interface InvocationOptions {
  readonly onExecution?: (record: ExecutionRecord) => void;
  readonly continueAfterUnexpected?: (
    assertion: ActiveAssertion,
    error: unknown,
  ) => void | Promise<void>;
}

function assertionResult(
  assertion: ActiveAssertion,
  runId: string,
  outcome: AssertResultEvent["outcome"],
  code: number | null,
): AssertResultEvent {
  return {
    event: "assert_result",
    assertionRef: entryRef(assertion.source, assertion.name),
    runId,
    outcome,
    code,
  };
}

/** Execute configured Assertion Invocations in deterministic assertion order. */
export async function invokeAssertions<E>(
  assertions: readonly ActiveAssertion[],
  adapter: HookAdapter<E>,
  event: E,
  context: HookExecutionContext,
  options: InvocationOptions = {},
): Promise<InvocationBatch> {
  if (adapter.skipIfAborted && context.signal?.aborted) {
    return { failures: [], results: [] };
  }

  const failures: AssertionFailure[] = [];
  const results: AssertResultEvent[] = [];
  const emitsResults = adapter.hook !== "assert_result";

  for (const assertion of assertions) {
    if (assertion.hook !== adapter.hook) continue;

    try {
      const candidate = adapter.candidate(event);
      const matches = adapter.matchesFilter ?? matchFilter;
      if (!matches(assertion.filter, candidate)) continue;

      const runId = randomUUID();
      const env = {
        ...adapter.buildEnvironment(event, context),
        PI_ASSERT_REF: entryRef(assertion.source, assertion.name),
        PI_ASSERT_HOOK: assertion.hook,
        PI_ASSERT_RUN_ID: runId,
        PI_EVENT: adapter.hook,
      };

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
          if (emitsResults) {
            results.push(assertionResult(
              assertion,
              runId,
              adapter.failureAction,
              null,
            ));
          }
          if (adapter.aggregation === "first") {
            return { failures, results };
          }
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
      options.onExecution?.({
        name: assertion.name,
        hook: adapter.hook,
        durationMs: Date.now() - startedAt,
        passed: shellResult.passed,
      });

      if (emitsResults) {
        results.push(assertionResult(
          assertion,
          runId,
          shellResult.passed ? "pass" : adapter.failureAction,
          shellResult.code,
        ));
      }

      if (!shellResult.passed) {
        failures.push({
          assertion,
          phase: "shell",
          command: assertion.shell,
          result: shellResult,
        });
        if (adapter.aggregation === "first") return { failures, results };
      }
    } catch (error) {
      if (!options.continueAfterUnexpected) {
        return { failures, results, unexpectedError: error };
      }
      try {
        await options.continueAfterUnexpected(assertion, error);
      } catch {
        // Handler-error presentation is best-effort and siblings still run.
      }
    }
  }

  return { failures, results };
}
