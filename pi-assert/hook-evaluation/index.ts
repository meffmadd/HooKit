import { entryRef, type AssertResultEvent, type NativeHook } from "../domain/entry.js";
import type { ActiveAssertion } from "./assertions.js";
import {
  assertionsIn,
  type ActiveAssertionSet,
} from "./active-set.js";
import {
  adapterFor,
  formatErrorDetail,
  type AdapterOutcome,
  type HookAdapter,
} from "./adapters.js";
import { invokeAssertions } from "./invocations.js";
import type {
  AssertionExecution,
  AssertionExecutionReport,
  EvaluationEffect,
  EvaluationEventMap,
  HookEvaluationResult,
  HookEventMap,
  HookExecutionContext,
  RuntimeMetadataSnapshot,
  ToolResultPatch,
} from "./types.js";

export { createActiveAssertionSet } from "./active-set.js";
export type { ActiveAssertionSet } from "./active-set.js";
export type { ActiveAssertion } from "./assertions.js";
export type {
  AgentEndEvent,
  AgentSettledEvent,
  AssertionExecution,
  AssertionExecutionReport,
  BlockEvaluationResult,
  CancelEvaluationResult,
  EvaluationEffect,
  HookEvaluationResult,
  HookEvaluationResultMap,
  HookEventMap,
  HookExecutionContext,
  OriginatingAssertionResult,
  PassEvaluationResult,
  PatchEvaluationResult,
  PresentationSeverity,
  ReportEvaluationResult,
  RuntimeMetadataSnapshot,
  SessionBeforeForkEvent,
  SessionBeforeSwitchEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultPatch,
  TurnEndEvent,
} from "./types.js";

function present(
  message: string,
  severity: "info" | "warning" | "error",
): EvaluationEffect {
  return { type: "present", message, severity };
}

function snapshotContext(context: HookExecutionContext): HookExecutionContext {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(context.metadata)) {
    if (typeof value === "string") values[key] = value;
  }
  const metadata = Object.freeze(values) as RuntimeMetadataSnapshot;
  return Object.freeze({
    cwd: context.cwd,
    signal: context.signal,
    metadata,
  });
}

function freezePatch(patch: ToolResultPatch): ToolResultPatch {
  const content = patch.content === undefined
    ? undefined
    : Object.freeze(patch.content.map((block) => Object.freeze({ ...block })));
  return Object.freeze({
    ...(content === undefined ? {} : { content }),
    ...(Object.prototype.hasOwnProperty.call(patch, "details")
      ? { details: patch.details }
      : {}),
    ...(patch.isError === undefined ? {} : { isError: patch.isError }),
  });
}

function freezeOutcome(outcome: AdapterOutcome): AdapterOutcome {
  const failures = Object.freeze(outcome.failures.map((failure) => Object.freeze({
    ...failure,
    result: Object.freeze({ ...failure.result }),
  })));
  const messages = Object.freeze([...outcome.messages]);
  const base = { ...outcome, failures, messages };
  if (outcome.action === "patch") {
    return Object.freeze({ ...base, patch: freezePatch(outcome.patch) });
  }
  return Object.freeze(base) as AdapterOutcome;
}

function freezeResults(
  results: readonly AssertResultEvent[],
): readonly AssertResultEvent[] {
  return Object.freeze(results.map((result) => Object.freeze({ ...result })));
}

function freezeExecutionReport(
  executions: readonly AssertionExecution[],
): AssertionExecutionReport | undefined {
  if (executions.length === 0) return undefined;
  const frozenExecutions = Object.freeze(executions.map((execution) => {
    const originatingResult = execution.originatingResult === undefined
      ? undefined
      : Object.freeze({
        assertionRef: execution.originatingResult.assertionRef,
        runId: execution.originatingResult.runId,
        outcome: execution.originatingResult.outcome,
      });
    return Object.freeze({
      assertionRef: execution.assertionRef,
      runId: execution.runId,
      hook: execution.hook,
      durationMs: execution.durationMs,
      passed: execution.passed,
      ...(originatingResult === undefined ? {} : { originatingResult }),
    });
  }));
  return Object.freeze({ executions: frozenExecutions });
}

function handlerErrorMessage(assertion: ActiveAssertion, error: unknown): string {
  return `pi-assert: assert_result handler "${
    entryRef(assertion.source, assertion.name)
  }" failed to execute — ${formatErrorDetail(error)}`;
}

function publicResult(
  outcome: AdapterOutcome | undefined,
  pendingEffects: EvaluationEffect[],
  executionReport?: AssertionExecutionReport,
): HookEvaluationResult {
  const effects = Object.freeze(
    pendingEffects.map((effect) => Object.freeze({ ...effect })),
  );
  const reporting = executionReport === undefined ? {} : { executionReport };
  if (!outcome) {
    return Object.freeze({ outcome: "pass", effects, ...reporting });
  }

  switch (outcome.action) {
    case "block":
      return Object.freeze({
        outcome: "block",
        reason: outcome.reason,
        effects,
        ...reporting,
      });
    case "patch":
      return Object.freeze({
        outcome: "patch",
        reason: outcome.reason,
        patch: outcome.patch,
        effects,
        ...reporting,
      });
    case "cancel":
      return Object.freeze({
        outcome: "cancel",
        reason: outcome.reason,
        effects,
        ...reporting,
      });
    case "report":
      return Object.freeze({ outcome: "report", effects, ...reporting });
  }
}

/**
 * Session-scoped owner of the complete transaction for one native hook event.
 * Pi-specific callback translation and effect delivery stay outside this module.
 */
export class HookEvaluation {
  private correctiveFingerprints = new Map<NativeHook, string>();

  /**
   * Evaluate one native event against one captured Active Assertion Set.
   * Valid typed requests always resolve; internal failures become fail-closed
   * hook-specific outcomes.
   */
  async evaluate<H extends NativeHook>(
    hook: H,
    event: HookEventMap[H],
    context: HookExecutionContext,
    activeSet: ActiveAssertionSet,
  ): Promise<HookEvaluationResult<H>> {
    let adapter: HookAdapter<EvaluationEventMap[H]> | undefined;
    try {
      adapter = adapterFor(hook);
      const assertions = assertionsIn(activeSet);
      const capturedContext = snapshotContext(context);
      return await this.evaluateTransaction(
        hook,
        event as EvaluationEventMap[H],
        capturedContext,
        assertions,
        adapter,
      );
    } catch (error) {
      // This outer boundary is the final guarantee that a valid request does
      // not reject even if transaction setup itself fails unexpectedly.
      const fallbackAdapter = adapter ?? adapterFor(hook);
      const outcome = freezeOutcome(
        fallbackAdapter.internalError(error, event as EvaluationEventMap[H]),
      );
      const effects: EvaluationEffect[] = [];
      this.appendOriginFeedback(hook, fallbackAdapter, outcome, effects);
      return publicResult(outcome, effects) as HookEvaluationResult<H>;
    }
  }

  private async evaluateTransaction<H extends NativeHook>(
    hook: H,
    event: EvaluationEventMap[H],
    context: HookExecutionContext,
    assertions: readonly ActiveAssertion[],
    adapter: HookAdapter<EvaluationEventMap[H]>,
  ): Promise<HookEvaluationResult<H>> {
    const invocation = await invokeAssertions(
      assertions,
      adapter,
      event,
      context,
    );

    let rawOutcome: AdapterOutcome | undefined;
    try {
      rawOutcome = invocation.unexpectedError === undefined
        ? invocation.failures.length === 0
          ? undefined
          : adapter.outcome(invocation.failures, event)
        : adapter.internalError(invocation.unexpectedError, event);
    } catch (error) {
      // Formatting/aggregation is still part of originating evaluation. Keep
      // completed records, replace partial policy output with one generic
      // fail-closed decision, and continue into synthetic dispatch.
      rawOutcome = adapter.internalError(error, event);
    }
    const outcome = rawOutcome === undefined ? undefined : freezeOutcome(rawOutcome);
    const results = freezeResults(invocation.results);

    // The originating decision and result events are frozen before this
    // awaited, detached phase starts. Handler behavior cannot change it.
    const synthetic = await this.dispatchSyntheticResults(
      assertions,
      results,
      context,
    );
    const executionReport = freezeExecutionReport([
      ...invocation.executions,
      ...synthetic.executions,
    ]);
    this.appendOriginFeedback(hook, adapter, outcome, synthetic.effects);
    return publicResult(
      outcome,
      synthetic.effects,
      executionReport,
    ) as HookEvaluationResult<H>;
  }

  private async dispatchSyntheticResults(
    assertions: readonly ActiveAssertion[],
    results: readonly AssertResultEvent[],
    context: HookExecutionContext,
  ): Promise<{
    effects: EvaluationEffect[];
    executions: AssertionExecution[];
  }> {
    const effects: EvaluationEffect[] = [];
    const executions: AssertionExecution[] = [];
    const adapter = adapterFor("assert_result");
    const detachedContext: HookExecutionContext = Object.freeze({
      cwd: context.cwd,
      metadata: context.metadata,
    });

    for (const result of results) {
      try {
        const invocation = await invokeAssertions(
          assertions,
          adapter,
          result,
          detachedContext,
          {
            originatingResult: result,
            continueAfterUnexpected: (handler, error) => {
              effects.push(present(handlerErrorMessage(handler, error), "error"));
            },
          },
        );
        executions.push(...invocation.executions);
        if (invocation.unexpectedError !== undefined) {
          effects.push(present(
            `pi-assert: assert_result dispatch for "${result.assertionRef}" failed — ${
              formatErrorDetail(invocation.unexpectedError)
            }`,
            "error",
          ));
          continue;
        }
        if (invocation.failures.length > 0) {
          const handlerOutcome = adapter.outcome(invocation.failures, result);
          effects.push(present(handlerOutcome.feedbackMessage, "error"));
        }
      } catch (error) {
        // Synthetic infrastructure is isolated from the frozen origin and the
        // next result still dispatches.
        effects.push(present(
          `pi-assert: assert_result dispatch for "${result.assertionRef}" failed — ${
            formatErrorDetail(error)
          }`,
          "error",
        ));
      }
    }
    return { effects, executions };
  }

  private appendOriginFeedback<E>(
    hook: NativeHook,
    adapter: HookAdapter<E>,
    outcome: AdapterOutcome | undefined,
    effects: EvaluationEffect[],
  ): void {
    if (!outcome) {
      if (adapter.feedback === "corrective-turn") {
        this.correctiveFingerprints.delete(hook);
      }
      return;
    }

    // Native control outcomes carry their reason/patch to the Pi adapter,
    // which owns native display and callback translation.
    if (outcome.action !== "report") return;

    if (outcome.infrastructureError || adapter.feedback === "present-error") {
      if (adapter.feedback === "corrective-turn") {
        this.correctiveFingerprints.delete(hook);
      }
      effects.push(present(outcome.feedbackMessage, "error"));
      return;
    }

    const fingerprint = outcome.fingerprint ?? outcome.messages.join("\n");
    if (this.correctiveFingerprints.get(hook) === fingerprint) {
      effects.push(present(
        outcome.repeatedFeedbackMessage ??
          "pi-assert: assertions still fail; automatic retry stopped.",
        "error",
      ));
      return;
    }

    this.correctiveFingerprints.set(hook, fingerprint);
    effects.push({
      type: "request-corrective-turn",
      message: outcome.feedbackMessage,
    });
  }
}
