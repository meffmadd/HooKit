/** Shared entry types and identity/reference helpers. */

export const NATIVE_EVENTS = [
  "tool_call",
  "tool_result",
  "turn_end",
  "agent_end",
  "agent_settled",
  "session_before_switch",
  "session_before_fork",
] as const;

/** Every configurable event, including HooKit's synthetic hook_result event. */
export const LIFECYCLE_EVENTS = [...NATIVE_EVENTS, "hook_result"] as const;

export type NativeEvent = (typeof NATIVE_EVENTS)[number];
export type Event = (typeof LIFECYCLE_EVENTS)[number];

export const HOOK_RESULT_OUTCOMES = [
  "pass",
  "block",
  "patch",
  "cancel",
  "report",
] as const;

export type HookResultOutcome = (typeof HOOK_RESULT_OUTCOMES)[number];

export function isHookResultOutcome(value: unknown): value is HookResultOutcome {
  return typeof value === "string" &&
    (HOOK_RESULT_OUTCOMES as readonly string[]).includes(value);
}

/** Bounded synthetic event emitted after one Hook Result is produced. */
export interface HookResultEvent {
  readonly event: "hook_result";
  readonly hookRef: string;
  /** Correlation ID of the originating Hook Invocation. */
  readonly runId: string;
  readonly outcome: HookResultOutcome;
  readonly code: number | null;
}

/** Narrow an unknown config value to a lifecycle event supported by an adapter. */
export function isLifecycleEvent(value: unknown): value is Event {
  return typeof value === "string" &&
    (LIFECYCLE_EVENTS as readonly string[]).includes(value);
}

export type FilterScalar = string | number | boolean | null;
export type EntryFilter = Record<string, FilterScalar | FilterScalar[]>;
export type ReadonlyEntryFilter = Readonly<
  Record<string, FilterScalar | readonly FilterScalar[]>
>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ResultOutcomeSelector =
  | HookResultOutcome
  | readonly HookResultOutcome[];
export type ResultCodeSelector =
  | number
  | null
  | readonly (number | null)[];

/** Result fields shared by owned Actions and `hook_result` filters. */
export interface ReadonlyResultSelector {
  readonly outcome: ResultOutcomeSelector;
  readonly code?: ResultCodeSelector;
}

export interface InterruptAction {
  readonly type: "interrupt";
}

export interface ShutdownAction {
  readonly type: "shutdown";
  readonly interrupt?: boolean;
}

export interface CompactAction {
  readonly type: "compact";
  readonly instructions?: string;
}

export interface MessageAction {
  readonly type: "message";
  readonly message: string;
  readonly delivery: "steer" | "followUp" | "nextTurn";
  readonly triggerTurn?: boolean;
}

export interface EmitCustomEventAction {
  readonly type: "emit-custom-event";
  readonly name: string;
  readonly data?: JsonValue;
}

/** Delivery payload exposed after an owned Action's selectors are removed. */
export type ActionRequest =
  | InterruptAction
  | ShutdownAction
  | CompactAction
  | MessageAction
  | EmitCustomEventAction;

/** One outcome-selected Pi operation owned by a Hook. */
export type Action = ActionRequest & ReadonlyResultSelector;

export type ActionType = ActionRequest["type"];

export const ACTION_TYPES = [
  "interrupt",
  "shutdown",
  "compact",
  "message",
  "emit-custom-event",
] as const satisfies readonly ActionType[];

export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" &&
    (ACTION_TYPES as readonly string[]).includes(value);
}

export interface PersistedHook {
  description: string;
  event: Event;
  filter?: EntryFilter;
  when?: string;
  /** Omission is normalized to the canonical `true` command by the catalog. */
  shell?: string;
  action?: Action;
  default?: boolean;
}

export interface PersistedPreset {
  description: string;
  preset: string[];
  default?: boolean;
}

export type PersistedEntry = PersistedHook | PersistedPreset;

/** Deep-copy JSON data without retaining caller-owned arrays or objects. */
export function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneJsonValue(nested)]),
    );
  }
  return value;
}

function cloneSelector<T>(value: T | readonly T[]): T | T[] {
  return Array.isArray(value) ? value.slice() as T[] : value as T;
}

/** Copy one delivery payload without selector metadata. */
export function actionRequest(action: Action): ActionRequest {
  switch (action.type) {
    case "interrupt":
      return { type: "interrupt" };
    case "shutdown":
      return {
        type: "shutdown",
        ...(action.interrupt === undefined ? {} : { interrupt: action.interrupt }),
      };
    case "compact":
      return {
        type: "compact",
        ...(action.instructions === undefined
          ? {}
          : { instructions: action.instructions }),
      };
    case "message":
      return {
        type: "message",
        message: action.message,
        delivery: action.delivery,
        ...(action.triggerTurn === undefined
          ? {}
          : { triggerTurn: action.triggerTurn }),
      };
    case "emit-custom-event":
      return {
        type: "emit-custom-event",
        name: action.name,
        ...(action.data === undefined ? {} : { data: cloneJsonValue(action.data) }),
      };
  }
}

/** Copy one validated owned Action, including its result selectors. */
export function cloneAction(action: Action): Action {
  return {
    ...actionRequest(action),
    outcome: cloneSelector(action.outcome),
    ...(action.code === undefined ? {} : { code: cloneSelector(action.code) }),
  } as Action;
}

function selectorText<T>(value: T | readonly T[]): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** Canonical Action text shared by detail rendering and fuzzy search. */
export function actionDetailText(action: Action): string {
  const selector = `outcome: ${selectorText(action.outcome)}${
    action.code === undefined ? "" : ` · code: ${selectorText(action.code)}`
  } · type: `;
  switch (action.type) {
    case "interrupt":
      return `${selector}interrupt`;
    case "shutdown":
      return `${selector}shutdown · interrupt: ${action.interrupt ?? false}`;
    case "compact":
      return action.instructions === undefined
        ? `${selector}compact`
        : `${selector}compact · instructions: ${action.instructions}`;
    case "message":
      return `${selector}message · delivery: ${action.delivery} · triggerTurn: ${
        action.triggerTurn ?? false
      } · message: ${action.message}`;
    case "emit-custom-event":
      return `${selector}emit-custom-event · name: ${action.name}${
        action.data === undefined ? "" : ` · data: ${JSON.stringify(action.data)}`
      }`;
  }
}

/** Canonical identity. Names are unique only within a source. */
export function entryKey(source: string, name: string): string {
  return `${source}\x00${name}`;
}

/** Qualified preset reference. */
export function entryRef(source: string, name: string): string {
  return `${source}/${name}`;
}

/** Split a qualified ref on its last slash. */
export function parseEntryRef(ref: string): { source: string; name: string } | null {
  const index = ref.lastIndexOf("/");
  if (index <= 0 || index === ref.length - 1) return null;
  return { source: ref.slice(0, index), name: ref.slice(index + 1) };
}

/** Reusable lookup index for runtime or persisted entries. */
export class HookIndex<T extends { source: string; name: string }> {
  readonly byKey = new Map<string, T>();
  readonly byRef = new Map<string, T>();

  constructor(entries: Iterable<T>) {
    for (const entry of entries) {
      this.byKey.set(entryKey(entry.source, entry.name), entry);
      this.byRef.set(entryRef(entry.source, entry.name), entry);
    }
  }

  get(source: string, name: string): T | undefined {
    return this.byKey.get(entryKey(source, name));
  }

  getRef(ref: string): T | undefined {
    return this.byRef.get(ref);
  }
}
