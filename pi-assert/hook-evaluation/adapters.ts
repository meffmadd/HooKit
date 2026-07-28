import type { Hook, ReadonlyEntryFilter } from "../domain/entry.js";
import type { ActiveAssertion } from "./assertions.js";
import {
  buildLifecycleEnvironment,
  buildToolCallEnvironment,
  buildToolResultEnvironment,
  matchFilter,
} from "./environment.js";
import type { ShellResult } from "./shell.js";
import type {
  EvaluationEventMap,
  HookExecutionContext,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultPatch,
} from "./types.js";

export type FailureAction = "block" | "patch" | "cancel" | "report";
type FailureAggregation = "first" | "all";
type FeedbackPolicy = "present-error" | "corrective-turn";

export interface AssertionFailure {
  readonly assertion: ActiveAssertion;
  readonly phase: "when" | "shell";
  readonly command: string;
  readonly result: ShellResult;
}

interface OutcomeBase {
  readonly action: FailureAction;
  readonly failures: readonly AssertionFailure[];
  readonly messages: readonly string[];
  readonly feedbackMessage: string;
  readonly infrastructureError?: true;
}

export interface BlockOutcome extends OutcomeBase {
  readonly action: "block";
  readonly reason: string;
}

export interface PatchOutcome extends OutcomeBase {
  readonly action: "patch";
  readonly reason: string;
  readonly patch: ToolResultPatch;
}

export interface CancelOutcome extends OutcomeBase {
  readonly action: "cancel";
  readonly reason: string;
}

export interface ReportOutcome extends OutcomeBase {
  readonly action: "report";
  readonly fingerprint?: string;
  readonly repeatedFeedbackMessage?: string;
}

export type AdapterOutcome =
  | BlockOutcome
  | PatchOutcome
  | CancelOutcome
  | ReportOutcome;

export interface HookAdapter<E> {
  readonly hook: Hook;
  readonly failureAction: FailureAction;
  readonly aggregation: FailureAggregation;
  readonly feedback: FeedbackPolicy;
  readonly skipIfAborted?: boolean;
  candidate(event: E): Record<string, unknown>;
  matchesFilter?(
    filter: ReadonlyEntryFilter | undefined,
    candidate: Record<string, unknown>,
  ): boolean;
  buildEnvironment(
    event: E,
    context: HookExecutionContext,
  ): Record<string, string>;
  outcome(failures: readonly AssertionFailure[], event: E): AdapterOutcome;
  internalError(error: unknown, event: E): AdapterOutcome;
}

function errorDetail(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

function toolCandidate(
  event: ToolCallEvent | ToolResultEvent,
): Record<string, unknown> {
  return { ...event.input, toolName: event.toolName };
}

function lifecycleBuilder<H extends Hook>(
  hook: H,
  candidate: (event: EvaluationEventMap[H]) => Record<string, unknown>,
): (
  event: EvaluationEventMap[H],
  context: HookExecutionContext,
) => Record<string, string> {
  return (event, context) =>
    buildLifecycleEnvironment(hook, candidate(event), context);
}

function failureLine(failure: AssertionFailure): string {
  const { assertion, phase, command, result } = failure;
  return phase === "shell"
    ? `- **${assertion.name}**: \`${command}\` (exit ${result.code})`
    : `- **${assertion.name}** (when): \`${command}\` (exit ${result.code})`;
}

function reportMessage(hook: Hook, messages: readonly string[]): string {
  return `pi-assert: ${messages.length} ${hook} assertion${
    messages.length === 1 ? "" : "s"
  } failed:\n${messages.join("\n")}`;
}

function reportInternalError(hook: Hook, error: unknown): ReportOutcome {
  const message =
    `pi-assert: ${hook} assertions failed to execute — ${errorDetail(error)}`;
  return {
    action: "report",
    failures: [],
    messages: [message],
    feedbackMessage: message,
    infrastructureError: true,
  };
}

const turnEndCandidate = (event: EvaluationEventMap["turn_end"]) => ({
  event: "turn_end",
  turnIndex: event.turnIndex,
});
const agentEndCandidate = () => ({ event: "agent_end" });
const agentSettledCandidate = () => ({ event: "agent_settled" });
const sessionSwitchCandidate = (
  event: EvaluationEventMap["session_before_switch"],
) => ({
  event: "session_before_switch",
  reason: event.reason,
  ...(event.targetSessionFile === undefined
    ? {}
    : { targetSessionFile: event.targetSessionFile }),
});
const sessionForkCandidate = (
  event: EvaluationEventMap["session_before_fork"],
) => ({
  event: "session_before_fork",
  entryId: event.entryId,
  position: event.position,
});
const assertResultCandidate = (
  event: EvaluationEventMap["assert_result"],
) => ({
  event: "assert_result",
  assertionRef: event.assertionRef,
  runId: event.runId,
  outcome: event.outcome,
  code: event.code,
});

function matchAssertResultFilter(
  filter: ReadonlyEntryFilter | undefined,
  candidate: Record<string, unknown>,
): boolean {
  if (!filter) return true;
  const { outcome, ...shared } = filter;
  if (!matchFilter(shared, candidate)) return false;
  if (outcome === undefined) return true;
  const actual = candidate.outcome;
  return Array.isArray(outcome)
    ? outcome.some((expected) => expected === actual)
    : outcome === actual;
}

const toolCallAdapter: HookAdapter<EvaluationEventMap["tool_call"]> = {
  hook: "tool_call",
  failureAction: "block",
  aggregation: "first",
  feedback: "present-error",
  candidate: toolCandidate,
  buildEnvironment: buildToolCallEnvironment,
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
  internalError: (error) => {
    const reason =
      `pi-assert: tool-call guard failed to execute; call blocked — ${errorDetail(error)}`;
    return {
      action: "block",
      failures: [],
      messages: [reason],
      reason,
      feedbackMessage: reason,
      infrastructureError: true,
    };
  },
};

const toolResultAdapter: HookAdapter<EvaluationEventMap["tool_result"]> = {
  hook: "tool_result",
  failureAction: "patch",
  aggregation: "first",
  feedback: "present-error",
  candidate: toolCandidate,
  buildEnvironment: buildToolResultEnvironment,
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
        details: event.details,
        isError: true,
      },
    };
  },
  internalError: (error, event) => {
    const reason =
      `pi-assert: tool-result guard failed to execute; result suppressed — ${errorDetail(error)}`;
    return {
      action: "patch",
      failures: [],
      messages: [reason],
      reason,
      feedbackMessage: reason,
      patch: {
        content: [{
          type: "text",
          text: `[BLOCKED by pi-assert] ${reason}\n\nThe original tool result was suppressed.`,
        }],
        details: event.details,
        isError: true,
      },
      infrastructureError: true,
    };
  },
};

const turnEndAdapter: HookAdapter<EvaluationEventMap["turn_end"]> = {
  hook: "turn_end",
  failureAction: "report",
  aggregation: "all",
  feedback: "present-error",
  skipIfAborted: true,
  candidate: turnEndCandidate,
  buildEnvironment: lifecycleBuilder("turn_end", turnEndCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    return {
      action: "report",
      failures,
      messages,
      feedbackMessage: reportMessage("turn_end", messages),
    };
  },
  internalError: (error) => reportInternalError("turn_end", error),
};

const agentEndAdapter: HookAdapter<EvaluationEventMap["agent_end"]> = {
  hook: "agent_end",
  failureAction: "report",
  aggregation: "all",
  feedback: "corrective-turn",
  skipIfAborted: true,
  candidate: agentEndCandidate,
  buildEnvironment: lifecycleBuilder("agent_end", agentEndCandidate),
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
  internalError: (error) => reportInternalError("agent_end", error),
};

const agentSettledAdapter: HookAdapter<EvaluationEventMap["agent_settled"]> = {
  hook: "agent_settled",
  failureAction: "report",
  aggregation: "all",
  feedback: "present-error",
  candidate: agentSettledCandidate,
  buildEnvironment: lifecycleBuilder("agent_settled", agentSettledCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    return {
      action: "report",
      failures,
      messages,
      feedbackMessage: reportMessage("agent_settled", messages),
    };
  },
  internalError: (error) => reportInternalError("agent_settled", error),
};

function sessionInternalError(
  label: "switch" | "fork",
  error: unknown,
): CancelOutcome {
  const reason =
    `pi-assert: session ${label} guard failed to execute; action cancelled — ${errorDetail(error)}`;
  return {
    action: "cancel",
    failures: [],
    messages: [reason],
    reason,
    feedbackMessage: reason,
    infrastructureError: true,
  };
}

const sessionSwitchAdapter: HookAdapter<
  EvaluationEventMap["session_before_switch"]
> = {
  hook: "session_before_switch",
  failureAction: "cancel",
  aggregation: "all",
  feedback: "present-error",
  candidate: sessionSwitchCandidate,
  buildEnvironment: lifecycleBuilder(
    "session_before_switch",
    sessionSwitchCandidate,
  ),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    const reason =
      `pi-assert: session switch cancelled by ${messages.length} assertion${
        messages.length === 1 ? "" : "s"
      }:\n${messages.join("\n")}`;
    return {
      action: "cancel",
      failures,
      messages,
      reason,
      feedbackMessage: reason,
    };
  },
  internalError: (error) => sessionInternalError("switch", error),
};

const sessionForkAdapter: HookAdapter<
  EvaluationEventMap["session_before_fork"]
> = {
  hook: "session_before_fork",
  failureAction: "cancel",
  aggregation: "all",
  feedback: "present-error",
  candidate: sessionForkCandidate,
  buildEnvironment: lifecycleBuilder("session_before_fork", sessionForkCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    const reason =
      `pi-assert: session fork cancelled by ${messages.length} assertion${
        messages.length === 1 ? "" : "s"
      }:\n${messages.join("\n")}`;
    return {
      action: "cancel",
      failures,
      messages,
      reason,
      feedbackMessage: reason,
    };
  },
  internalError: (error) => sessionInternalError("fork", error),
};

const assertResultAdapter: HookAdapter<EvaluationEventMap["assert_result"]> = {
  hook: "assert_result",
  failureAction: "report",
  aggregation: "all",
  feedback: "present-error",
  candidate: assertResultCandidate,
  matchesFilter: matchAssertResultFilter,
  buildEnvironment: lifecycleBuilder("assert_result", assertResultCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    return {
      action: "report",
      failures,
      messages,
      feedbackMessage: reportMessage("assert_result", messages),
    };
  },
  internalError: (error) => reportInternalError("assert_result", error),
};

const ADAPTERS = {
  tool_call: toolCallAdapter,
  tool_result: toolResultAdapter,
  turn_end: turnEndAdapter,
  agent_end: agentEndAdapter,
  agent_settled: agentSettledAdapter,
  session_before_switch: sessionSwitchAdapter,
  session_before_fork: sessionForkAdapter,
  assert_result: assertResultAdapter,
} satisfies { [H in Hook]: HookAdapter<EvaluationEventMap[H]> };

export function adapterFor<H extends Hook>(
  hook: H,
): HookAdapter<EvaluationEventMap[H]> {
  return ADAPTERS[hook] as HookAdapter<EvaluationEventMap[H]>;
}

export function formatErrorDetail(error: unknown): string {
  return errorDetail(error);
}
