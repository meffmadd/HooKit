/** Shared entry types and identity/reference helpers. */

export const NATIVE_HOOKS = [
  "tool_call",
  "tool_result",
  "turn_end",
  "agent_end",
  "agent_settled",
  "session_before_switch",
  "session_before_fork",
] as const;

/** Every configurable hook, including pi-assert's synthetic result hook. */
export const LIFECYCLE_HOOKS = [...NATIVE_HOOKS, "assert_result"] as const;

export type NativeHook = (typeof NATIVE_HOOKS)[number];
export type Hook = (typeof LIFECYCLE_HOOKS)[number];

export const ASSERT_RESULT_OUTCOMES = [
  "pass",
  "block",
  "patch",
  "cancel",
  "report",
] as const;

export type AssertResultOutcome = (typeof ASSERT_RESULT_OUTCOMES)[number];

export function isAssertResultOutcome(value: unknown): value is AssertResultOutcome {
  return typeof value === "string" &&
    (ASSERT_RESULT_OUTCOMES as readonly string[]).includes(value);
}

/** Bounded synthetic event emitted after one assertion makes a decision. */
export interface AssertResultEvent {
  readonly event: "assert_result";
  readonly assertionRef: string;
  /** Correlation ID of the originating assertion invocation. */
  readonly runId: string;
  readonly outcome: AssertResultOutcome;
  readonly code: number | null;
}

/** Narrow an unknown config value to a lifecycle hook supported by an adapter. */
export function isLifecycleHook(value: unknown): value is Hook {
  return typeof value === "string" &&
    (LIFECYCLE_HOOKS as readonly string[]).includes(value);
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
  | AssertResultOutcome
  | readonly AssertResultOutcome[];
export type ResultCodeSelector =
  | number
  | null
  | readonly (number | null)[];

/** Result fields shared by owned Actions and `assert_result` filters. */
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

/** One outcome-selected Pi operation owned by an Assertion. */
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

export interface PersistedAssertion {
  description: string;
  hook: Hook;
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

export type PersistedEntry = PersistedAssertion | PersistedPreset;

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
export class AssertIndex<T extends { source: string; name: string }> {
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
