import type { Event, ReadonlyEntryFilter } from "../domain/entry.js";
import type { ActiveHook } from "./hooks.js";
import {
  buildLifecycleEnvironment,
  buildToolCallEnvironment,
  buildToolResultEnvironment,
  matchFilter,
  matchResultSelector,
} from "./environment.js";
import type { ShellResult } from "./shell.js";
import type {
  EvaluationEventMap,
  EvaluationContext,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultPatch,
} from "./types.js";

export type FailureAction = "block" | "patch" | "cancel" | "report";
type FeedbackPolicy = "present-error" | "corrective-turn";

export interface HookFailure {
  readonly hook: ActiveHook;
  readonly phase: "when" | "shell";
  readonly command: string;
  readonly result: ShellResult;
}

interface OutcomeBase {
  readonly action: FailureAction;
  readonly failures: readonly HookFailure[];
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

export interface EventAdapter<E> {
  readonly event: Event;
  readonly failureAction: FailureAction;
  readonly feedback: FeedbackPolicy;
  readonly skipHooksIfAborted?: boolean;
  candidate(event: E): Record<string, unknown>;
  matchesFilter?(
    filter: ReadonlyEntryFilter | undefined,
    candidate: Record<string, unknown>,
  ): boolean;
  buildEnvironment(
    event: E,
    context: EvaluationContext,
  ): Record<string, string>;
  outcome(failures: readonly HookFailure[], event: E): AdapterOutcome;
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

function lifecycleBuilder<H extends Event>(
  event: H,
  candidate: (event: EvaluationEventMap[H]) => Record<string, unknown>,
): (
  payload: EvaluationEventMap[H],
  context: EvaluationContext,
) => Record<string, string> {
  return (payload, context) =>
    buildLifecycleEnvironment(event, candidate(payload), context);
}

function failureLine(failure: HookFailure): string {
  const { hook, phase, command, result } = failure;
  return phase === "shell"
    ? `- **${hook.name}**: \`${command}\` (exit ${result.code})`
    : `- **${hook.name}** (when): \`${command}\` (exit ${result.code})`;
}

function reportMessage(event: Event, messages: readonly string[]): string {
  return `HooKit: ${messages.length} ${event} hook${
    messages.length === 1 ? "" : "s"
  } failed:\n${messages.join("\n")}`;
}

function reportInternalError(event: Event, error: unknown): ReportOutcome {
  const message =
    `HooKit: ${event} hooks failed to execute — ${errorDetail(error)}`;
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
const hookResultCandidate = (
  event: EvaluationEventMap["hook_result"],
) => ({
  event: "hook_result",
  hookRef: event.hookRef,
  runId: event.runId,
  outcome: event.outcome,
  code: event.code,
});

function matchHookResultFilter(
  filter: ReadonlyEntryFilter | undefined,
  candidate: Record<string, unknown>,
): boolean {
  if (!filter) return true;
  const { outcome, code, ...shared } = filter;
  return matchFilter(shared, candidate) &&
    matchResultSelector({ outcome, code }, {
      outcome: candidate.outcome,
      code: candidate.code,
    });
}

function toolCallFailureReason(
  failure: HookFailure,
  event: ToolCallEvent,
): string {
  return failure.phase === "shell"
    ? `hookit: hook "${failure.hook.name}" rejected ${event.toolName} — \`${failure.command}\``
    : `hookit: hook "${failure.hook.name}" rejected ${event.toolName} during when — \`${failure.command}\``;
}

function toolResultFailureReason(
  failure: HookFailure,
  event: ToolResultEvent,
): string {
  return failure.phase === "shell"
    ? `hookit: hook "${failure.hook.name}" blocked ${event.toolName} result — \`${failure.command}\``
    : `hookit: hook "${failure.hook.name}" blocked ${event.toolName} result during when — \`${failure.command}\``;
}

function aggregateToolReasons(
  label: string,
  reasons: readonly string[],
): string {
  return reasons.length === 1
    ? reasons[0]!
    : `hookit: ${reasons.length} hooks ${label}:\n${
      reasons.map((reason) => `- ${reason}`).join("\n")
    }`;
}

const toolCallAdapter: EventAdapter<EvaluationEventMap["tool_call"]> = {
  event: "tool_call",
  failureAction: "block",
  feedback: "present-error",
  candidate: toolCandidate,
  buildEnvironment: buildToolCallEnvironment,
  outcome: (failures, event) => {
    const messages = failures.map((failure) => toolCallFailureReason(failure, event));
    const reason = aggregateToolReasons(`rejected ${event.toolName}`, messages);
    return {
      action: "block",
      failures,
      messages,
      reason,
      feedbackMessage: reason,
    };
  },
  internalError: (error) => {
    const reason =
      `hookit: tool-call guard failed to execute; call blocked — ${errorDetail(error)}`;
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

const toolResultAdapter: EventAdapter<EvaluationEventMap["tool_result"]> = {
  event: "tool_result",
  failureAction: "patch",
  feedback: "present-error",
  candidate: toolCandidate,
  buildEnvironment: buildToolResultEnvironment,
  outcome: (failures, event) => {
    const messages = failures.map((failure) => toolResultFailureReason(failure, event));
    const reason = aggregateToolReasons(`blocked ${event.toolName} result`, messages);
    return {
      action: "patch",
      failures,
      messages,
      reason,
      feedbackMessage: reason,
      patch: {
        content: [{
          type: "text",
          text: `[BLOCKED by HooKit] ${reason}\n\nThe original tool result was suppressed.`,
        }],
        details: event.details,
        isError: true,
      },
    };
  },
  internalError: (error, event) => {
    const reason =
      `hookit: tool-result guard failed to execute; result suppressed — ${errorDetail(error)}`;
    return {
      action: "patch",
      failures: [],
      messages: [reason],
      reason,
      feedbackMessage: reason,
      patch: {
        content: [{
          type: "text",
          text: `[BLOCKED by HooKit] ${reason}\n\nThe original tool result was suppressed.`,
        }],
        details: event.details,
        isError: true,
      },
      infrastructureError: true,
    };
  },
};

const turnEndAdapter: EventAdapter<EvaluationEventMap["turn_end"]> = {
  event: "turn_end",
  failureAction: "report",
  feedback: "present-error",
  skipHooksIfAborted: true,
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

const agentEndAdapter: EventAdapter<EvaluationEventMap["agent_end"]> = {
  event: "agent_end",
  failureAction: "report",
  feedback: "corrective-turn",
  skipHooksIfAborted: true,
  candidate: agentEndCandidate,
  buildEnvironment: lifecycleBuilder("agent_end", agentEndCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    return {
      action: "report",
      failures,
      messages,
      feedbackMessage:
        `${messages.length} hook${messages.length === 1 ? "" : "s"} failed after your last turn:\n\n` +
        messages.join("\n"),
      fingerprint: messages.join("\n"),
      repeatedFeedbackMessage:
        "hookit: agent-end hooks still fail; automatic retry stopped.",
    };
  },
  internalError: (error) => reportInternalError("agent_end", error),
};

const agentSettledAdapter: EventAdapter<EvaluationEventMap["agent_settled"]> = {
  event: "agent_settled",
  failureAction: "report",
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
    `hookit: session ${label} guard failed to execute; action cancelled — ${errorDetail(error)}`;
  return {
    action: "cancel",
    failures: [],
    messages: [reason],
    reason,
    feedbackMessage: reason,
    infrastructureError: true,
  };
}

const sessionSwitchAdapter: EventAdapter<
  EvaluationEventMap["session_before_switch"]
> = {
  event: "session_before_switch",
  failureAction: "cancel",
  feedback: "present-error",
  candidate: sessionSwitchCandidate,
  buildEnvironment: lifecycleBuilder(
    "session_before_switch",
    sessionSwitchCandidate,
  ),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    const reason =
      `hookit: session switch cancelled by ${messages.length} hook${
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

const sessionForkAdapter: EventAdapter<
  EvaluationEventMap["session_before_fork"]
> = {
  event: "session_before_fork",
  failureAction: "cancel",
  feedback: "present-error",
  candidate: sessionForkCandidate,
  buildEnvironment: lifecycleBuilder("session_before_fork", sessionForkCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    const reason =
      `hookit: session fork cancelled by ${messages.length} hook${
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

const hookResultAdapter: EventAdapter<EvaluationEventMap["hook_result"]> = {
  event: "hook_result",
  failureAction: "report",
  feedback: "present-error",
  candidate: hookResultCandidate,
  matchesFilter: matchHookResultFilter,
  buildEnvironment: lifecycleBuilder("hook_result", hookResultCandidate),
  outcome: (failures) => {
    const messages = failures.map(failureLine);
    return {
      action: "report",
      failures,
      messages,
      feedbackMessage: reportMessage("hook_result", messages),
    };
  },
  internalError: (error) => reportInternalError("hook_result", error),
};

const ADAPTERS = {
  tool_call: toolCallAdapter,
  tool_result: toolResultAdapter,
  turn_end: turnEndAdapter,
  agent_end: agentEndAdapter,
  agent_settled: agentSettledAdapter,
  session_before_switch: sessionSwitchAdapter,
  session_before_fork: sessionForkAdapter,
  hook_result: hookResultAdapter,
} satisfies { [H in Event]: EventAdapter<EvaluationEventMap[H]> };

export function adapterFor<H extends Event>(
  event: H,
): EventAdapter<EvaluationEventMap[H]> {
  return ADAPTERS[event] as EventAdapter<EvaluationEventMap[H]>;
}

export function formatErrorDetail(error: unknown): string {
  return errorDetail(error);
}
