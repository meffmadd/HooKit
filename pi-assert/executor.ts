import {
  getHookAdapter,
  type AssertFailure,
  type CancelHookOutcome,
  type HookAdapter,
  type HookAdapterOutcome,
} from "./adapters.js";
import {
  matchFilter,
  evaluateShell,
  isPreset,
  type Assert,
  type AgentEndEvent,
  type AgentSettledEvent,
  type ExtensionContext,
  type SessionBeforeForkEvent,
  type SessionBeforeSwitchEvent,
  type ShellAssert,
  type ToolCallEvent,
  type ToolResultEvent,
  type ToolResultPatch,
  type TurnEndEvent,
} from "./engine.js";
import {
  entryRef,
  type AssertResultEvent,
} from "./domain/entry.js";

// Preserve the original executor-module type import path after moving the
// structured failure record behind the adapter seam.
export type { AssertFailure } from "./adapters.js";

/**
 * A record of a single assert whose main `shell` executed. Filter mismatches
 * and ordinary non-zero `when` skips do not produce records.
 */
export interface RunRecord {
  name: string;
  hook: string;
  /** Main-shell wall-clock time only; excludes `when`. */
  durationMs: number;
  passed: boolean;
}

/** Canonical synthetic record emitted for one originating assertion. */
export type AssertionResultRecord = AssertResultEvent;

/** Single construction seam for the canonical result record and future enrichment. */
function makeAssertionResult(
  assertion: ShellAssert,
  outcome: AssertionResultRecord["outcome"],
  code: AssertionResultRecord["code"],
): AssertionResultRecord {
  return Object.freeze({
    event: "assert_result",
    assertionRef: entryRef(assertion.source, assertion.name),
    outcome,
    code,
  });
}

interface RunAssertsResult {
  failures: AssertFailure[];
  results: AssertionResultRecord[];
}

export interface HookExecutionOptions {
  /** Isolate one assertion's unexpected error, then continue in order. */
  onAssertionError?: (
    assertion: Assert,
    error: unknown,
  ) => void | Promise<void>;
}

/**
 * Shared filter → `when` → shell core. Hook adapters provide only event
 * projection and failure policy; no lifecycle hook owns a parallel loop.
 */
async function runAsserts<E>(
  asserts: Assert[],
  adapter: HookAdapter<E>,
  event: E,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
  options?: HookExecutionOptions,
): Promise<RunAssertsResult> {
  if (adapter.skipIfAborted && ctx.signal?.aborted) {
    return { failures: [], results: [] };
  }

  const failures: AssertFailure[] = [];
  const results: AssertionResultRecord[] = [];
  const emitResults = adapter.hook !== "assert_result";

  for (const assertion of asserts) {
    // Active presets are expanded before execution; this is a narrowing guard.
    if (isPreset(assertion)) continue;
    if (assertion.hook !== adapter.hook) continue;

    try {
      const candidate = adapter.candidate(event);
      const matches = adapter.matchesFilter ?? matchFilter;
      if (!matches(assertion.filter, candidate)) continue;
      const env = adapter.buildEnv(event, ctx);

      if (assertion.when) {
        const result = await evaluateShell(
          assertion.when,
          env,
          ctx.signal,
          undefined,
          ctx.cwd,
        );
        // An ordinary non-zero precondition means not applicable. A timeout,
        // abort, or spawn failure has code null and fails closed.
        if (result.code === null) {
          failures.push({
            assertion,
            phase: "when",
            command: assertion.when,
            result,
          });
          if (emitResults) {
            results.push(makeAssertionResult(
              assertion,
              adapter.failureAction,
              null,
            ));
          }
          if (adapter.aggregation === "first") return { failures, results };
          continue;
        }
        if (!result.passed) continue;
      }

      const startedAt = Date.now();
      const result = await evaluateShell(
        assertion.shell,
        env,
        ctx.signal,
        undefined,
        ctx.cwd,
      );
      onRun?.({
        name: assertion.name,
        hook: adapter.hook,
        durationMs: Date.now() - startedAt,
        passed: result.passed,
      });

      if (emitResults) {
        results.push(makeAssertionResult(
          assertion,
          result.passed ? "pass" : adapter.failureAction,
          result.code,
        ));
      }

      if (!result.passed) {
        failures.push({
          assertion,
          phase: "shell",
          command: assertion.shell,
          result,
        });
        if (adapter.aggregation === "first") return { failures, results };
      }
    } catch (error) {
      if (!options?.onAssertionError) throw error;
      try {
        await options.onAssertionError(assertion, error);
      } catch {
        // Isolation callback feedback is best-effort.
      }
    }
  }
  return { failures, results };
}

export interface HookExecution {
  /** Frozen native/report decision, computed before synthetic dispatch. */
  readonly outcome: HookAdapterOutcome | undefined;
  /** Frozen assertion decisions in execution order. */
  readonly results: readonly AssertionResultRecord[];
}

/** Execute an adapter and retain the synthetic records for internal dispatch. */
export async function executeHookAssertsWithResults<E>(
  asserts: Assert[],
  adapter: HookAdapter<E>,
  event: E,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
  options?: HookExecutionOptions,
): Promise<HookExecution> {
  const execution = await runAsserts(asserts, adapter, event, ctx, onRun, options);
  const outcome = execution.failures.length === 0
    ? undefined
    : adapter.outcome(execution.failures, event);

  // Freeze the complete decision boundary before synthetic dispatch. The
  // assertion objects referenced by failures remain shared runtime records,
  // but handlers never receive this outcome or its arrays.
  if (outcome) {
    Object.freeze(outcome.failures);
    Object.freeze(outcome.messages);
    Object.freeze(outcome);
  }
  Object.freeze(execution.results);
  return Object.freeze({ outcome, results: execution.results });
}

/**
 * Execute any adapter through the shared core while preserving the original
 * public outcome-only API.
 */
export async function executeHookAsserts<E>(
  asserts: Assert[],
  adapter: HookAdapter<E>,
  event: E,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
): Promise<HookAdapterOutcome | undefined> {
  return (await executeHookAssertsWithResults(
    asserts,
    adapter,
    event,
    ctx,
    onRun,
  )).outcome;
}

export type AssertResultReporter = (message: string) => void | Promise<void>;

async function reportBestEffort(
  report: AssertResultReporter | undefined,
  message: string,
): Promise<void> {
  if (!report) return;
  try {
    await report(message);
  } catch {
    // Result-handler reporting must never affect the originating callback.
  }
}

function errorDetail(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

function dispatchErrorMessage(assertion: Assert, error: unknown): string {
  const ref = isPreset(assertion)
    ? assertion.name
    : entryRef(assertion.source, assertion.name);
  return `pi-assert: assert_result handler "${ref}" failed to execute — ${errorDetail(error)}`;
}

/**
 * Dispatch synthetic results in result-major, configured-handler order.
 *
 * Each handler goes through the same adapter executor in isolation. The
 * detached context intentionally omits the originating signal, and both
 * execution and feedback errors are swallowed after best-effort reporting.
 */
export async function dispatchAssertResults(
  asserts: Assert[],
  results: readonly AssertionResultRecord[],
  ctx: ExtensionContext,
  report?: AssertResultReporter,
): Promise<void> {
  const detachedCtx: ExtensionContext = { cwd: ctx.cwd };
  const adapter = getHookAdapter("assert_result");

  for (const result of results) {
    try {
      const execution = await executeHookAssertsWithResults(
        asserts,
        adapter,
        result,
        detachedCtx,
        undefined,
        {
          onAssertionError: (handler, error) =>
            reportBestEffort(report, dispatchErrorMessage(handler, error)),
        },
      );
      if (execution.outcome?.action === "report") {
        await reportBestEffort(report, execution.outcome.feedbackMessage);
      }
    } catch (error) {
      await reportBestEffort(
        report,
        `pi-assert: assert_result dispatch for "${result.assertionRef}" failed — ` +
          errorDetail(error),
      );
    }
  }
}

/** Run active tool_call assertions; first failure blocks the call. */
export async function executeToolCallAsserts(
  asserts: Assert[],
  event: ToolCallEvent,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
): Promise<{ block: true; reason: string } | undefined> {
  const outcome = await executeHookAsserts(
    asserts,
    getHookAdapter("tool_call"),
    event,
    ctx,
    onRun,
  );
  if (outcome?.action !== "block") return undefined;
  return { block: true, reason: outcome.reason };
}

/** Run active tool_result assertions; first failure suppresses the result. */
export async function executeToolResultAsserts(
  asserts: Assert[],
  event: ToolResultEvent,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
): Promise<{ patch: ToolResultPatch; reason: string } | undefined> {
  const outcome = await executeHookAsserts(
    asserts,
    getHookAdapter("tool_result"),
    event,
    ctx,
    onRun,
  );
  if (outcome?.action !== "patch") return undefined;
  return { patch: outcome.patch, reason: outcome.reason };
}

/** Run active turn_end assertions; failures are collected and report-only. */
export async function executeTurnEndAsserts(
  asserts: Assert[],
  event: TurnEndEvent,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
): Promise<string[]> {
  const outcome = await executeHookAsserts(
    asserts,
    getHookAdapter("turn_end"),
    event,
    ctx,
    onRun,
  );
  return outcome?.action === "report" ? outcome.messages : [];
}

/**
 * Run active agent_end assertions. Failures are collected so the extension can
 * inject one corrective message, preserving the original public executor API.
 */
export async function executeAgentEndAsserts(
  asserts: Assert[],
  event: AgentEndEvent,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
): Promise<string[]> {
  const outcome = await executeHookAsserts(
    asserts,
    getHookAdapter("agent_end"),
    event,
    ctx,
    onRun,
  );
  return outcome?.action === "report" ? outcome.messages : [];
}

/** Run active agent_settled assertions; failures are collected and report-only. */
export async function executeAgentSettledAsserts(
  asserts: Assert[],
  event: AgentSettledEvent,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
): Promise<string[]> {
  const outcome = await executeHookAsserts(
    asserts,
    getHookAdapter("agent_settled"),
    event,
    ctx,
    onRun,
  );
  return outcome?.action === "report" ? outcome.messages : [];
}

/** Run session switch guards; all failures are aggregated into one cancel. */
export async function executeSessionBeforeSwitchAsserts(
  asserts: Assert[],
  event: SessionBeforeSwitchEvent,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
): Promise<CancelHookOutcome | undefined> {
  const outcome = await executeHookAsserts(
    asserts,
    getHookAdapter("session_before_switch"),
    event,
    ctx,
    onRun,
  );
  return outcome?.action === "cancel" ? outcome : undefined;
}

/** Run session fork guards; all failures are aggregated into one cancel. */
export async function executeSessionBeforeForkAsserts(
  asserts: Assert[],
  event: SessionBeforeForkEvent,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
): Promise<CancelHookOutcome | undefined> {
  const outcome = await executeHookAsserts(
    asserts,
    getHookAdapter("session_before_fork"),
    event,
    ctx,
    onRun,
  );
  return outcome?.action === "cancel" ? outcome : undefined;
}

/** Compact informational TUI summary for executed main shells. */
export function formatRunReport(runs: RunRecord[]): string {
  if (runs.length === 0) return "";
  const totalMs = runs.reduce((sum, run) => sum + run.durationMs, 0);
  return `pi-assert ran ${runs.length} command${runs.length === 1 ? "" : "s"} in ${totalMs}ms`;
}
