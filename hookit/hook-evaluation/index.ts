import { entryRef, type Event, type NativeEvent } from "../domain/entry.js";
import type { EnabledHook } from "./hooks.js";
import {
  hooksIn,
  type EnabledHookSet,
} from "./enabled-set.js";
import {
  adapterFor,
  formatErrorDetail,
  type AdapterOutcome,
  type EventAdapter,
} from "./adapters.js";
import { requestOwnedAction } from "./actions.js";
import {
  invokeHooks,
  type HookInvocationRecord,
  type InvocationError,
} from "./invocations.js";
import type {
  HookExecutionReport,
  HookResult,
  EvaluationEffect,
  EvaluationReportRow,
  EvaluationEventMap,
  HookEvaluationResult,
  EventMap,
  EvaluationContext,
  RuntimeMetadataSnapshot,
  ToolResultPatch,
} from "./types.js";

export { createEnabledHookSet } from "./enabled-set.js";
export type { EnabledHookSet } from "./enabled-set.js";
export type { EnabledHook } from "./hooks.js";
export type {
  AgentEndEvent,
  AgentSettledEvent,
  HookExecutionReport,
  HookResult,
  BlockEvaluationResult,
  CancelEvaluationResult,
  EvaluationEffect,
  EvaluationReportRow,
  HookEvaluationResult,
  HookEvaluationResultMap,
  EventMap,
  EvaluationContext,
  OriginatingHookResult,
  PassEvaluationResult,
  PatchEvaluationResult,
  PresentationSeverity,
  ReportEvaluationResult,
  ReportOrigin,
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

function snapshotContext(context: EvaluationContext): EvaluationContext {
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
  const details = Object.prototype.hasOwnProperty.call(patch, "details")
    ? freezeNested(patch.details)
    : undefined;
  return Object.freeze({
    ...(content === undefined ? {} : { content }),
    ...(Object.prototype.hasOwnProperty.call(patch, "details")
      ? { details }
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

/** One Hook Result's shell and selected-Action accounting rows. */
function reportRowsFor(
  record: HookInvocationRecord,
  owned: ReturnType<typeof requestOwnedAction>,
): EvaluationReportRow[] {
  const rows: EvaluationReportRow[] = [];
  if (record.execution !== undefined) {
    const originatingResult = record.result.originatingResult;
    rows.push({
      type: "hook",
      hookRef: record.result.hookRef,
      durationMs: record.execution.durationMs,
      passed: record.execution.passed,
      ...(originatingResult === undefined
        ? {}
        : {
            origin: {
              hookRef: originatingResult.hookRef,
              outcome: originatingResult.outcome,
            },
          }),
    });
  }
  if (owned.row !== undefined) rows.push(owned.row);
  return rows;
}

function freezeExecutionReport(
  rows: readonly EvaluationReportRow[],
): HookExecutionReport | undefined {
  if (rows.length === 0) return undefined;
  const frozenRows = Object.freeze(rows.map((row) => {
    const origin = row.origin === undefined
      ? undefined
      : Object.freeze({ ...row.origin });
    return Object.freeze({
      type: row.type,
      hookRef: row.hookRef,
      ...(row.type === "hook"
        ? { durationMs: row.durationMs, passed: row.passed }
        : { actionType: row.actionType, outcome: row.outcome }),
      ...(origin === undefined ? {} : { origin }),
    }) as EvaluationReportRow;
  }));
  return Object.freeze({ rows: frozenRows });
}

function hookErrorMessage(failure: InvocationError): string {
  return `hookit: hook "${
    entryRef(failure.hook.source, failure.hook.name)
  }" failed to execute — ${formatErrorDetail(failure.error)}`;
}

function invocationErrorMessage(
  event: Event,
  failure: InvocationError,
): string {
  return event === "hook_result"
    ? `hookit: hook_result handler "${
      entryRef(failure.hook.source, failure.hook.name)
    }" failed to execute — ${formatErrorDetail(failure.error)}`
    : hookErrorMessage(failure);
}

function combinedUnexpectedError(
  event: Event,
  errors: readonly InvocationError[],
): Error {
  return new Error(
    errors.map((failure) => invocationErrorMessage(event, failure)).join("; "),
  );
}

function freezeNested<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) freezeNested(nested);
  return Object.freeze(value);
}

function publicResult(
  outcome: AdapterOutcome | undefined,
  pendingEffects: EvaluationEffect[],
  executionReport?: HookExecutionReport,
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

interface EventEvaluation {
  readonly outcome: AdapterOutcome | undefined;
  readonly effects: EvaluationEffect[];
  readonly rows: EvaluationReportRow[];
}

interface ResultProcessing {
  readonly effects: readonly EvaluationEffect[];
  readonly rows: readonly EvaluationReportRow[];
}

/**
 * Session-scoped owner of the complete transaction for one Native Event.
 * Pi-specific callback translation and Effect delivery stay outside this module.
 */
export class HookEvaluation {
  private correctiveFingerprints = new Map<Event, string>();

  /** Evaluate one Native Event against one captured Enabled Hook Set. */
  async evaluate<H extends NativeEvent>(
    event: H,
    payload: EventMap[H],
    context: EvaluationContext,
    enabledSet: EnabledHookSet,
  ): Promise<HookEvaluationResult<H>> {
    let adapter: EventAdapter<EvaluationEventMap[H]> | undefined;
    try {
      adapter = adapterFor(event);
      const hooks = hooksIn(enabledSet);
      const capturedContext = snapshotContext(context);
      return await this.evaluateTransaction(
        event,
        payload as EvaluationEventMap[H],
        capturedContext,
        hooks,
        adapter,
      );
    } catch (error) {
      const fallbackAdapter = adapter ?? adapterFor(event);
      const outcome = freezeOutcome(
        fallbackAdapter.internalError(error, payload as EvaluationEventMap[H]),
      );
      const effects: EvaluationEffect[] = [];
      this.appendFeedback(event, fallbackAdapter, outcome, effects);
      return publicResult(outcome, effects) as HookEvaluationResult<H>;
    }
  }

  private async evaluateTransaction<H extends NativeEvent>(
    event: H,
    payload: EvaluationEventMap[H],
    context: EvaluationContext,
    hooks: readonly EnabledHook[],
    adapter: EventAdapter<EvaluationEventMap[H]>,
  ): Promise<HookEvaluationResult<H>> {
    const evaluated = await this.evaluateEvent(
      event,
      payload,
      context,
      hooks,
      adapter,
      async (result) => this.evaluateHookResultEvent(hooks, result, context),
    );
    return publicResult(
      evaluated.outcome,
      evaluated.effects,
      freezeExecutionReport(evaluated.rows),
    ) as HookEvaluationResult<H>;
  }

  /**
   * Private shared mechanism for Native Events and Hook Result Events.
   * The caller controls projection: Native results project once; reactive
   * results pass no processor and therefore never recurse.
   */
  private async evaluateEvent<H extends Event>(
    event: H,
    payload: EvaluationEventMap[H],
    context: EvaluationContext,
    hooks: readonly EnabledHook[],
    adapter: EventAdapter<EvaluationEventMap[H]>,
    processResult?: (result: HookResult) => Promise<ResultProcessing>,
    originatingResult?: HookResult,
  ): Promise<EventEvaluation> {
    const invocation = await invokeHooks(
      hooks,
      adapter,
      payload,
      context,
      originatingResult === undefined ? {} : { originatingResult },
    );

    let rawOutcome: AdapterOutcome | undefined;
    try {
      if (invocation.failures.length > 0) {
        const aggregate = adapter.outcome(invocation.failures, payload);
        rawOutcome = invocation.unexpectedErrors.length === 0
          ? aggregate
          : { ...aggregate, infrastructureError: true };
      } else {
        rawOutcome = invocation.unexpectedErrors.length > 0
          ? adapter.internalError(
              combinedUnexpectedError(event, invocation.unexpectedErrors),
              payload,
            )
          : undefined;
      }
    } catch (error) {
      rawOutcome = adapter.internalError(error, payload);
    }
    const outcome = rawOutcome === undefined ? undefined : freezeOutcome(rawOutcome);

    // The aggregate Event decision and every immutable Hook Result exist
    // before Actions or projected Event work begins.
    const effects: EvaluationEffect[] = [];
    const rows: EvaluationReportRow[] = [];
    for (const record of invocation.invocations) {
      const owned = requestOwnedAction(record.result);
      effects.push(...owned.effects);
      rows.push(...reportRowsFor(record, owned));

      if (processResult !== undefined) {
        const processed = await processResult(record.result);
        effects.push(...processed.effects);
        rows.push(...processed.rows);
      }
    }

    // Preserve result-major work before diagnostics for unrelated crashes.
    if (invocation.failures.length > 0) {
      for (const failure of invocation.unexpectedErrors) {
        effects.push(present(invocationErrorMessage(event, failure), "error"));
      }
    }

    this.appendFeedback(event, adapter, outcome, effects);
    return { outcome, effects, rows };
  }

  /** Outer Hook Evaluation projection point; reactive results never call it. */
  private async evaluateHookResultEvent(
    hooks: readonly EnabledHook[],
    result: HookResult,
    context: EvaluationContext,
  ): Promise<ResultProcessing> {
    const adapter = adapterFor("hook_result");
    const detachedContext: EvaluationContext = Object.freeze({
      cwd: context.cwd,
      metadata: context.metadata,
    });
    const evaluated = await this.evaluateEvent(
      "hook_result",
      result,
      detachedContext,
      hooks,
      adapter,
      undefined,
      result,
    );
    return { effects: evaluated.effects, rows: evaluated.rows };
  }

  private appendFeedback<E>(
    event: Event,
    adapter: EventAdapter<E>,
    outcome: AdapterOutcome | undefined,
    effects: EvaluationEffect[],
  ): void {
    if (!outcome) {
      if (adapter.feedback === "corrective-turn") {
        this.correctiveFingerprints.delete(event);
      }
      return;
    }

    // Native control outcomes carry their reason/patch to the Pi adapter.
    if (outcome.action !== "report") return;

    if (outcome.infrastructureError || adapter.feedback === "present-error") {
      if (adapter.feedback === "corrective-turn") {
        this.correctiveFingerprints.delete(event);
      }
      effects.push(present(outcome.feedbackMessage, "error"));
      return;
    }

    const fingerprint = outcome.fingerprint ?? outcome.messages.join("\n");
    if (this.correctiveFingerprints.get(event) === fingerprint) {
      effects.push(present(
        outcome.repeatedFeedbackMessage ??
          "HooKit: hooks still fail; automatic retry stopped.",
        "error",
      ));
      return;
    }

    this.correctiveFingerprints.set(event, fingerprint);
    effects.push({
      type: "request-corrective-turn",
      message: outcome.feedbackMessage,
    });
  }
}
