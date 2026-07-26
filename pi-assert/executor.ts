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
  type ToolCallEvent,
  type ToolResultEvent,
  type ToolResultPatch,
  type TurnEndEvent,
} from "./engine.js";

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
): Promise<AssertFailure[]> {
  if (adapter.skipIfAborted && ctx.signal?.aborted) return [];

  const failures: AssertFailure[] = [];
  for (const assertion of asserts) {
    // Active presets are expanded before execution; this is a narrowing guard.
    if (isPreset(assertion)) continue;
    if (assertion.hook !== adapter.hook) continue;

    const candidate = adapter.candidate(event);
    if (!matchFilter(assertion.filter, candidate)) continue;
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
        if (adapter.aggregation === "first") return failures;
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

    if (!result.passed) {
      failures.push({
        assertion,
        phase: "shell",
        command: assertion.shell,
        result,
      });
      if (adapter.aggregation === "first") return failures;
    }
  }
  return failures;
}

/**
 * Execute any adapter through the shared core. This is the internal adapter
 * seam used by current native hooks and future synthetic hooks.
 */
export async function executeHookAsserts<E>(
  asserts: Assert[],
  adapter: HookAdapter<E>,
  event: E,
  ctx: ExtensionContext,
  onRun?: (record: RunRecord) => void,
): Promise<HookAdapterOutcome | undefined> {
  const failures = await runAsserts(asserts, adapter, event, ctx, onRun);
  return failures.length === 0 ? undefined : adapter.outcome(failures, event);
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
