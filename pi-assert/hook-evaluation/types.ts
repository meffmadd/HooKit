import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  Action,
  ActionRequest,
  ActionType,
  AssertResultEvent,
  AssertResultOutcome,
  Hook,
  NativeHook,
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

/** Compile-time coupling between each supported native hook and its event. */
export interface HookEventMap {
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  turn_end: TurnEndEvent;
  agent_end: AgentEndEvent;
  agent_settled: AgentSettledEvent;
  session_before_switch: SessionBeforeSwitchEvent;
  session_before_fork: SessionBeforeForkEvent;
}

/** Internal extension of the native map used only for synthetic dispatch. */
export interface EvaluationEventMap extends HookEventMap {
  assert_result: AssertResultEvent;
}

/** Patch translated by the Pi adapter into a native tool_result callback. */
export interface ToolResultPatch {
  readonly content?: readonly (TextContent | ImageContent)[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

/** Bounded, immutable Pi runtime metadata exposed to assertion shells. */
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
export interface HookExecutionContext {
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
      readonly assertionRef: string;
      readonly runId: string;
      readonly action: ActionRequest;
    };

/** Immutable result shared by aggregation, Actions, reporting, and dispatch. */
export interface AssertionResult extends AssertResultEvent {
  readonly hook: Hook;
  readonly action?: Action;
  readonly originatingResult?: OriginatingAssertionResult;
}

/** Result identity that causally associates a synthetic handler execution. */
export interface OriginatingAssertionResult {
  readonly assertionRef: string;
  readonly runId: string;
  readonly outcome: AssertResultOutcome;
}

/** One actually started main assertion shell, never a filter or precondition. */
export interface AssertionExecution {
  readonly assertionRef: string;
  readonly runId: string;
  readonly hook: Hook;
  readonly durationMs: number;
  readonly passed: boolean;
  readonly originatingResult?: OriginatingAssertionResult;
}

/** One configured action request, excluding unbounded action payload fields. */
export interface ActionRequestExecution {
  readonly assertionRef: string;
  readonly runId: string;
  readonly hook: Hook;
  readonly actionType: ActionType;
  /** The individual owner result that selected this Action. */
  readonly outcome: AssertResultOutcome;
  readonly originatingResult?: OriginatingAssertionResult;
}

/** Immutable, delivery-neutral accounting for one complete Hook Evaluation. */
export interface AssertionExecutionReport {
  readonly executions: readonly AssertionExecution[];
  readonly actionRequests: readonly ActionRequestExecution[];
}

interface EvaluationResultBase {
  readonly effects: readonly EvaluationEffect[];
  readonly executionReport?: AssertionExecutionReport;
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

/** Minimal result of one complete, hook-typed transaction. */
export type HookEvaluationResult<
  H extends NativeHook = NativeHook,
> = HookEvaluationResultMap[H];
