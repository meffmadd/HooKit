import {
  isAssertResultOutcome,
  isLifecycleHook,
  type PersistedAssert,
  type PersistedPreset,
} from "./entry.js";

const ASSERT_KEYS = new Set([
  "description",
  "hook",
  "filter",
  "when",
  "shell",
  "default",
]);
const PRESET_KEYS = new Set(["description", "preset", "default"]);
const ASSERT_RESULT_FILTER_KEYS = new Set([
  "event",
  "assertionRef",
  "runId",
  "outcome",
  "code",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilterValue(value: unknown): boolean {
  const scalar = (item: unknown): boolean =>
    item === null ||
    typeof item === "string" ||
    typeof item === "number" ||
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
    if (definition.hook === "assert_result" && key === "outcome") continue;
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

function validAssertResultFilter(filter: unknown): boolean {
  if (!isPlainObject(filter)) return false;
  if (Object.keys(filter).some((key) => !ASSERT_RESULT_FILTER_KEYS.has(key))) {
    return false;
  }
  if (filter.event !== undefined &&
      !scalarOrArray(filter.event, (value) => typeof value === "string")) {
    return false;
  }
  if (filter.assertionRef !== undefined &&
      !scalarOrArray(filter.assertionRef, (value) => typeof value === "string")) {
    return false;
  }
  if (filter.runId !== undefined &&
      !scalarOrArray(filter.runId, (value) => typeof value === "string")) {
    return false;
  }
  if (filter.outcome !== undefined &&
      !scalarOrArray(filter.outcome, isAssertResultOutcome)) {
    return false;
  }
  if (filter.code !== undefined &&
      !scalarOrArray(
        filter.code,
        (value) => value === null || typeof value === "number",
      )) {
    return false;
  }
  return true;
}

export function validateEntryShape(
  definition: unknown,
): definition is PersistedAssert {
  if (!isPlainObject(definition)) return false;
  if (Object.keys(definition).some((key) => !ASSERT_KEYS.has(key))) return false;
  if (typeof definition.description !== "string" ||
      typeof definition.shell !== "string" ||
      !isLifecycleHook(definition.hook)) {
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
    if (definition.hook === "assert_result" &&
        !validAssertResultFilter(definition.filter)) {
      return false;
    }
  }
  return definition.preset === undefined;
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

export type RuleEntryKind = { kind: "assert" } | { kind: "preset" };

export function validateRuleEntry(definition: unknown): RuleEntryKind | null {
  if (validatePresetShape(definition)) return { kind: "preset" };
  if (validateEntryShape(definition)) return { kind: "assert" };
  return null;
}
