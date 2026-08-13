import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  Action,
  ActionRequest,
  ActionType,
  Event,
  HookOutcome,
  HookResultEvent,
  NativeEvent,
} from "../domain/entry.js";

/** Minimal native tool-call Event consumed by Hook Evaluation. */
export interface ToolCallEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
}

/** Minimal native tool-result Event consumed by Hook Evaluation. */
export interface ToolResultEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
  readonly content: readonly (TextContent | ImageContent)[];
  readonly isError: boolean;
  readonly details?: unknown;
}

/** Bounded native metadata consumed by the turn-end policy. */
export interface TurnEndEvent {
  readonly turnIndex: number;
}

/** Rich agent-end messages are intentionally outside the bounded seam. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AgentEndEvent {}

/** agent_settled currently contributes no event-specific metadata. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AgentSettledEvent {}

export interface SessionBeforeSwitchEvent {
  readonly reason: "new" | "resume";
  readonly targetSessionFile?: string;
}

export interface SessionBeforeForkEvent {
  readonly entryId: string;
  readonly position: "before" | "at";
}

/** Compile-time coupling between each supported Native Event and its payload. */
export interface EventMap {
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  turn_end: TurnEndEvent;
  agent_end: AgentEndEvent;
  agent_settled: AgentSettledEvent;
  session_before_switch: SessionBeforeSwitchEvent;
  session_before_fork: SessionBeforeForkEvent;
}

/** Internal extension of the native map used only for Hook Result Event dispatch. */
export interface EvaluationEventMap extends EventMap {
  hook_result: HookResultEvent;
}

/** Patch translated by the Pi adapter into a native tool_result callback. */
export interface ToolResultPatch {
  readonly content?: readonly (TextContent | ImageContent)[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

/** Bounded, immutable Pi runtime metadata exposed to Hook shells. */
export interface RuntimeMetadataSnapshot {
  readonly PI_SESSION_ID?: string;
  readonly PI_SESSION_FILE?: string;
  readonly PI_SESSION_NAME?: string;
  readonly PI_SESSION_LEAF_ID?: string;
  readonly PI_PROVIDER?: string;
  readonly PI_MODEL?: string;
  readonly PI_REASONING_LEVEL?: string;
  readonly PI_MODE?: string;
  readonly PI_PROJECT_TRUSTED?: "true" | "false";
  readonly PI_CONTEXT_TOKENS?: string;
  readonly PI_CONTEXT_WINDOW?: string;
  readonly PI_CONTEXT_PERCENT?: string;
  readonly [key: string]: string | undefined;
}

/** Non-Pi execution context captured once at Native Event callback entry. */
export interface EvaluationContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly metadata: RuntimeMetadataSnapshot;
}

export type PresentationSeverity = "info" | "warning" | "error";

/** Delivery-neutral semantic work for the thin Pi adapter. */
export type Effect =
  | {
      readonly type: "present";
      readonly message: string;
      readonly severity: PresentationSeverity;
    }
  | {
      readonly type: "request-corrective-turn";
      readonly message: string;
    }
  | {
      readonly type: "request-action";
      readonly hookRef: string;
      readonly invocationId: string;
      readonly action: ActionRequest;
    };

/** Immutable result shared privately by aggregation, Actions, and projection. */
export interface HookResult {
  readonly hookRef: string;
  readonly invocationId: string;
  readonly outcome: HookOutcome;
  readonly code: number | null;
  readonly action?: Action;
  readonly originatingResult?: OriginatingHookResult;
}

/** Result identity that causally associates a reactive Hook Invocation. */
export interface OriginatingHookResult {
  readonly hookRef: string;
  readonly invocationId: string;
  readonly outcome: HookOutcome;
}

/** Projected identity of a reactive origin annotation on a report row. */
export interface ReportOrigin {
  readonly hookRef: string;
  readonly outcome: HookOutcome;
}

/**
 * One ordered, delivery-neutral Evaluation Report row. Rows intentionally
 * carry no Invocation ID, row-level Event, origin Invocation ID, Action payload
 * text, or shell command text.
 */
export type EvaluationReportRow =
  | {
      readonly type: "hook";
      readonly hookRef: string;
      readonly durationMs: number;
      readonly passed: boolean;
      readonly origin?: ReportOrigin;
    }
  | {
      readonly type: "action";
      readonly hookRef: string;
      readonly actionType: ActionType;
      readonly outcome: HookOutcome;
      readonly origin?: ReportOrigin;
    };

/** Immutable, delivery-neutral accounting for one complete Hook Evaluation. */
export interface EvaluationReport {
  readonly rows: readonly EvaluationReportRow[];
}

interface EventOutcomeBase<H extends Event> {
  readonly event: H;
}

export interface PassEventOutcome<H extends NativeEvent = NativeEvent>
  extends EventOutcomeBase<H> {
  readonly outcome: "pass";
}

export interface BlockEventOutcome
  extends EventOutcomeBase<"tool_call"> {
  readonly outcome: "block";
  readonly reason: string;
}

export interface PatchEventOutcome
  extends EventOutcomeBase<"tool_result"> {
  readonly outcome: "patch";
  readonly reason: string;
  readonly patch: ToolResultPatch;
}

export interface CancelEventOutcome<
  H extends "session_before_switch" | "session_before_fork" =
    "session_before_switch" | "session_before_fork",
> extends EventOutcomeBase<H> {
  readonly outcome: "cancel";
  readonly reason: string;
}

export interface ReportEventOutcome<
  H extends "turn_end" | "agent_end" | "agent_settled" =
    "turn_end" | "agent_end" | "agent_settled",
> extends EventOutcomeBase<H> {
  readonly outcome: "report";
}

export interface PassHookResultEventOutcome
  extends EventOutcomeBase<"hook_result"> {
  readonly hookRef: string;
  readonly invocationId: string;
  readonly outcome: "pass";
}

export interface ReportHookResultEventOutcome
  extends EventOutcomeBase<"hook_result"> {
  readonly hookRef: string;
  readonly invocationId: string;
  readonly outcome: "report";
}

export type HookResultEventOutcome =
  | PassHookResultEventOutcome
  | ReportHookResultEventOutcome;

/** Event-typed map of every valid aggregate Event Outcome. */
export interface EventOutcomeMap {
  tool_call: PassEventOutcome<"tool_call"> | BlockEventOutcome;
  tool_result: PassEventOutcome<"tool_result"> | PatchEventOutcome;
  turn_end: PassEventOutcome<"turn_end"> | ReportEventOutcome<"turn_end">;
  agent_end: PassEventOutcome<"agent_end"> | ReportEventOutcome<"agent_end">;
  agent_settled:
    | PassEventOutcome<"agent_settled">
    | ReportEventOutcome<"agent_settled">;
  session_before_switch:
    | PassEventOutcome<"session_before_switch">
    | CancelEventOutcome<"session_before_switch">;
  session_before_fork:
    | PassEventOutcome<"session_before_fork">
    | CancelEventOutcome<"session_before_fork">;
  hook_result: HookResultEventOutcome;
}

export type EventOutcome<H extends Event = Event> = EventOutcomeMap[H];
export type NativeEventOutcome<H extends NativeEvent = NativeEvent> =
  EventOutcomeMap[H];

/** Deeply immutable output of one complete Hook Evaluation. */
export interface HookEvaluationOutcome<H extends NativeEvent = NativeEvent> {
  readonly eventOutcomes: readonly [
    NativeEventOutcome<H>,
    ...HookResultEventOutcome[],
  ];
  readonly effects: readonly Effect[];
  readonly evaluationReport?: EvaluationReport;
}
