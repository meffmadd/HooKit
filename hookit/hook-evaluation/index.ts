import { entryRef, type NativeEvent } from "../domain/entry.js";
import type { EnabledHook } from "./hooks.js";
import {
  hooksIn,
  type EnabledHookSet,
} from "./enabled-set.js";
import {
  adapterFor,
  formatErrorDetail,
  type AdapterOutcome,
  type HookFailure,
  type EventAdapter,
} from "./adapters.js";
import { requestOwnedAction } from "./actions.js";
import {
  invokeHooks,
  type InvocationError,
  type StartedHookExecution,
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
  ReportOrigin,
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

function freezeResults(
  results: readonly HookResult[],
): readonly HookResult[] {
  // Invocation owns and freezes each result at creation. Capture only the
  // ordered array here; nested catalog Actions and synthetic origins are
  // already immutable and need no second copy/freeze pass.
  return Object.freeze(Array.from(results));
}

/** One originating Hook Result's ordered rows. Originating rows carry no `from`. */
function reportRowsFor(
  result: HookResult,
  execution: StartedHookExecution | undefined,
  owned: ReturnType<typeof requestOwnedAction>,
  syntheticRows: readonly EvaluationReportRow[],
): EvaluationReportRow[] {
  const rows: EvaluationReportRow[] = [];
  if (execution !== undefined) {
    rows.push({
      type: "hook",
      hookRef: result.hookRef,
      durationMs: execution.durationMs,
      passed: execution.passed,
    });
  }
  if (owned.row !== undefined) rows.push(owned.row);
  rows.push(...syntheticRows);
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

function handlerErrorMessage(failure: InvocationError): string {
  return `hookit: hook_result handler "${
    entryRef(failure.hook.source, failure.hook.name)
  }" failed to execute — ${formatErrorDetail(failure.error)}`;
}

function combinedUnexpectedError(errors: readonly InvocationError[]): Error {
  return new Error(errors.map(hookErrorMessage).join("; "));
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

/**
 * Session-scoped owner of the complete transaction for one native event.
 * Pi-specific callback translation and effect delivery stay outside this module.
 */
export class HookEvaluation {
  private correctiveFingerprints = new Map<NativeEvent, string>();

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
      this.appendOriginFeedback(event, fallbackAdapter, outcome, effects);
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
    const invocation = await invokeHooks(hooks, adapter, payload, context);

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
              combinedUnexpectedError(invocation.unexpectedErrors),
              payload,
            )
          : undefined;
      }
    } catch (error) {
      rawOutcome = adapter.internalError(error, payload);
    }
    const outcome = rawOutcome === undefined ? undefined : freezeOutcome(rawOutcome);

    // Freeze the aggregate native decision and all origin results before
    // reactions. Reactions are result-major: originating Hook row, owned
    // Action row, then configured hook_result Hooks and their rows.
    const records = invocation.invocations;
    const results = freezeResults(records.map((record) => record.result));
    const effects: EvaluationEffect[] = [];
    const rows: EvaluationReportRow[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      const frozenResult = results[index]!;

      const owned = requestOwnedAction(frozenResult);
      effects.push(...owned.effects);

      const synthetic = await this.dispatchSyntheticResult(
        hooks,
        frozenResult,
        context,
      );
      effects.push(...synthetic.effects);

      rows.push(...reportRowsFor(
        frozenResult,
        record.execution,
        owned,
        synthetic.rows,
      ));
    }

    // If ordinary failures already determine the native outcome, surface each
    // unrelated implementation error separately. Otherwise internalError is
    // itself the one fail-closed presentation/control outcome.
    if (invocation.failures.length > 0) {
      for (const failure of invocation.unexpectedErrors) {
        effects.push(present(hookErrorMessage(failure), "error"));
      }
    }

    const executionReport = freezeExecutionReport(rows);
    this.appendOriginFeedback(event, adapter, outcome, effects);
    return publicResult(
      outcome,
      effects,
      executionReport,
    ) as HookEvaluationResult<H>;
  }

  private async dispatchSyntheticResult(
    hooks: readonly EnabledHook[],
    result: HookResult,
    context: EvaluationContext,
  ): Promise<{
    effects: EvaluationEffect[];
    rows: EvaluationReportRow[];
  }> {
    const effects: EvaluationEffect[] = [];
    const rows: EvaluationReportRow[] = [];
    const failures: HookFailure[] = [];
    const adapter = adapterFor("hook_result");
    const detachedContext: EvaluationContext = Object.freeze({
      cwd: context.cwd,
      metadata: context.metadata,
    });

    try {
      for (const handler of hooks) {
        if (handler.event !== "hook_result") continue;
        const invocation = await invokeHooks(
          [handler],
          adapter,
          result,
          detachedContext,
          { originatingResult: result },
        );
        failures.push(...invocation.failures);
        for (const failure of invocation.unexpectedErrors) {
          effects.push(present(handlerErrorMessage(failure), "error"));
        }

        // A handler's local results append their Hook row (projecting the
        // originating Hook Result) and may select their own Action, but are
        // never redispatched recursively.
        const origin: ReportOrigin = {
          hookRef: result.hookRef,
          outcome: result.outcome,
        };
        for (const record of invocation.invocations) {
          if (record.execution !== undefined) {
            rows.push({
              type: "hook",
              hookRef: record.result.hookRef,
              durationMs: record.execution.durationMs,
              passed: record.execution.passed,
              origin,
            });
          }
          const owned = requestOwnedAction(record.result);
          effects.push(...owned.effects);
          if (owned.row !== undefined) rows.push(owned.row);
        }
      }
      if (failures.length > 0) {
        const handlerOutcome = adapter.outcome(failures, result);
        effects.push(present(handlerOutcome.feedbackMessage, "error"));
      }
    } catch (error) {
      effects.push(present(
        `hookit: hook_result dispatch for "${result.hookRef}" failed — ${
          formatErrorDetail(error)
        }`,
        "error",
      ));
    }
    return { effects, rows };
  }

  private appendOriginFeedback<E>(
    event: NativeEvent,
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
