import { randomUUID } from "node:crypto";
import { entryRef } from "../domain/entry.js";
import type { ActiveHook } from "./hooks.js";
import type {
  HookFailure,
  EventAdapter,
} from "./adapters.js";
import { matchFilter } from "./environment.js";
import { evaluateShell } from "./shell.js";
import type {
  HookResult,
  EvaluationContext,
  OriginatingHookResult,
} from "./types.js";

export interface InvocationError {
  readonly hook: ActiveHook;
  readonly error: unknown;
}

/** Execution accounting for one started main Hook shell. */
export interface StartedHookExecution {
  /** Individual Hook duration: passing `when` (if any) plus main `shell`. */
  readonly durationMs: number;
  readonly passed: boolean;
}

/**
 * One Invocation, pairing the immutable Hook Result with the optional
 * accounting of its started main shell. A `when`/`shell` infrastructure
 * failure produces a result record without `execution` so its owned Action
 * can still select; an ordinary non-zero `when` produces no record at all.
 */
export interface HookInvocationRecord {
  readonly result: HookResult;
  readonly execution?: StartedHookExecution;
}

export interface InvocationBatch {
  readonly invocations: readonly HookInvocationRecord[];
  readonly failures: readonly HookFailure[];
  readonly unexpectedErrors: readonly InvocationError[];
}

interface InvocationOptions {
  readonly originatingResult?: OriginatingHookResult;
}

export function invocationEnvironment<E>(
  hook: Pick<ActiveHook, "source" | "name" | "event">,
  runId: string,
  adapter: EventAdapter<E>,
  event: E,
  context: EvaluationContext,
): Record<string, string> {
  return {
    ...adapter.buildEnvironment(event, context),
    PI_HOOK_REF: entryRef(hook.source, hook.name),
    PI_HOOK_EVENT: hook.event,
    PI_HOOK_RUN_ID: runId,
    PI_EVENT: adapter.event,
  };
}

function hookResult(
  hook: ActiveHook,
  runId: string,
  outcome: HookResult["outcome"],
  code: number | null,
  originatingResult: OriginatingHookResult | undefined,
): HookResult {
  return Object.freeze({
    event: "hook_result",
    hookRef: entryRef(hook.source, hook.name),
    runId,
    evaluatedEvent: hook.event,
    outcome,
    code,
    // Catalog-owned Actions and originating Hook Results are already
    // immutable, so the result can retain those references directly.
    ...(hook.action === undefined ? {} : { action: hook.action }),
    ...(originatingResult === undefined ? {} : { originatingResult }),
  });
}

/** Execute Hook Invocations sequentially in deterministic set order. */
export async function invokeHooks<E>(
  hooks: readonly ActiveHook[],
  adapter: EventAdapter<E>,
  event: E,
  context: EvaluationContext,
  options: InvocationOptions = {},
): Promise<InvocationBatch> {
  if (adapter.skipHooksIfAborted && context.signal?.aborted) {
    return {
      invocations: [],
      failures: [],
      unexpectedErrors: [],
    };
  }

  const invocations: HookInvocationRecord[] = [];
  const failures: HookFailure[] = [];
  const unexpectedErrors: InvocationError[] = [];

  for (const hook of hooks) {
    if (hook.event !== adapter.event) continue;

    try {
      const matches = adapter.matchesFilter ?? matchFilter;
      if (!matches(hook.filter, adapter.candidate(event))) continue;

      const runId = randomUUID();
      const env = invocationEnvironment(
        hook,
        runId,
        adapter,
        event,
        context,
      );

      // Individual Hook duration starts immediately before the optional
      // `when`; a passing `when` contributes to the main row's duration.
      const startedAt = Date.now();

      if (hook.when) {
        const whenResult = await evaluateShell(
          hook.when,
          env,
          context.signal,
          context.cwd,
        );
        if (whenResult.code === null) {
          failures.push({
            hook,
            phase: "when",
            command: hook.when,
            result: whenResult,
          });
          invocations.push({
            result: hookResult(
              hook,
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
        hook.shell,
        env,
        context.signal,
        context.cwd,
      );
      invocations.push({
        result: hookResult(
          hook,
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
          hook,
          phase: "shell",
          command: hook.shell,
          result: shellResult,
        });
      }
    } catch (error) {
      // A broken Hook has no invented result or Action, but cannot stop
      // deterministic sibling traversal.
      unexpectedErrors.push({ hook, error });
    }
  }

  return { invocations, failures, unexpectedErrors };
}
