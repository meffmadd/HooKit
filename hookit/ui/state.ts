import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  HookCatalog,
  isCatalogPreset,
  type CatalogDiagnostic,
  type CatalogEntry,
  type CatalogHook,
  type CatalogMutation,
  type CatalogResult,
  type CatalogStorageLocations,
} from "../hook-catalog/index.js";
import { HookIndex, entryKey, parseEntryRef } from "../domain/entry.js";
import {
  createActiveHookSet,
  type ActiveHookSet,
} from "../hook-evaluation/index.js";

/** Resolve one Preset level to available Hooks, in ref order. */
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
  const index = new HookIndex(entries);
  const members: CatalogEntry[] = [];
  for (const ref of preset.preset) {
    const parsed = parseEntryRef(ref);
    const member = parsed ? index.get(parsed.source, parsed.name) : undefined;
    if (member && !isCatalogPreset(member)) members.push(member);
  }
  return members;
}

/** Session activation state between Hook Catalog and Hook Evaluation. */
export class HooksState {
  entries: CatalogEntry[] = [];
  active: Set<string> = new Set();
  broken = false;
  loadErrors: readonly CatalogDiagnostic[] = [];
  projectTrusted = true;

  private catalog?: HookCatalog;
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
    const result = HookCatalog.open(locations);
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
        ? HookCatalog.open(this.locations)
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
  replaceCatalog(catalog: HookCatalog): void {
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
          : [{ reason: "hook catalog is unavailable" }],
      };
    }
    const result = this.catalog.mutate(intent);
    if (result.ok) this.replaceCatalog(result.catalog);
    return result;
  }

  get repositories(): readonly string[] {
    return this.catalog?.repositories ?? [];
  }

  /** Update the HooKit status bar entry. */
  updateStatus(ctx: ExtensionContext): void {
    const theme = ctx.ui.theme;
    if (this.broken) {
      const count = this.loadErrors.length;
      ctx.ui.setStatus(
        "hookit",
        theme.fg(
          "error",
          `hookit: config error (${count} file${count === 1 ? "" : "s"})`,
        ),
      );
      return;
    }
    if (this.entries.length === 0) {
      ctx.ui.setStatus("hookit", undefined);
      return;
    }
    const color = this.active.size > 0 ? "accent" : "dim";
    ctx.ui.setStatus(
      "hookit",
      theme.fg(color, `hooks: ${this.active.size}/${this.entries.length}`),
    );
  }

  /** Canonical persisted key used only by session activation storage. */
  keyOf(entry: CatalogEntry): string {
    return entryKey(entry.source, entry.name);
  }

  /** Whether this entry is enabled. Only canonical keys match. */
  isActive(entry: CatalogEntry): boolean {
    return this.active.has(this.keyOf(entry));
  }

  /** Canonical key. UI callers pass Catalog entries; strings must be canonical. */
  private resolveKey(value: CatalogEntry | string): string {
    if (typeof value !== "string") return this.keyOf(value);
    return value;
  }

  /** Persist activation to the current session branch. */
  persist(): void {
    this.activationMode = "saved";
    this.pi.appendEntry("hookit-config", {
      activeHooks: Array.from(this.active),
    });
  }

  /** Restore saved activation, or initialize it from current defaults. */
  restore(ctx: ExtensionContext): void {
    const branchEntries = ctx.sessionManager.getBranch();
    let saved: string[] | undefined;
    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === "hookit-config") {
        const data = entry.data as { activeHooks?: string[] } | undefined;
        if (data?.activeHooks) saved = data.activeHooks;
      }
    }

    if (saved) {
      const valid = new Set(this.entries.map((entry) => this.keyOf(entry)));
      // Restore only canonical NUL-separated keys that still exist in the
      // current catalog. Bare names are silently dropped; there is no
      // unambiguous-name resolution.
      this.active = new Set(saved.filter((value) =>
        value.includes("\x00") && valid.has(value),
      ));
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

  private activeHooks(): CatalogHook[] {
    const hooks: CatalogHook[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (!this.isActive(entry)) continue;
      if (isCatalogPreset(entry)) {
        for (const member of resolvePresetMembers(this.entries, entry)) {
          if (isCatalogPreset(member)) continue;
          const key = this.keyOf(member);
          if (seen.has(key)) continue;
          seen.add(key);
          hooks.push(member);
        }
      } else {
        const key = this.keyOf(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        hooks.push(entry);
      }
    }
    return hooks;
  }

  /** Snapshot current activation and one-level preset expansion. */
  activeHookSet(): ActiveHookSet {
    return createActiveHookSet(this.activeHooks());
  }
}
