import type { EntryFilter, PersistedEntry } from "../domain/entry.js";
import { cloneAction, entryKey } from "../domain/entry.js";
import {
  iterSections,
  readSectionedFile,
  validateSectionedFile,
  writeSectionedFile,
  type SectionedFile,
} from "./format.js";
import {
  validateActionHandlerShape,
  validateEntryShape,
  validatePresetShape,
  validateRuleEntry,
} from "../domain/validation.js";
import {
  isCatalogPreset,
  type AssertionIdentity,
  type CatalogDiagnostic,
  type CatalogEntry,
  type CatalogFailure,
  type CatalogInstallation,
  type CatalogMutation,
  type CatalogResult,
  type CatalogStorage,
  type CatalogStorageLocations,
} from "./types.js";

export { isCatalogActionHandler, isCatalogPreset } from "./types.js";
export type {
  AssertionIdentity,
  CatalogActionHandler,
  CatalogDiagnostic,
  CatalogEntry,
  CatalogExecutableEntry,
  CatalogFailure,
  CatalogInstallation,
  CatalogMutation,
  CatalogPreset,
  CatalogResult,
  CatalogShellAssertion,
  CatalogStorage,
  CatalogStorageLocations,
  CatalogSuccess,
} from "./types.js";

interface AuthorizedFile {
  readonly storage: CatalogStorage;
  readonly path: string;
  readonly content: SectionedFile;
}

interface CatalogSnapshot {
  readonly files: ReadonlyMap<CatalogStorage, AuthorizedFile>;
  readonly entries: CatalogEntry[];
  readonly repositories: string[];
  readonly provenance: ReadonlyMap<string, CatalogStorage>;
}

type SnapshotResult =
  | { readonly ok: true; readonly snapshot: CatalogSnapshot }
  | CatalogFailure;

const REPOSITORY_SOURCE = /^[^/]+\/[^/]+$/;

function failure(
  reason: string,
  storage?: CatalogStorage,
): CatalogFailure {
  return {
    ok: false,
    diagnostics: [{ ...(storage === undefined ? {} : { storage }), reason }],
  };
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identityLabel(identity: AssertionIdentity): string {
  return `${identity.source}/${identity.name}`;
}

function cloneLocations(
  locations: CatalogStorageLocations,
): CatalogStorageLocations {
  return {
    global: locations.global,
    ...(locations.project === undefined ? {} : { project: locations.project }),
  };
}

function readSnapshot(locations: CatalogStorageLocations): SnapshotResult {
  const requested: Array<readonly [CatalogStorage, string]> = [
    ["global", locations.global],
  ];
  if (locations.project !== undefined) {
    requested.push(["project", locations.project]);
  }

  const files = new Map<CatalogStorage, AuthorizedFile>();
  const diagnostics: CatalogDiagnostic[] = [];
  for (const [storage, path] of requested) {
    try {
      const content = readSectionedFile(path);
      const validationError = validateSectionedFile(content);
      if (validationError) {
        diagnostics.push({ storage, reason: validationError });
        continue;
      }
      files.set(storage, { storage, path, content });
    } catch (error) {
      diagnostics.push({ storage, reason: errorReason(error) });
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const project = files.get("project")?.content;
  const knownSources = project?.repos === undefined
    ? undefined
    : new Set(["local", ...project.repos]);
  const merged = new Map<string, CatalogEntry>();
  const provenance = new Map<string, CatalogStorage>();

  for (const storage of ["global", "project"] as const) {
    const file = files.get(storage);
    if (!file) continue;
    for (const { source, entries } of iterSections(file.content, knownSources)) {
      for (const [name, definition] of Object.entries(entries)) {
        const entry = catalogEntry(source, name, definition);
        // Complete validation above guarantees this branch is unreachable.
        if (!entry) continue;
        const key = entryKey(source, name);
        merged.set(key, entry);
        provenance.set(key, storage);
      }
    }
  }

  return {
    ok: true,
    snapshot: {
      files,
      entries: Array.from(merged.values()),
      repositories: project?.repos?.slice() ?? [],
      provenance,
    },
  };
}

function cloneFilter(filter: EntryFilter): EntryFilter {
  return Object.fromEntries(
    Object.entries(filter).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.slice() : value,
    ]),
  );
}

function catalogEntry(
  source: string,
  name: string,
  definition: unknown,
): CatalogEntry | undefined {
  if (validatePresetShape(definition)) {
    return {
      source,
      name,
      description: definition.description,
      preset: definition.preset.slice(),
      default: definition.default ?? false,
    };
  }
  if (validateEntryShape(definition)) {
    return {
      source,
      name,
      description: definition.description,
      hook: definition.hook,
      ...(definition.filter === undefined ? {} : { filter: cloneFilter(definition.filter) }),
      ...(definition.when === undefined ? {} : { when: definition.when }),
      shell: definition.shell,
      default: definition.default ?? false,
    };
  }
  if (validateActionHandlerShape(definition)) {
    return {
      source,
      name,
      description: definition.description,
      hook: definition.hook,
      ...(definition.filter === undefined ? {} : { filter: cloneFilter(definition.filter) }),
      ...(definition.when === undefined ? {} : { when: definition.when }),
      action: cloneAction(definition.action),
      default: definition.default ?? false,
    };
  }
  return undefined;
}

function persistedEntry(entry: PersistedEntry): Record<string, unknown> {
  if ("preset" in entry) {
    return {
      description: entry.description,
      preset: entry.preset.slice(),
      ...(entry.default === undefined ? {} : { default: entry.default }),
    };
  }
  if ("action" in entry) {
    return {
      description: entry.description,
      hook: entry.hook,
      action: cloneAction(entry.action),
      ...(entry.filter === undefined ? {} : { filter: cloneFilter(entry.filter) }),
      ...(entry.when === undefined ? {} : { when: entry.when }),
      ...(entry.default === undefined ? {} : { default: entry.default }),
    };
  }
  return {
    description: entry.description,
    hook: entry.hook,
    shell: entry.shell,
    ...(entry.filter === undefined ? {} : { filter: cloneFilter(entry.filter) }),
    ...(entry.when === undefined ? {} : { when: entry.when }),
    ...(entry.default === undefined ? {} : { default: entry.default }),
  };
}

function withPreservedDefault(
  entry: PersistedEntry,
  existing: unknown,
): PersistedEntry {
  const hasDefault = typeof existing === "object" && existing !== null &&
    (existing as Record<string, unknown>).default === true;
  if ("preset" in entry) {
    return {
      description: entry.description,
      preset: entry.preset.slice(),
      ...(hasDefault ? { default: true } : {}),
    };
  }
  if ("action" in entry) {
    return {
      description: entry.description,
      hook: entry.hook,
      action: cloneAction(entry.action),
      ...(entry.filter === undefined ? {} : { filter: cloneFilter(entry.filter) }),
      ...(entry.when === undefined ? {} : { when: entry.when }),
      ...(hasDefault ? { default: true } : {}),
    };
  }
  return {
    description: entry.description,
    hook: entry.hook,
    shell: entry.shell,
    ...(entry.filter === undefined ? {} : { filter: cloneFilter(entry.filter) }),
    ...(entry.when === undefined ? {} : { when: entry.when }),
    ...(hasDefault ? { default: true } : {}),
  };
}

function sectionFor(
  file: SectionedFile,
  source: string,
  create: boolean,
): Record<string, unknown> | undefined {
  const existing = file[source];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  if (!create) return undefined;
  const section: Record<string, unknown> = {};
  Object.defineProperty(file, source, {
    value: section,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return section;
}

function assignEntry(
  section: Record<string, unknown>,
  name: string,
  value: Record<string, unknown>,
): void {
  Object.defineProperty(section, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function visibleEntry(
  snapshot: CatalogSnapshot,
  identity: AssertionIdentity,
): CatalogEntry | undefined {
  const key = entryKey(identity.source, identity.name);
  return snapshot.entries.find((entry) => entryKey(entry.source, entry.name) === key);
}

function owningFile(
  snapshot: CatalogSnapshot,
  identity: AssertionIdentity,
): AuthorizedFile | undefined {
  const storage = snapshot.provenance.get(entryKey(identity.source, identity.name));
  return storage === undefined ? undefined : snapshot.files.get(storage);
}

/**
 * Immutable, session-scoped snapshot of all validated authorized assertions.
 * Mutations re-read storage and return a fresh snapshot; this instance is
 * never modified.
 */
export class AssertionCatalog {
  readonly entries: readonly CatalogEntry[];
  readonly repositories: readonly string[];

  private readonly locations: CatalogStorageLocations;

  private constructor(
    locations: CatalogStorageLocations,
    snapshot: CatalogSnapshot,
  ) {
    this.locations = cloneLocations(locations);
    this.entries = snapshot.entries;
    this.repositories = snapshot.repositories;
  }

  /** Create a catalog from exactly the storage locations authorized by Pi. */
  static open(locations: CatalogStorageLocations): CatalogResult {
    const loaded = readSnapshot(locations);
    if (!loaded.ok) return loaded;
    return {
      ok: true,
      catalog: new AssertionCatalog(locations, loaded.snapshot),
    };
  }

  /** Re-read every authorized source without changing this snapshot. */
  refresh(): CatalogResult {
    return AssertionCatalog.open(this.locations);
  }

  /**
   * Apply one domain mutation after re-reading every authorized source.
   * Expected and filesystem failures resolve to ordered diagnostics.
   */
  mutate(intent: CatalogMutation): CatalogResult {
    const loaded = readSnapshot(this.locations);
    if (!loaded.ok) return loaded;
    const snapshot = loaded.snapshot;

    let target: CatalogFailure | {
      readonly ok: true;
      readonly file?: AuthorizedFile;
    };
    try {
      target = this.applyMutation(snapshot, intent);
    } catch (error) {
      return failure(errorReason(error));
    }
    if (!target.ok) return target;
    if (target.file) {
      try {
        writeSectionedFile(target.file.path, target.file.content);
      } catch (error) {
        return failure(errorReason(error), target.file.storage);
      }
    }

    return AssertionCatalog.open(this.locations);
  }

  private applyMutation(
    snapshot: CatalogSnapshot,
    intent: CatalogMutation,
  ): CatalogFailure | { readonly ok: true; readonly file?: AuthorizedFile } {
    switch (intent.type) {
      case "install":
        return this.install(snapshot, intent.entries);
      case "update":
        return this.update(snapshot, intent.identity, intent.entry);
      case "remove":
        return this.remove(snapshot, intent.identity);
      case "edit-local-preset":
        return this.editLocalPreset(
          snapshot,
          intent.identity,
          intent.description,
          intent.preset,
        );
      case "set-default":
        return this.setDefault(snapshot, intent.identity, intent.value);
      case "add-repository":
        return this.addRepository(snapshot, intent.source);
    }
  }

  private install(
    snapshot: CatalogSnapshot,
    installations: readonly CatalogInstallation[],
  ): CatalogFailure | { readonly ok: true; readonly file?: AuthorizedFile } {
    const project = snapshot.files.get("project");
    if (!project) {
      return failure("project storage is not authorized for installation");
    }

    const seen = new Set<string>();
    for (const { identity, entry } of installations) {
      if (identity.source !== "local" && !REPOSITORY_SOURCE.test(identity.source)) {
        return failure(
          `invalid assertion source ${JSON.stringify(identity.source)}; expected local or owner/repo`,
        );
      }
      const key = entryKey(identity.source, identity.name);
      if (seen.has(key)) {
        return failure(`duplicate installation identity ${JSON.stringify(identityLabel(identity))}`);
      }
      seen.add(key);
      if (!validateRuleEntry(entry)) {
        return failure(`entry ${JSON.stringify(identityLabel(identity))} is invalid`);
      }
    }
    if (installations.length === 0) return { ok: true };

    for (const { identity, entry } of installations) {
      if (identity.source !== "local") {
        project.content.repos ??= [];
        if (!project.content.repos.includes(identity.source)) {
          project.content.repos.push(identity.source);
        }
      }
      const section = sectionFor(project.content, identity.source, true)!;
      assignEntry(section, identity.name, persistedEntry(entry));
    }
    return { ok: true, file: project };
  }

  private update(
    snapshot: CatalogSnapshot,
    identity: AssertionIdentity,
    entry: PersistedEntry,
  ): CatalogFailure | { readonly ok: true; readonly file: AuthorizedFile } {
    if (!validateRuleEntry(entry)) {
      return failure(`entry ${JSON.stringify(identityLabel(identity))} is invalid`);
    }
    const file = owningFile(snapshot, identity);
    const current = visibleEntry(snapshot, identity);
    if (!file || !current) {
      return failure(`entry ${JSON.stringify(identityLabel(identity))} was not found`);
    }
    const section = sectionFor(file.content, identity.source, false)!;
    const existing = section[identity.name];
    assignEntry(
      section,
      identity.name,
      persistedEntry(withPreservedDefault(entry, existing)),
    );
    return { ok: true, file };
  }

  private remove(
    snapshot: CatalogSnapshot,
    identity: AssertionIdentity,
  ): CatalogFailure | { readonly ok: true; readonly file: AuthorizedFile } {
    const file = owningFile(snapshot, identity);
    if (!file || !visibleEntry(snapshot, identity)) {
      return failure(`entry ${JSON.stringify(identityLabel(identity))} was not found`);
    }
    const section = sectionFor(file.content, identity.source, false)!;
    delete section[identity.name];
    if (Object.keys(section).length === 0) delete file.content[identity.source];
    return { ok: true, file };
  }

  private editLocalPreset(
    snapshot: CatalogSnapshot,
    identity: AssertionIdentity,
    description: string,
    preset: readonly string[],
  ): CatalogFailure | { readonly ok: true; readonly file: AuthorizedFile } {
    if (identity.source !== "local") {
      return failure("only local presets are editable");
    }
    const current = visibleEntry(snapshot, identity);
    const file = owningFile(snapshot, identity);
    if (!current || !file) {
      return failure(`entry ${JSON.stringify(identityLabel(identity))} was not found`);
    }
    if (!isCatalogPreset(current)) {
      return failure(`entry ${JSON.stringify(identityLabel(identity))} is not a preset`);
    }
    const replacement: PersistedEntry = {
      description,
      preset: Array.from(preset),
    };
    if (!validateRuleEntry(replacement)) {
      return failure(`preset ${JSON.stringify(identityLabel(identity))} is invalid`);
    }
    const section = sectionFor(file.content, identity.source, false)!;
    assignEntry(
      section,
      identity.name,
      persistedEntry(withPreservedDefault(replacement, section[identity.name])),
    );
    return { ok: true, file };
  }

  private setDefault(
    snapshot: CatalogSnapshot,
    identity: AssertionIdentity,
    value: boolean,
  ): CatalogFailure | { readonly ok: true; readonly file: AuthorizedFile } {
    const file = owningFile(snapshot, identity);
    if (!file || !visibleEntry(snapshot, identity)) {
      return failure(`entry ${JSON.stringify(identityLabel(identity))} was not found`);
    }
    const section = sectionFor(file.content, identity.source, false)!;
    const entry = section[identity.name] as Record<string, unknown>;
    if (value) entry.default = true;
    else delete entry.default;
    return { ok: true, file };
  }

  private addRepository(
    snapshot: CatalogSnapshot,
    source: string,
  ): CatalogFailure | { readonly ok: true; readonly file?: AuthorizedFile } {
    if (!REPOSITORY_SOURCE.test(source)) {
      return failure(`invalid repository ${JSON.stringify(source)}; expected owner/repo`);
    }
    const project = snapshot.files.get("project");
    if (!project) {
      return failure("project storage is not authorized for repository changes");
    }
    project.content.repos ??= [];
    if (project.content.repos.includes(source)) return { ok: true };
    project.content.repos.push(source);
    return { ok: true, file: project };
  }
}
