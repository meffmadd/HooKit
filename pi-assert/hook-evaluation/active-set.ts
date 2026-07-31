import type { ActiveExecutable } from "./assertions.js";

const assertionsBySet = new WeakMap<ActiveAssertionSet, readonly ActiveExecutable[]>();
const activeSetBrand: unique symbol = Symbol("pi-assert.active-set");

/**
 * Opaque immutable collection consumed by Hook Evaluation.
 *
 * Its assertions are deliberately not exposed: callers can replace an Active
 * Assertion Set, but cannot mutate one while an evaluation is in progress.
 */
export interface ActiveAssertionSet {
  readonly size: number;
  readonly [activeSetBrand]: true;
}

function cloneNested<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value !== "object" || value === null) return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneNested(item, seen));
    return Object.freeze(copy) as T;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, nested] of Object.entries(value)) {
    copy[key] = cloneNested(nested, seen);
  }
  return Object.freeze(copy) as T;
}

function copyAssertion(assertion: ActiveExecutable): ActiveExecutable {
  return cloneNested({ ...assertion });
}

/** Copy and runtime-freeze one deterministic Active Assertion Set. */
export function createActiveAssertionSet(
  assertions: readonly ActiveExecutable[],
): ActiveAssertionSet {
  const copied = Object.freeze(assertions.map(copyAssertion));
  const set = Object.freeze({
    size: copied.length,
    [activeSetBrand]: true as const,
  });
  assertionsBySet.set(set, copied);
  return set;
}

/** Private implementation access; not re-exported by the module facade. */
export function assertionsIn(
  set: ActiveAssertionSet,
): readonly ActiveExecutable[] {
  const assertions = assertionsBySet.get(set);
  if (!assertions) throw new TypeError("Invalid Active Assertion Set");
  return assertions;
}
