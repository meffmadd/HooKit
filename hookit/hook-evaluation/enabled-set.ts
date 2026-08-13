import type { EnabledHook } from "./hooks.js";

const hooksBySet = new WeakMap<EnabledHookSet, readonly EnabledHook[]>();
const enabledSetBrand: unique symbol = Symbol("hookit.enabled-set");

/**
 * Opaque immutable collection consumed by Hook Evaluation.
 *
 * Its Hooks are deliberately not exposed: callers can replace an Enabled
 * Hook Set, but cannot mutate one while an Evaluation is in progress.
 */
export interface EnabledHookSet {
  readonly size: number;
  readonly [enabledSetBrand]: true;
}

/**
 * Capture one deterministic Enabled Hook Set. The caller's ordered
 * membership is copied onto an immutable array (so later enablement or
 * Catalog replacement cannot affect this set), and the set shell is frozen.
 * Individual Hooks are reused as-is: they are already immutable
 * catalog-owned records, so no per-callback recursive deep clone/freeze is
 * needed.
 */
export function createEnabledHookSet(
  hooks: readonly EnabledHook[],
): EnabledHookSet {
  const copied = Object.freeze(Array.from(hooks));
  const set = Object.freeze({
    size: copied.length,
    [enabledSetBrand]: true as const,
  });
  hooksBySet.set(set, copied);
  return set;
}

/** Private implementation access; not re-exported by the module facade. */
export function hooksIn(
  set: EnabledHookSet,
): readonly EnabledHook[] {
  const hooks = hooksBySet.get(set);
  if (!hooks) throw new TypeError("Invalid Enabled Hook Set");
  return hooks;
}
