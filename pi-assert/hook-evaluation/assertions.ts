import type { Hook, ReadonlyEntryFilter } from "../domain/entry.js";

/** Shell assertion shape accepted when constructing an Active Assertion Set. */
export interface ActiveAssertion {
  readonly source: string;
  readonly name: string;
  readonly description: string;
  readonly hook: Hook;
  readonly filter?: ReadonlyEntryFilter;
  readonly when?: string;
  readonly shell: string;
}
