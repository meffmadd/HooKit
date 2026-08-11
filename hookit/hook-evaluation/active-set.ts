import type { ActiveHook } from "./hooks.js";

const hooksBySet = new WeakMap<ActiveHookSet, readonly ActiveHook[]>();
const activeSetBrand: unique symbol = Symbol("hookit.active-set");

/**
 * Opaque immutable collection consumed by Hook Evaluation.
 *
 * Its hooks are deliberately not exposed: callers can replace an Active
 * Hook Set, but cannot mutate one while an evaluation is in progress.
 */
export interface ActiveHookSet {
  readonly size: number;
  readonly [activeSetBrand]: true;
}

/**
 * Capture one deterministic Active Hook Set. The caller's ordered
 * membership is copied onto an immutable array (so later activation or
 * catalog replacement cannot affect this set), and the set shell is frozen.
 * Individual Hooks are reused as-is: they are already immutable
 * catalog-owned records, so no per-callback recursive deep clone/freeze is
 * needed.
 */
export function createActiveHookSet(
  hooks: readonly ActiveHook[],
): ActiveHookSet {
  const copied = Object.freeze(Array.from(hooks));
  const set = Object.freeze({
    size: copied.length,
    [activeSetBrand]: true as const,
  });
  hooksBySet.set(set, copied);
  return set;
}

/** Private implementation access; not re-exported by the module facade. */
export function hooksIn(
  set: ActiveHookSet,
): readonly ActiveHook[] {
  const hooks = hooksBySet.get(set);
  if (!hooks) throw new TypeError("Invalid Active Hook Set");
  return hooks;
}
