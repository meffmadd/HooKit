import {
  isHookResultOutcome,
  isLifecycleEvent,
  type Action,
  type HookResultOutcome,
  type Event,
  type JsonValue,
  type PersistedHook,
  type PersistedPreset,
} from "./entry.js";

const HOOK_KEYS = new Set([
  "description",
  "event",
  "filter",
  "when",
  "shell",
  "action",
  "default",
]);
const PRESET_KEYS = new Set(["description", "preset", "default"]);
const ACTION_KEYS: Readonly<Record<Action["type"], ReadonlySet<string>>> = {
  interrupt: new Set(["type", "outcome", "code"]),
  shutdown: new Set(["type", "outcome", "code", "interrupt"]),
  compact: new Set(["type", "outcome", "code", "instructions"]),
  message: new Set([
    "type",
    "outcome",
    "code",
    "message",
    "delivery",
    "triggerTurn",
  ]),
  "emit-custom-event": new Set(["type", "outcome", "code", "name", "data"]),
};
const HOOK_RESULT_FILTER_KEYS = new Set([
  "event",
  "hookRef",
  "runId",
  "outcome",
  "code",
]);

const OUTCOMES_BY_EVENT: Readonly<Record<Event, readonly HookResultOutcome[]>> = {
  tool_call: ["pass", "block"],
  tool_result: ["pass", "patch"],
  turn_end: ["pass", "report"],
  agent_end: ["pass", "report"],
  agent_settled: ["pass", "report"],
  session_before_switch: ["pass", "cancel"],
  session_before_fork: ["pass", "cancel"],
  hook_result: ["pass", "report"],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilterValue(value: unknown): boolean {
  const scalar = (item: unknown): boolean =>
    item === null ||
    typeof item === "string" ||
    (typeof item === "number" && Number.isFinite(item)) ||
    typeof item === "boolean";
  return scalar(value) || (Array.isArray(value) && value.every(scalar));
}

export interface InvalidFilterRegex {
  readonly key: string;
  readonly index?: number;
  readonly pattern: string;
  readonly reason: string;
}

/** Return the first invalid string regex in an entry's filter, if any. */
export function findInvalidFilterRegex(
  definition: unknown,
): InvalidFilterRegex | null {
  if (!isPlainObject(definition) || !isPlainObject(definition.filter)) {
    return null;
  }
  for (const [key, value] of Object.entries(definition.filter)) {
    if (definition.event === "hook_result" && key === "outcome") continue;
    const patterns = Array.isArray(value) ? value : [value];
    for (let index = 0; index < patterns.length; index++) {
      const pattern = patterns[index];
      if (typeof pattern !== "string") continue;
      try {
        new RegExp(pattern);
      } catch (error) {
        return {
          key,
          ...(Array.isArray(value) ? { index } : {}),
          pattern,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  return null;
}

function scalarOrArray(
  value: unknown,
  predicate: (item: unknown) => boolean,
): boolean {
  return Array.isArray(value) ? value.every(predicate) : predicate(value);
}

function nonEmptyScalarOrArray(
  value: unknown,
  predicate: (item: unknown) => boolean,
): boolean {
  return Array.isArray(value)
    ? value.length > 0 && value.every(predicate)
    : predicate(value);
}

function validJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = value.every((item) => validJsonValue(item, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    valid = (prototype === Object.prototype || prototype === null) &&
      Object.values(value).every((item) => validJsonValue(item, ancestors));
  }
  ancestors.delete(value);
  return valid;
}

function possibleActionSelector(
  event: Event,
  outcomeValue: unknown,
  codeValue: unknown,
): boolean {
  const outcomes = (Array.isArray(outcomeValue)
    ? outcomeValue
    : [outcomeValue]) as HookResultOutcome[];
  const allowed = OUTCOMES_BY_EVENT[event];
  if (outcomes.some((outcome) => !allowed.includes(outcome))) return false;
  if (codeValue === undefined) return true;

  const codes = (Array.isArray(codeValue) ? codeValue : [codeValue]) as Array<
    number | null
  >;
  return outcomes.some((outcome) =>
    codes.some((code) =>
      outcome === "pass" ? code === 0 : code === null || code !== 0
    )
  );
}

function validAction(value: unknown, event: Event): value is Action {
  if (!isPlainObject(value) || typeof value.type !== "string") return false;
  if (!Object.prototype.hasOwnProperty.call(ACTION_KEYS, value.type)) return false;
  const type = value.type as Action["type"];
  if (Object.keys(value).some((key) => !ACTION_KEYS[type].has(key))) return false;
  if (!nonEmptyScalarOrArray(value.outcome, isHookResultOutcome)) return false;
  if (
    value.code !== undefined &&
    !nonEmptyScalarOrArray(
      value.code,
      (item) => item === null ||
        (typeof item === "number" && Number.isFinite(item)),
    )
  ) {
    return false;
  }
  if (!possibleActionSelector(event, value.outcome, value.code)) return false;

  switch (type) {
    case "interrupt":
      return true;
    case "shutdown":
      return value.interrupt === undefined || typeof value.interrupt === "boolean";
    case "compact":
      return value.instructions === undefined || typeof value.instructions === "string";
    case "message":
      return typeof value.message === "string" &&
        (value.delivery === "steer" ||
          value.delivery === "followUp" ||
          value.delivery === "nextTurn") &&
        (value.triggerTurn === undefined || typeof value.triggerTurn === "boolean") &&
        !(value.delivery === "nextTurn" && value.triggerTurn === true);
    case "emit-custom-event":
      return typeof value.name === "string" && value.name.trim().length > 0 &&
        (value.data === undefined || validJsonValue(value.data));
  }
}

function validHookResultFilter(filter: unknown): boolean {
  if (!isPlainObject(filter)) return false;
  if (Object.keys(filter).some((key) => !HOOK_RESULT_FILTER_KEYS.has(key))) {
    return false;
  }
  if (filter.event !== undefined &&
      !scalarOrArray(filter.event, (value) => typeof value === "string")) {
    return false;
  }
  if (filter.hookRef !== undefined &&
      !scalarOrArray(filter.hookRef, (value) => typeof value === "string")) {
    return false;
  }
  if (filter.runId !== undefined &&
      !scalarOrArray(filter.runId, (value) => typeof value === "string")) {
    return false;
  }
  if (filter.outcome !== undefined &&
      !scalarOrArray(filter.outcome, isHookResultOutcome)) {
    return false;
  }
  if (filter.code !== undefined &&
      !scalarOrArray(
        filter.code,
        (value) => value === null ||
          (typeof value === "number" && Number.isFinite(value)),
      )) {
    return false;
  }
  return true;
}

function validExecutableFields(definition: Record<string, unknown>): boolean {
  if (typeof definition.description !== "string" ||
      !isLifecycleEvent(definition.event)) {
    return false;
  }
  if (definition.when !== undefined && typeof definition.when !== "string") {
    return false;
  }
  if (definition.default !== undefined && typeof definition.default !== "boolean") {
    return false;
  }
  if (definition.filter !== undefined) {
    if (!isPlainObject(definition.filter) ||
        !Object.values(definition.filter).every(isFilterValue) ||
        findInvalidFilterRegex(definition)) {
      return false;
    }
    if (definition.event === "hook_result" &&
        !validHookResultFilter(definition.filter)) {
      return false;
    }
  }
  return true;
}

/** Validate the single persisted executable shape before catalog normalization. */
export function validateEntryShape(
  definition: unknown,
): definition is PersistedHook {
  if (!isPlainObject(definition) ||
      Object.keys(definition).some((key) => !HOOK_KEYS.has(key)) ||
      !validExecutableFields(definition)) {
    return false;
  }
  const hasShell = definition.shell !== undefined;
  const hasAction = definition.action !== undefined;
  if (!hasShell && !hasAction) return false;
  if (hasShell && typeof definition.shell !== "string") return false;
  return !hasAction || validAction(definition.action, definition.event as Event);
}

/** Qualified preset refs are `local/name` or `owner/repo/name`. */
export const REF_RE =
  /^local\/[A-Za-z0-9._-]+$|^(?!local\/)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function validatePresetShape(
  definition: unknown,
): definition is PersistedPreset {
  if (!isPlainObject(definition)) return false;
  if (Object.keys(definition).some((key) => !PRESET_KEYS.has(key))) return false;
  if (typeof definition.description !== "string") return false;
  if (definition.default !== undefined && typeof definition.default !== "boolean") {
    return false;
  }
  return Array.isArray(definition.preset) &&
    definition.preset.every(
      (ref) => typeof ref === "string" && REF_RE.test(ref),
    );
}

export type HookEntryKind = { kind: "hook" } | { kind: "preset" };

export function validateHookEntry(definition: unknown): HookEntryKind | null {
  if (validatePresetShape(definition)) return { kind: "preset" };
  if (validateEntryShape(definition)) return { kind: "hook" };
  return null;
}
