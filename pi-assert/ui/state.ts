import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AssertionCatalog,
  isCatalogPreset,
  type CatalogDiagnostic,
  type CatalogEntry,
  type CatalogExecutableEntry,
  type CatalogMutation,
  type CatalogResult,
  type CatalogStorageLocations,
} from "../assertion-catalog/index.js";
import { AssertIndex, entryKey, parseEntryRef } from "../domain/entry.js";
import {
  createActiveAssertionSet,
  type ActiveAssertionSet,
} from "../hook-evaluation/index.js";

/** Resolve one preset level to available executable entries, in ref order. */
export function formatCatalogFailure(
  result: Extract<CatalogResult, { ok: false }>,
): string {
  return result.diagnostics
    .map((diagnostic) =>
      `${diagnostic.storage ? `${diagnostic.storage} storage: ` : ""}${diagnostic.reason}`
    )
    .join("; ");
}

export function resolvePresetMembers(
  entries: readonly CatalogEntry[],
  preset: CatalogEntry,
): CatalogEntry[] {
  if (!isCatalogPreset(preset)) return [];
  const index = new AssertIndex(entries);
  const members: CatalogEntry[] = [];
  for (const ref of preset.preset) {
    const parsed = parseEntryRef(ref);
    const member = parsed ? index.get(parsed.source, parsed.name) : undefined;
    if (member && !isCatalogPreset(member)) members.push(member);
  }
  return members;
}

/** Session activation state between Assertion Catalog and Hook Evaluation. */
export class AssertsState {
  entries: CatalogEntry[] = [];
  active: Set<string> = new Set();
  broken = false;
  loadErrors: readonly CatalogDiagnostic[] = [];
  projectTrusted = true;

  private catalog?: AssertionCatalog;
  private locations?: CatalogStorageLocations;
  private activationMode: "saved" | "defaults" | undefined;

  constructor(private pi: ExtensionAPI) {}

  /** Create a new session catalog from exactly the authorized locations. */
  load(
    locations: CatalogStorageLocations,
    projectTrusted = locations.project !== undefined,
  ): void {
    this.locations = locations;
    this.projectTrusted = projectTrusted;
    const result = AssertionCatalog.open(locations);
    if (!result.ok) {
      this.catalog = undefined;
      this.entries = [];
      this.active = new Set();
      this.broken = true;
      this.loadErrors = result.diagnostics;
      return;
    }
    this.broken = false;
    this.loadErrors = [];
    this.replaceCatalog(result.catalog);
  }

  /** Re-read authorized storage; invalid storage makes the catalog unavailable. */
  refresh(): CatalogResult {
    const result = this.catalog?.refresh() ??
      (this.locations
        ? AssertionCatalog.open(this.locations)
        : {
            ok: false as const,
            diagnostics: [{ reason: "catalog storage is not configured" }],
          });
    if (!result.ok) {
      this.catalog = undefined;
      this.entries = [];
      this.active = new Set();
      this.broken = true;
      this.loadErrors = result.diagnostics;
      return result;
    }
    this.broken = false;
    this.loadErrors = [];
    this.replaceCatalog(result.catalog);
    return result;
  }

  /**
   * Replace the immutable catalog snapshot and reconcile activation. Saved
   * identities survive when still present; default-derived activation is
   * recomputed from the fresh entries.
   */
  replaceCatalog(catalog: AssertionCatalog): void {
    this.catalog = catalog;
    this.entries = Array.from(catalog.entries);
    const valid = new Set(this.entries.map((entry) => this.keyOf(entry)));
    if (this.activationMode === "defaults") {
      this.active = new Set(
        this.entries.filter((entry) => entry.default).map((entry) => this.keyOf(entry)),
      );
      return;
    }
    this.active = new Set(Array.from(this.active).filter((key) => valid.has(key)));
  }

  /** Apply catalog intent and accept only a successful fresh snapshot. */
  mutate(intent: CatalogMutation): CatalogResult {
    if (!this.catalog) {
      return {
        ok: false,
        diagnostics: this.loadErrors.length > 0
          ? this.loadErrors
          : [{ reason: "assertion catalog is unavailable" }],
      };
    }
    const result = this.catalog.mutate(intent);
    if (result.ok) this.replaceCatalog(result.catalog);
    return result;
  }

  get repositories(): readonly string[] {
    return this.catalog?.repositories ?? [];
  }

  /** Update the pi-assert status bar entry. */
  updateStatus(ctx: ExtensionContext): void {
    const theme = ctx.ui.theme;
    if (this.broken) {
      const count = this.loadErrors.length;
      ctx.ui.setStatus(
        "pi-assert",
        theme.fg(
          "error",
          `pi-assert: config error (${count} file${count === 1 ? "" : "s"})`,
        ),
      );
      return;
    }
    if (this.entries.length === 0) {
      ctx.ui.setStatus("pi-assert", undefined);
      return;
    }
    const color = this.active.size > 0 ? "accent" : "dim";
    ctx.ui.setStatus(
      "pi-assert",
      theme.fg(color, `asserts: ${this.active.size}/${this.entries.length}`),
    );
  }

  /** Canonical persisted key used only by session activation storage. */
  keyOf(entry: CatalogEntry): string {
    return entryKey(entry.source, entry.name);
  }

  /** Whether this entry is enabled. Legacy bare names match only uniquely. */
  isActive(entry: CatalogEntry): boolean {
    const key = this.keyOf(entry);
    if (this.active.has(key)) return true;
    return this.active.has(entry.name) &&
      this.entries.filter((other) => other.name === entry.name).length === 1;
  }

  private resolveKey(value: CatalogEntry | string): string {
    if (typeof value !== "string") return this.keyOf(value);
    if (value.includes("\x00")) return value;
    const match = new AssertIndex(this.entries).resolveLegacyName(value);
    return match ? this.keyOf(match) : value;
  }

  /** Persist activation to the current session branch. */
  persist(): void {
    this.activationMode = "saved";
    this.pi.appendEntry("pi-assert-config", {
      activeAsserts: Array.from(this.active),
    });
  }

  /** Restore saved activation, or initialize it from current defaults. */
  restore(ctx: ExtensionContext): void {
    const branchEntries = ctx.sessionManager.getBranch();
    let saved: string[] | undefined;
    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === "pi-assert-config") {
        const data = entry.data as { activeAsserts?: string[] } | undefined;
        if (data?.activeAsserts) saved = data.activeAsserts;
      }
    }

    if (saved) {
      const index = new AssertIndex(this.entries);
      const valid = new Set(index.byKey.keys());
      const migrated = saved.flatMap((value) => {
        if (value.includes("\x00")) return valid.has(value) ? [value] : [];
        const match = index.resolveLegacyName(value);
        return match ? [this.keyOf(match)] : [];
      });
      this.active = new Set(migrated);
      this.activationMode = "saved";
    } else {
      this.active = new Set(
        this.entries.filter((entry) => entry.default).map((entry) => this.keyOf(entry)),
      );
      this.activationMode = "defaults";
    }
  }

  enable(entry: CatalogEntry | string): void {
    this.active.add(this.resolveKey(entry));
  }

  disable(entry: CatalogEntry | string): void {
    this.active.delete(this.resolveKey(entry));
  }

  disableAll(): void {
    this.active.clear();
  }

  toggle(entry: CatalogEntry | string): void {
    const key = this.resolveKey(entry);
    if (this.active.has(key)) this.active.delete(key);
    else this.active.add(key);
  }

  private activeAssertions(): CatalogExecutableEntry[] {
    const assertions: CatalogExecutableEntry[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (!this.isActive(entry)) continue;
      if (isCatalogPreset(entry)) {
        for (const member of resolvePresetMembers(this.entries, entry)) {
          if (isCatalogPreset(member)) continue;
          const key = this.keyOf(member);
          if (seen.has(key)) continue;
          seen.add(key);
          assertions.push(member);
        }
      } else {
        const key = this.keyOf(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        assertions.push(entry);
      }
    }
    return assertions;
  }

  /** Snapshot current activation and one-level preset expansion. */
  activeAssertionSet(): ActiveAssertionSet {
    return createActiveAssertionSet(this.activeAssertions());
  }
}
