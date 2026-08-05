import type {
  Action,
  Hook,
  ReadonlyEntryFilter,
} from "../domain/entry.js";

/** The one normalized executable shape in an Active Assertion Set. */
export interface ActiveAssertion {
  readonly source: string;
  readonly name: string;
  readonly description: string;
  readonly hook: Hook;
  readonly filter?: ReadonlyEntryFilter;
  readonly when?: string;
  readonly shell: string;
  readonly action?: Action;
}
