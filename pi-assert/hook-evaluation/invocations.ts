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
  AssertionResult,
  HookExecutionContext,
  OriginatingAssertionResult,
} from "./types.js";

export interface InvocationError {
  readonly assertion: ActiveAssertion;
  readonly error: unknown;
}

/** Execution accounting for one started main Assertion shell. */
export interface StartedAssertionExecution {
  /** Individual Assertion duration: passing `when` (if any) plus main `shell`. */
  readonly durationMs: number;
  readonly passed: boolean;
}

/**
 * One Invocation, pairing the immutable Assertion Result with the optional
 * accounting of its started main shell. A `when`/`shell` infrastructure
 * failure produces a result record without `execution` so its owned Action
 * can still select; an ordinary non-zero `when` produces no record at all.
 */
export interface AssertionInvocationRecord {
  readonly result: AssertionResult;
  readonly execution?: StartedAssertionExecution;
}

export interface InvocationBatch {
  readonly invocations: readonly AssertionInvocationRecord[];
  readonly failures: readonly AssertionFailure[];
  readonly unexpectedErrors: readonly InvocationError[];
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
  return Object.freeze({
    event: "assert_result",
    assertionRef: entryRef(assertion.source, assertion.name),
    runId,
    hook: assertion.hook,
    outcome,
    code,
    // Catalog-owned Actions and originating native results are already
    // immutable, so the result can retain those references directly.
    ...(assertion.action === undefined ? {} : { action: assertion.action }),
    ...(originatingResult === undefined ? {} : { originatingResult }),
  });
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
      invocations: [],
      failures: [],
      unexpectedErrors: [],
    };
  }

  const invocations: AssertionInvocationRecord[] = [];
  const failures: AssertionFailure[] = [];
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

      // Individual Assertion duration starts immediately before the optional
      // `when`; a passing `when` contributes to the main row's duration.
      const startedAt = Date.now();

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
          invocations.push({
            result: assertionResult(
              assertion,
              runId,
              adapter.failureAction,
              null,
              options.originatingResult,
            ),
          });
          continue;
        }
        if (!whenResult.passed) continue;
      }

      const shellResult = await evaluateShell(
        assertion.shell,
        env,
        context.signal,
        context.cwd,
      );
      invocations.push({
        result: assertionResult(
          assertion,
          runId,
          shellResult.passed ? "pass" : adapter.failureAction,
          shellResult.code,
          options.originatingResult,
        ),
        ...(shellResult.started
          ? {
              execution: {
                durationMs: Math.max(0, Date.now() - startedAt),
                passed: shellResult.passed,
              },
            }
          : {}),
      });

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

  return { invocations, failures, unexpectedErrors };
}
