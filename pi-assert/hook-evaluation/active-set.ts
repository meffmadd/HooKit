import type { ActiveAssertion } from "./assertions.js";

const assertionsBySet = new WeakMap<ActiveAssertionSet, readonly ActiveAssertion[]>();
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

/**
 * Capture one deterministic Active Assertion Set. The caller's ordered
 * membership is copied onto an immutable array (so later activation or
 * catalog replacement cannot affect this set), and the set shell is frozen.
 * Individual Assertions are reused as-is: they are already immutable
 * catalog-owned records, so no per-callback recursive deep clone/freeze is
 * needed.
 */
export function createActiveAssertionSet(
  assertions: readonly ActiveAssertion[],
): ActiveAssertionSet {
  const copied = Object.freeze(Array.from(assertions));
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
): readonly ActiveAssertion[] {
  const assertions = assertionsBySet.get(set);
  if (!assertions) throw new TypeError("Invalid Active Assertion Set");
  return assertions;
}
