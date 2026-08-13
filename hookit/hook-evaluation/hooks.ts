import type {
  Action,
  Event,
  ReadonlyEntryFilter,
} from "../domain/entry.js";

/** The one normalized executable shape in an Enabled Hook Set. */
export interface EnabledHook {
  readonly source: string;
  readonly name: string;
  readonly description: string;
  readonly event: Event;
  readonly filter?: ReadonlyEntryFilter;
  readonly when?: string;
  readonly shell: string;
  readonly action?: Action;
}
