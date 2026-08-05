import { entryRef, type NativeHook } from "../domain/entry.js";
import type { ActiveAssertion } from "./assertions.js";
import {
  assertionsIn,
  type ActiveAssertionSet,
} from "./active-set.js";
import {
  adapterFor,
  formatErrorDetail,
  type AdapterOutcome,
  type AssertionFailure,
  type HookAdapter,
} from "./adapters.js";
import { requestOwnedAction } from "./actions.js";
import { invokeAssertions, type InvocationError } from "./invocations.js";
import type {
  ActionRequestExecution,
  AssertionExecution,
  AssertionExecutionReport,
  AssertionResult,
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
  ActionRequestExecution,
  AgentEndEvent,
  AgentSettledEvent,
  AssertionExecution,
  AssertionExecutionReport,
  AssertionResult,
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

function freezeNested<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) freezeNested(nested);
  return Object.freeze(value);
}

function freezeOrigin(
  origin: ActionRequestExecution["originatingResult"],
) {
  return origin === undefined
    ? undefined
    : Object.freeze({
        assertionRef: origin.assertionRef,
        runId: origin.runId,
        outcome: origin.outcome,
      });
}

function freezeResults(
  results: readonly AssertionResult[],
): readonly AssertionResult[] {
  return Object.freeze(results.map((result) => {
    const action = result.action === undefined
      ? undefined
      : freezeNested({ ...result.action });
    const originatingResult = freezeOrigin(result.originatingResult);
    return Object.freeze({
      event: "assert_result" as const,
      assertionRef: result.assertionRef,
      runId: result.runId,
      hook: result.hook,
      outcome: result.outcome,
      code: result.code,
      ...(action === undefined ? {} : { action }),
      ...(originatingResult === undefined ? {} : { originatingResult }),
    });
  }));
}

function freezeExecutionReport(
  executions: readonly AssertionExecution[],
  actionRequests: readonly ActionRequestExecution[],
): AssertionExecutionReport | undefined {
  if (executions.length === 0 && actionRequests.length === 0) return undefined;
  const frozenExecutions = Object.freeze(executions.map((execution) => {
    const originatingResult = freezeOrigin(execution.originatingResult);
    return Object.freeze({
      assertionRef: execution.assertionRef,
      runId: execution.runId,
      hook: execution.hook,
      durationMs: execution.durationMs,
      passed: execution.passed,
      ...(originatingResult === undefined ? {} : { originatingResult }),
    });
  }));
  const frozenActions = Object.freeze(actionRequests.map((request) => {
    const originatingResult = freezeOrigin(request.originatingResult);
    return Object.freeze({
      assertionRef: request.assertionRef,
      runId: request.runId,
      hook: request.hook,
      actionType: request.actionType,
      outcome: request.outcome,
      ...(originatingResult === undefined ? {} : { originatingResult }),
    });
  }));
  return Object.freeze({
    executions: frozenExecutions,
    actionRequests: frozenActions,
  });
}

function assertionErrorMessage(failure: InvocationError): string {
  return `pi-assert: assertion "${
    entryRef(failure.assertion.source, failure.assertion.name)
  }" failed to execute — ${formatErrorDetail(failure.error)}`;
}

function handlerErrorMessage(failure: InvocationError): string {
  return `pi-assert: assert_result handler "${
    entryRef(failure.assertion.source, failure.assertion.name)
  }" failed to execute — ${formatErrorDetail(failure.error)}`;
}

function combinedUnexpectedError(errors: readonly InvocationError[]): Error {
  return new Error(errors.map(assertionErrorMessage).join("; "));
}

function publicResult(
  outcome: AdapterOutcome | undefined,
  pendingEffects: EvaluationEffect[],
  executionReport?: AssertionExecutionReport,
): HookEvaluationResult {
  const effects = Object.freeze(
    pendingEffects.map((effect) => {
      if (effect.type !== "request-action") return Object.freeze({ ...effect });
      const action = freezeNested({ ...effect.action });
      return Object.freeze({ ...effect, action });
    }),
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

  /** Evaluate one native event against one captured Active Assertion Set. */
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
    const invocation = await invokeAssertions(assertions, adapter, event, context);

    let rawOutcome: AdapterOutcome | undefined;
    try {
      if (invocation.failures.length > 0) {
        const aggregate = adapter.outcome(invocation.failures, event);
        rawOutcome = invocation.unexpectedErrors.length === 0
          ? aggregate
          : { ...aggregate, infrastructureError: true };
      } else {
        rawOutcome = invocation.unexpectedErrors.length > 0
          ? adapter.internalError(
              combinedUnexpectedError(invocation.unexpectedErrors),
              event,
            )
          : undefined;
      }
    } catch (error) {
      rawOutcome = adapter.internalError(error, event);
    }
    const outcome = rawOutcome === undefined ? undefined : freezeOutcome(rawOutcome);
    const results = freezeResults(invocation.results);

    // Freeze the aggregate decision and all origin results before reactions.
    // Reactions are result-major: owned Action, then assert_result Assertions.
    const effects: EvaluationEffect[] = [];
    const executions: AssertionExecution[] = [...invocation.executions];
    const actionRequests: ActionRequestExecution[] = [];
    for (const result of results) {
      const owned = requestOwnedAction(result);
      effects.push(...owned.effects);
      actionRequests.push(...owned.actionRequests);

      const synthetic = await this.dispatchSyntheticResult(
        assertions,
        result,
        context,
      );
      effects.push(...synthetic.effects);
      executions.push(...synthetic.executions);
      actionRequests.push(...synthetic.actionRequests);
    }

    // If ordinary failures already determine the native outcome, surface each
    // unrelated implementation error separately. Otherwise internalError is
    // itself the one fail-closed presentation/control outcome.
    if (invocation.failures.length > 0) {
      for (const failure of invocation.unexpectedErrors) {
        effects.push(present(assertionErrorMessage(failure), "error"));
      }
    }

    const executionReport = freezeExecutionReport(executions, actionRequests);
    this.appendOriginFeedback(hook, adapter, outcome, effects);
    return publicResult(
      outcome,
      effects,
      executionReport,
    ) as HookEvaluationResult<H>;
  }

  private async dispatchSyntheticResult(
    assertions: readonly ActiveAssertion[],
    result: AssertionResult,
    context: HookExecutionContext,
  ): Promise<{
    effects: EvaluationEffect[];
    executions: AssertionExecution[];
    actionRequests: ActionRequestExecution[];
  }> {
    const effects: EvaluationEffect[] = [];
    const executions: AssertionExecution[] = [];
    const actionRequests: ActionRequestExecution[] = [];
    const failures: AssertionFailure[] = [];
    const adapter = adapterFor("assert_result");
    const detachedContext: HookExecutionContext = Object.freeze({
      cwd: context.cwd,
      metadata: context.metadata,
    });

    try {
      for (const handler of assertions) {
        if (handler.hook !== "assert_result") continue;
        const invocation = await invokeAssertions(
          [handler],
          adapter,
          result,
          detachedContext,
          { originatingResult: result },
        );
        executions.push(...invocation.executions);
        failures.push(...invocation.failures);
        for (const failure of invocation.unexpectedErrors) {
          effects.push(present(handlerErrorMessage(failure), "error"));
        }

        // A handler's local result may select its own Action, but is never
        // projected recursively as another assert_result event.
        for (const localResult of freezeResults(invocation.results)) {
          const owned = requestOwnedAction(localResult);
          effects.push(...owned.effects);
          actionRequests.push(...owned.actionRequests);
        }
      }
      if (failures.length > 0) {
        const handlerOutcome = adapter.outcome(failures, result);
        effects.push(present(handlerOutcome.feedbackMessage, "error"));
      }
    } catch (error) {
      effects.push(present(
        `pi-assert: assert_result dispatch for "${result.assertionRef}" failed — ${
          formatErrorDetail(error)
        }`,
        "error",
      ));
    }
    return { effects, executions, actionRequests };
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

    // Native control outcomes carry their reason/patch to the Pi adapter.
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
