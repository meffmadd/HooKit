import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  Action,
  ActionRequest,
  ActionType,
  HookResultEvent,
  HookResultOutcome,
  Event,
  NativeEvent,
} from "../domain/entry.js";

/** Minimal native tool-call event consumed by Hook Evaluation. */
export interface ToolCallEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
}

/** Minimal native tool-result event consumed by Hook Evaluation. */
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

/** Compile-time coupling between each supported Event and its payload. */
export interface EventMap {
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  turn_end: TurnEndEvent;
  agent_end: AgentEndEvent;
  agent_settled: AgentSettledEvent;
  session_before_switch: SessionBeforeSwitchEvent;
  session_before_fork: SessionBeforeForkEvent;
}

/** Internal extension of the native map used only for synthetic dispatch. */
export interface EvaluationEventMap extends EventMap {
  hook_result: HookResultEvent;
}

/** Patch translated by the Pi adapter into a native tool_result callback. */
export interface ToolResultPatch {
  readonly content?: readonly (TextContent | ImageContent)[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

/** Bounded, immutable Pi runtime metadata exposed to hook shells. */
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

/** Non-Pi execution context captured once at native callback entry. */
export interface EvaluationContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly metadata: RuntimeMetadataSnapshot;
}

export type PresentationSeverity = "info" | "warning" | "error";

/** Delivery-neutral semantic work for the thin Pi adapter. */
export type EvaluationEffect =
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
      readonly runId: string;
      readonly action: ActionRequest;
    };

/** Immutable result shared by aggregation, Actions, reporting, and dispatch. */
export interface HookResult extends HookResultEvent {
  /** Event matched by the Hook that produced this result. */
  readonly evaluatedEvent: Event;
  readonly action?: Action;
  readonly originatingResult?: OriginatingHookResult;
}

/** Result identity that causally associates a synthetic handler execution. */
export interface OriginatingHookResult {
  readonly hookRef: string;
  readonly runId: string;
  readonly outcome: HookResultOutcome;
}

/** Projected identity of a synthetic origin annotation on a report row. */
export interface ReportOrigin {
  readonly hookRef: string;
  readonly outcome: HookResultOutcome;
}

/**
 * One ordered, delivery-neutral report row for a Hook Evaluation. Rows
 * intentionally carry no invocation identity (`runId`), row-level
 * `evaluatedEvent`, origin `runId`, Action payload text, or shell command text;
 * those stay in Hook Results, Action Requests, `hook_result` dispatch, and shell
 * environment variables.
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
      readonly outcome: HookResultOutcome;
      readonly origin?: ReportOrigin;
    };

/** Immutable, delivery-neutral accounting for one complete Hook Evaluation. */
export interface HookExecutionReport {
  readonly rows: readonly EvaluationReportRow[];
}

interface EvaluationResultBase {
  readonly effects: readonly EvaluationEffect[];
  readonly executionReport?: HookExecutionReport;
}

export interface PassEvaluationResult extends EvaluationResultBase {
  readonly outcome: "pass";
}

export interface BlockEvaluationResult extends EvaluationResultBase {
  readonly outcome: "block";
  readonly reason: string;
}

export interface PatchEvaluationResult extends EvaluationResultBase {
  readonly outcome: "patch";
  readonly reason: string;
  readonly patch: ToolResultPatch;
}

export interface CancelEvaluationResult extends EvaluationResultBase {
  readonly outcome: "cancel";
  readonly reason: string;
}

export interface ReportEvaluationResult extends EvaluationResultBase {
  readonly outcome: "report";
}

export interface HookEvaluationResultMap {
  tool_call: PassEvaluationResult | BlockEvaluationResult;
  tool_result: PassEvaluationResult | PatchEvaluationResult;
  turn_end: PassEvaluationResult | ReportEvaluationResult;
  agent_end: PassEvaluationResult | ReportEvaluationResult;
  agent_settled: PassEvaluationResult | ReportEvaluationResult;
  session_before_switch: PassEvaluationResult | CancelEvaluationResult;
  session_before_fork: PassEvaluationResult | CancelEvaluationResult;
}

/** Minimal result of one complete, Event-typed transaction. */
export type HookEvaluationResult<
  H extends NativeEvent = NativeEvent,
> = HookEvaluationResultMap[H];
