import type {
  Action,
  Hook,
  ReadonlyEntryFilter,
} from "../domain/entry.js";

interface ActiveExecutableBase {
  readonly source: string;
  readonly name: string;
  readonly description: string;
  readonly hook: Hook;
  readonly filter?: ReadonlyEntryFilter;
  readonly when?: string;
}

/** Shell assertion shape accepted when constructing an Active Assertion Set. */
export interface ActiveAssertion extends ActiveExecutableBase {
  readonly shell: string;
}

/** Declarative Action Handler in one Active Assertion Set. */
export interface ActiveActionHandler extends ActiveExecutableBase {
  readonly action: Action;
}

export type ActiveExecutable = ActiveAssertion | ActiveActionHandler;

export function isActiveActionHandler(
  entry: ActiveExecutable,
): entry is ActiveActionHandler {
  return "action" in entry;
}

export function isActiveAssertion(
  entry: ActiveExecutable,
): entry is ActiveAssertion {
  return "shell" in entry;
}
