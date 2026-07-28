import {
  buildEnv,
  buildLifecycleEnv,
  buildResultEnv,
  matchFilter,
  type AgentEndEvent,
  type AgentSettledEvent,
  type ExtensionContext,
  type SessionBeforeForkEvent,
  type SessionBeforeSwitchEvent,
  type ShellAssert,
  type ShellResult,
  type ToolCallEvent,
  type ToolResultEvent,
  type ToolResultPatch,
  type TurnEndEvent,
} from "./engine.js";
import {
  type AssertResultEvent,
  type AssertResultOutcome,
  type EntryFilter,
  type Hook,
} from "./domain/entry.js";

/** Native or synthetic event shape consumed by each registered adapter. */
export interface HookEventMap {
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  turn_end: TurnEndEvent;
  agent_end: AgentEndEvent;
  agent_settled: AgentSettledEvent;
  session_before_switch: SessionBeforeSwitchEvent;
  session_before_fork: SessionBeforeForkEvent;
  assert_result: AssertResultEvent;
}

export type FailureAction = Exclude<AssertResultOutcome, "pass">;
export type FailureAggregation = "first" | "all";
export type FeedbackPolicy = "notify-error" | "corrective-turn";

/** A failed `when` process or non-passing main assertion shell. */
export interface AssertFailure {
  assertion: ShellAssert;
  phase: "when" | "shell";
  command: string;
  result: ShellResult;
}

interface HookOutcomeBase {
  /** Adapter action; mirrors Pi's available event result contract. */
  action: FailureAction;
  /** Structured originating failures used to format and freeze the decision. */
  failures: AssertFailure[];
  /** Adapter-formatted failure lines or reasons. */
  messages: string[];
  /** User-facing text dispatched according to the adapter feedback policy. */
  feedbackMessage: string;
}

/** Prevent the pending tool call from executing. */
export interface BlockHookOutcome extends HookOutcomeBase {
  action: "block";
  reason: string;
}

/** Replace a completed tool result before Pi exposes it to the agent. */
export interface PatchHookOutcome extends HookOutcomeBase {
  action: "patch";
  reason: string;
  patch: ToolResultPatch;
}

/** Cancel a pending session switch or fork. */
export interface CancelHookOutcome extends HookOutcomeBase {
  action: "cancel";
  reason: string;
}

/** Report failures without returning a native Pi control result. */
export interface ReportHookOutcome extends HookOutcomeBase {
  action: "report";
  /** Used by corrective feedback to suppress identical automatic retries. */
  fingerprint?: string;
  repeatedFeedbackMessage?: string;
}

export type HookAdapterOutcome =
  | BlockHookOutcome
  | PatchHookOutcome
  | CancelHookOutcome
  | ReportHookOutcome;

/**
 * Adapter seam between a Pi lifecycle event and the shared assertion executor.
 *
 * Adding a hook means defining its bounded filter candidate/environment and its
 * native failure contract here; filter → `when` → shell remains in one core.
 */
export interface HookAdapter<E = unknown> {
  hook: string;
  failureAction: FailureAction;
  aggregation: FailureAggregation;
  feedback: FeedbackPolicy;
  /** Report-only hooks skip an already-aborted turn instead of inventing errors. */
  skipIfAborted?: boolean;
  candidate(event: E): Record<string, unknown>;
  /** Optional field-specific matcher; defaults to the shared regex matcher. */
  matchesFilter?(
    filter: EntryFilter | undefined,
    candidate: Record<string, unknown>,
  ): boolean;
  buildEnv(event: E, ctx: ExtensionContext): Record<string, string>;
  outcome(failures: AssertFailure[], event: E): HookAdapterOutcome;
}

/** Identity helper that preserves an adapter's event type for callers. */
export function defineHookAdapter<E>(adapter: HookAdapter<E>): HookAdapter<E> {
  return adapter;
}

function toolCandidate(event: ToolCallEvent | ToolResultEvent): Record<string, unknown> {
  // The native tool name is trusted and must win over a shadowing input field.
  return { ...event.input, toolName: event.toolName };
}

function lifecycleBuilder<H extends Hook>(
  hook: H,
  candidate: (event: HookEventMap[H]) => Record<string, unknown>,
): (event: HookEventMap[H], ctx: ExtensionContext) => Record<string, string> {
  return (event, ctx) => buildLifecycleEnv(hook, candidate(event), ctx);
}

function failureLine(failure: AssertFailure): string {
  const { assertion, phase, command, result } = failure;
  return phase === "shell"
    ? `- **${assertion.name}**: \`${command}\` (exit ${result.code})`
    : `- **${assertion.name}** (when): \`${command}\` (exit ${result.code})`;
}

function reportMessage(hook: Hook, messages: string[]): string {
  return `pi-assert: ${messages.length} ${hook} assertion${messages.length === 1 ? "" : "s"} failed:\n` +
    messages.join("\n");
}

const agentEndCandidate = () => ({ event: "agent_end" });
const agentSettledCandidate = () => ({ event: "agent_settled" });
const turnEndCandidate = (event: TurnEndEvent) => ({
  event: "turn_end",
  turnIndex: event.turnIndex,
});
const sessionBeforeSwitchCandidate = (event: SessionBeforeSwitchEvent) => ({
  event: "session_before_switch",
  reason: event.reason,
  ...(event.targetSessionFile === undefined
    ? {}
    : { targetSessionFile: event.targetSessionFile }),
});
const sessionBeforeForkCandidate = (event: SessionBeforeForkEvent) => ({
  event: "session_before_fork",
  entryId: event.entryId,
  position: event.position,
});
const assertResultCandidate = (event: AssertResultEvent) => ({
  event: "assert_result",
  assertionRef: event.assertionRef,
  runId: event.runId,
  outcome: event.outcome,
  code: event.code,
});

/** `outcome` is exact enum matching; other result fields retain shared rules. */
function matchAssertResultFilter(
  filter: EntryFilter | undefined,
  candidate: Record<string, unknown>,
): boolean {
  if (!filter) return true;
  const { outcome, ...sharedFields } = filter;
  if (!matchFilter(sharedFields, candidate)) return false;
  if (outcome === undefined) return true;
  const actual = candidate.outcome;
  return Array.isArray(outcome)
    ? outcome.some((expected) => expected === actual)
    : outcome === actual;
}

const toolCallAdapter = defineHookAdapter<ToolCallEvent>({
  hook: "tool_call",
  failureAction: "block",
  aggregation: "first",
  feedback: "notify-error",
  candidate: toolCandidate,
  buildEnv,
  outcome: ([failure], event) => {
    const reason = failure.phase === "shell"
      ? `pi-assert: assertion "${failure.assertion.name}" rejected ${event.toolName} — \`${failure.command}\``
      : `pi-assert: assertion "${failure.assertion.name}" rejected ${event.toolName} during when — \`${failure.command}\``;
    return {
      action: "block",
      failures: [failure],
      messages: [reason],
      reason,
      feedbackMessage: reason,
    };
  },
});

const toolResultAdapter = defineHookAdapter<ToolResultEvent>({
  hook: "tool_result",
  failureAction: "patch",
  aggregation: "first",
  feedback: "notify-error",
  candidate: toolCandidate,
  buildEnv: buildResultEnv,
  outcome: ([failure], event) => {
    const reason = failure.phase === "shell"
      ? `pi-assert: assertion "${failure.assertion.name}" blocked ${event.toolName} result — \`${failure.command}\``
      : `pi-assert: assertion "${failure.assertion.name}" blocked ${event.toolName} result during when — \`${failure.command}\``;
    return {
      action: "patch",
      failures: [failure],
      messages: [reason],
      reason,
      feedbackMessage: reason,
      patch: {
        content: [{
          type: "text",
          text: `[BLOCKED by pi-assert] ${reason}\n\nThe original tool result was suppressed.`,
        }],
        // Undefined intentionally leaves the original details untouched in Pi.
        details: event.details,
        isError: true,
      },
    };
  },
});

const turnEndAdapter = defineHookAdapter<TurnEndEvent>({
  hook: "turn_end",
  failureAction: "report",
  aggregation: "all",
  feedback: "notify-error",
  skipIfAborted: true,
  candidate: turnEndCandidate,
  buildEnv: lifecycleBuilder("turn_end", turnEndCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    return {
      action: "report",
      failures,
      messages,
      feedbackMessage: reportMessage("turn_end", messages),
    };
  },
});

const agentEndAdapter = defineHookAdapter<AgentEndEvent>({
  hook: "agent_end",
  failureAction: "report",
  aggregation: "all",
  feedback: "corrective-turn",
  skipIfAborted: true,
  candidate: agentEndCandidate,
  buildEnv: lifecycleBuilder("agent_end", agentEndCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    return {
      action: "report",
      failures,
      messages,
      feedbackMessage:
        `${messages.length} assertion${messages.length === 1 ? "" : "s"} failed after your last turn:\n\n` +
        messages.join("\n"),
      fingerprint: messages.join("\n"),
      repeatedFeedbackMessage:
        "pi-assert: agent-end assertions still fail; automatic retry stopped.",
    };
  },
});

const agentSettledAdapter = defineHookAdapter<AgentSettledEvent>({
  hook: "agent_settled",
  failureAction: "report",
  aggregation: "all",
  feedback: "notify-error",
  candidate: agentSettledCandidate,
  buildEnv: lifecycleBuilder("agent_settled", agentSettledCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    return {
      action: "report",
      failures,
      messages,
      feedbackMessage: reportMessage("agent_settled", messages),
    };
  },
});

const sessionBeforeSwitchAdapter = defineHookAdapter<SessionBeforeSwitchEvent>({
  hook: "session_before_switch",
  failureAction: "cancel",
  aggregation: "all",
  feedback: "notify-error",
  candidate: sessionBeforeSwitchCandidate,
  buildEnv: lifecycleBuilder("session_before_switch", sessionBeforeSwitchCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    const reason =
      `pi-assert: session switch cancelled by ${messages.length} assertion${messages.length === 1 ? "" : "s"}:\n` +
      messages.join("\n");
    return {
      action: "cancel",
      failures,
      messages,
      reason,
      feedbackMessage: reason,
    };
  },
});

const sessionBeforeForkAdapter = defineHookAdapter<SessionBeforeForkEvent>({
  hook: "session_before_fork",
  failureAction: "cancel",
  aggregation: "all",
  feedback: "notify-error",
  candidate: sessionBeforeForkCandidate,
  buildEnv: lifecycleBuilder("session_before_fork", sessionBeforeForkCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    const reason =
      `pi-assert: session fork cancelled by ${messages.length} assertion${messages.length === 1 ? "" : "s"}:\n` +
      messages.join("\n");
    return {
      action: "cancel",
      failures,
      messages,
      reason,
      feedbackMessage: reason,
    };
  },
});

const assertResultAdapter = defineHookAdapter<AssertResultEvent>({
  hook: "assert_result",
  failureAction: "report",
  aggregation: "all",
  feedback: "notify-error",
  candidate: assertResultCandidate,
  matchesFilter: matchAssertResultFilter,
  buildEnv: lifecycleBuilder("assert_result", assertResultCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    return {
      action: "report",
      failures,
      messages,
      feedbackMessage: reportMessage("assert_result", messages),
    };
  },
});

/** Exhaustive registry: every accepted native or synthetic hook has one adapter. */
export const HOOK_ADAPTERS = {
  tool_call: toolCallAdapter,
  tool_result: toolResultAdapter,
  turn_end: turnEndAdapter,
  agent_end: agentEndAdapter,
  agent_settled: agentSettledAdapter,
  session_before_switch: sessionBeforeSwitchAdapter,
  session_before_fork: sessionBeforeForkAdapter,
  assert_result: assertResultAdapter,
} satisfies { [H in Hook]: HookAdapter<HookEventMap[H]> };

/** Read-only map form exposed for internal dispatchers such as assert_result. */
export const hookAdapterRegistry: ReadonlyMap<Hook, HookAdapter<unknown>> = new Map(
  Object.entries(HOOK_ADAPTERS) as [Hook, HookAdapter<unknown>][],
);

export function getHookAdapter<H extends Hook>(hook: H): HookAdapter<HookEventMap[H]> {
  return HOOK_ADAPTERS[hook] as HookAdapter<HookEventMap[H]>;
}
