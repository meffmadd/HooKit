import type {
  Action,
  Event,
  ReadonlyEntryFilter,
} from "../domain/entry.js";

/** The one normalized executable shape in an Active Hook Set. */
export interface ActiveHook {
  readonly source: string;
  readonly name: string;
  readonly description: string;
  readonly event: Event;
  readonly filter?: ReadonlyEntryFilter;
  readonly when?: string;
  readonly shell: string;
  readonly action?: Action;
}
