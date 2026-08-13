import {
  entryRef,
  type Event,
  type HookResultEvent,
  type NativeEvent,
} from "../domain/entry.js";
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
  Effect,
  EvaluationContext,
  EvaluationEventMap,
  EvaluationReport,
  EvaluationReportRow,
  EventMap,
  EventOutcome,
  HookEvaluationOutcome,
  HookResult,
  HookResultEventOutcome,
  NativeEventOutcome,
  RuntimeMetadataSnapshot,
  ToolResultPatch,
} from "./types.js";

export { createEnabledHookSet } from "./enabled-set.js";
export type { EnabledHookSet } from "./enabled-set.js";
export type { EnabledHook } from "./hooks.js";
export type {
  AgentEndEvent,
  AgentSettledEvent,
  BlockEventOutcome,
  CancelEventOutcome,
  Effect,
  EvaluationContext,
  EvaluationReport,
  EvaluationReportRow,
  EventMap,
  EventOutcome,
  EventOutcomeMap,
  HookEvaluationOutcome,
  HookResultEventOutcome,
  NativeEventOutcome,
  PassEventOutcome,
  PatchEventOutcome,
  PresentationSeverity,
  ReportEventOutcome,
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
): Effect {
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

function freezeEvaluationReport(
  rows: readonly EvaluationReportRow[],
): EvaluationReport | undefined {
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

function freezeNested<T>(value: T, ancestors = new Set<object>()): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (ancestors.has(value)) return value;
  ancestors.add(value);
  for (const nested of Object.values(value)) freezeNested(nested, ancestors);
  ancestors.delete(value);
  return Object.freeze(value);
}

function eventOutcome<H extends Event>(
  event: H,
  outcome: AdapterOutcome | undefined,
  identity?: Pick<HookResultEvent, "hookRef" | "invocationId">,
): EventOutcome<H> {
  const complete = <T>(value: T): EventOutcome<H> =>
    value as unknown as EventOutcome<H>;
  const base = {
    event,
    ...(identity === undefined ? {} : identity),
  };
  if (outcome === undefined) {
    return complete(Object.freeze({ ...base, outcome: "pass" }));
  }
  switch (outcome.action) {
    case "block":
      return complete(Object.freeze({
        ...base,
        outcome: "block",
        reason: outcome.reason,
      }));
    case "patch":
      return complete(Object.freeze({
        ...base,
        outcome: "patch",
        reason: outcome.reason,
        patch: outcome.patch,
      }));
    case "cancel":
      return complete(Object.freeze({
        ...base,
        outcome: "cancel",
        reason: outcome.reason,
      }));
    case "report":
      return complete(Object.freeze({ ...base, outcome: "report" }));
  }
}

function freezeEffects(pendingEffects: Effect[]): readonly Effect[] {
  return Object.freeze(
    pendingEffects.map((effect) => {
      if (effect.type !== "request-action") return Object.freeze({ ...effect });
      const action = freezeNested({ ...effect.action });
      return Object.freeze({ ...effect, action });
    }),
  );
}

function publicOutcome<H extends NativeEvent>(
  eventOutcomes: readonly [
    NativeEventOutcome<H>,
    ...HookResultEventOutcome[],
  ],
  pendingEffects: Effect[],
  evaluationReport?: EvaluationReport,
): HookEvaluationOutcome<H> {
  return Object.freeze({
    eventOutcomes: Object.freeze([...eventOutcomes]) as HookEvaluationOutcome<H>["eventOutcomes"],
    effects: freezeEffects(pendingEffects),
    ...(evaluationReport === undefined ? {} : { evaluationReport }),
  });
}

interface EventEvaluation<H extends Event> {
  readonly eventOutcome: EventOutcome<H>;
  readonly effects: Effect[];
  readonly rows: EvaluationReportRow[];
  readonly projectedOutcomes: HookResultEventOutcome[];
}

interface ResultProcessing {
  readonly eventOutcome: HookResultEventOutcome;
  readonly effects: readonly Effect[];
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
  ): Promise<HookEvaluationOutcome<H>> {
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
      const effects: Effect[] = [];
      this.appendFeedback(event, fallbackAdapter, outcome, effects);
      return publicOutcome(
        [eventOutcome(event, outcome) as NativeEventOutcome<H>],
        effects,
      );
    }
  }

  private async evaluateTransaction<H extends NativeEvent>(
    event: H,
    payload: EvaluationEventMap[H],
    context: EvaluationContext,
    hooks: readonly EnabledHook[],
    adapter: EventAdapter<EvaluationEventMap[H]>,
  ): Promise<HookEvaluationOutcome<H>> {
    const evaluated = await this.evaluateEvent(
      event,
      payload,
      context,
      hooks,
      adapter,
      async (result) => this.evaluateHookResultEvent(hooks, result, context),
    );
    return publicOutcome(
      [
        evaluated.eventOutcome as NativeEventOutcome<H>,
        ...evaluated.projectedOutcomes,
      ],
      evaluated.effects,
      freezeEvaluationReport(evaluated.rows),
    );
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
  ): Promise<EventEvaluation<H>> {
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
    const effects: Effect[] = [];
    const rows: EvaluationReportRow[] = [];
    const projectedOutcomes: HookResultEventOutcome[] = [];
    for (const record of invocation.invocations) {
      const owned = requestOwnedAction(record.result);
      effects.push(...owned.effects);
      rows.push(...reportRowsFor(record, owned));

      if (processResult !== undefined) {
        const processed = await processResult(record.result);
        projectedOutcomes.push(processed.eventOutcome);
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
    const identity = event === "hook_result"
      ? {
          hookRef: (payload as EvaluationEventMap["hook_result"]).hookRef,
          invocationId: (payload as EvaluationEventMap["hook_result"]).invocationId,
        }
      : undefined;
    return {
      eventOutcome: eventOutcome(event, outcome, identity),
      effects,
      rows,
      projectedOutcomes,
    };
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
      {
        event: "hook_result",
        hookRef: result.hookRef,
        invocationId: result.invocationId,
        outcome: result.outcome,
        code: result.code,
      },
      detachedContext,
      hooks,
      adapter,
      undefined,
      result,
    );
    return {
      eventOutcome: evaluated.eventOutcome,
      effects: evaluated.effects,
      rows: evaluated.rows,
    };
  }

  private appendFeedback<E>(
    event: Event,
    adapter: EventAdapter<E>,
    outcome: AdapterOutcome | undefined,
    effects: Effect[],
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
