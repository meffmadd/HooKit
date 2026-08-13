import type {
  Action,
  Event,
  ReadonlyEntryFilter,
  PersistedEntry,
} from "../domain/entry.js";

/** Canonical catalog identity. Names are unique only within a source. */
export interface HookIdentity {
  readonly source: string;
  readonly name: string;
}

interface CatalogEntryBase extends HookIdentity {
  readonly description: string;
  readonly default: boolean;
}

/** A validated, normalized Hook available to session enablement. */
export interface CatalogHook extends CatalogEntryBase {
  readonly event: Event;
  readonly filter?: ReadonlyEntryFilter;
  readonly when?: string;
  /** Always present; an omitted persisted shell is canonicalized to `true`. */
  readonly shell: string;
  readonly action?: Action;
}

/** A validated Preset containing only available or dangling Hook References. */
export interface CatalogPreset extends CatalogEntryBase {
  readonly preset: readonly string[];
}

export type CatalogEntry = CatalogHook | CatalogPreset;

export function isCatalogPreset(entry: CatalogEntry): entry is CatalogPreset {
  return "preset" in entry;
}

/** Filesystem locations authorized before catalog creation. */
export interface CatalogStorageLocations {
  readonly global: string;
  readonly project?: string;
}

export type CatalogStorage = "global" | "project";

/** One source-specific load, validation, mutation, or persistence failure. */
export interface CatalogDiagnostic {
  readonly storage?: CatalogStorage;
  readonly reason: string;
}

export interface CatalogSuccess {
  readonly ok: true;
  readonly catalog: import("./index.js").HookCatalog;
}

export interface CatalogFailure {
  readonly ok: false;
  readonly diagnostics: readonly CatalogDiagnostic[];
}

export type CatalogResult = CatalogSuccess | CatalogFailure;

/** A validated repository or local entry to persist in project storage. */
export interface CatalogInstallation {
  readonly identity: HookIdentity;
  readonly entry: PersistedEntry;
}

/** Domain intent accepted by an immutable catalog snapshot. */
export type CatalogMutation =
  | {
      readonly type: "install";
      readonly entries: readonly CatalogInstallation[];
    }
  | {
      readonly type: "update";
      readonly identity: HookIdentity;
      readonly entry: PersistedEntry;
    }
  | {
      readonly type: "remove";
      readonly identity: HookIdentity;
    }
  | {
      readonly type: "edit-local-preset";
      readonly identity: HookIdentity;
      readonly description: string;
      readonly preset: readonly string[];
    }
  | {
      readonly type: "set-default";
      readonly identity: HookIdentity;
      readonly value: boolean;
    }
  | {
      readonly type: "add-repository";
      readonly source: string;
    };
