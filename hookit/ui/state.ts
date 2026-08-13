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
  createEnabledHookSet,
  type EnabledHookSet,
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

/** Session enablement state between Hook Catalog and Hook Evaluation. */
export class HooksState {
  entries: CatalogEntry[] = [];
  enabledEntries: Set<string> = new Set();
  broken = false;
  loadErrors: readonly CatalogDiagnostic[] = [];
  projectTrusted = true;

  private catalog?: HookCatalog;
  private locations?: CatalogStorageLocations;
  private enablementMode: "saved" | "defaults" | undefined;

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
      this.enabledEntries = new Set();
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
      this.enabledEntries = new Set();
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
   * Replace the immutable Catalog and reconcile direct enablement. Saved
   * identities survive when still present; default-derived enablement is
   * recomputed from the fresh entries.
   */
  replaceCatalog(catalog: HookCatalog): void {
    this.catalog = catalog;
    this.entries = Array.from(catalog.entries);
    const valid = new Set(this.entries.map((entry) => this.keyOf(entry)));
    if (this.enablementMode === "defaults") {
      this.enabledEntries = new Set(
        this.entries.filter((entry) => entry.default).map((entry) => this.keyOf(entry)),
      );
      return;
    }
    this.enabledEntries = new Set(
      Array.from(this.enabledEntries).filter((key) => valid.has(key)),
    );
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
    const color = this.enabledEntries.size > 0 ? "accent" : "dim";
    ctx.ui.setStatus(
      "hookit",
      theme.fg(
        color,
        `hooks: ${this.enabledEntries.size}/${this.entries.length}`,
      ),
    );
  }

  /** Canonical persisted key used only by session enablement storage. */
  keyOf(entry: CatalogEntry): string {
    return entryKey(entry.source, entry.name);
  }

  /** Whether this Catalog Entry is enabled directly. */
  isEnabledDirectly(entry: CatalogEntry): boolean {
    return this.enabledEntries.has(this.keyOf(entry));
  }

  /** Canonical key. UI callers pass Catalog entries; strings must be canonical. */
  private resolveKey(value: CatalogEntry | string): string {
    if (typeof value !== "string") return this.keyOf(value);
    return value;
  }

  /** Persist directly enabled Catalog Entries to the current session branch. */
  persist(): void {
    this.enablementMode = "saved";
    this.pi.appendEntry("hookit-config", {
      enabledEntries: Array.from(this.enabledEntries),
    });
  }

  /** Restore saved direct enablement, or initialize it from current defaults. */
  restore(ctx: ExtensionContext): void {
    const branchEntries = ctx.sessionManager.getBranch();
    let saved: string[] | undefined;
    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === "hookit-config") {
        const data = entry.data as { enabledEntries?: unknown } | undefined;
        if (
          Array.isArray(data?.enabledEntries) &&
          data.enabledEntries.every(
            (value): value is string => typeof value === "string",
          )
        ) {
          saved = data.enabledEntries;
        }
      }
    }

    if (saved !== undefined) {
      const valid = new Set(this.entries.map((entry) => this.keyOf(entry)));
      // Restore only canonical NUL-separated keys that still exist in the
      // current Catalog. Bare names are silently dropped; there is no
      // unambiguous-name resolution.
      this.enabledEntries = new Set(saved.filter((value) =>
        value.includes("\x00") && valid.has(value),
      ));
      this.enablementMode = "saved";
    } else {
      this.enabledEntries = new Set(
        this.entries.filter((entry) => entry.default).map((entry) => this.keyOf(entry)),
      );
      this.enablementMode = "defaults";
    }
  }

  enable(entry: CatalogEntry | string): void {
    this.enabledEntries.add(this.resolveKey(entry));
  }

  disable(entry: CatalogEntry | string): void {
    this.enabledEntries.delete(this.resolveKey(entry));
  }

  disableAll(): void {
    this.enabledEntries.clear();
  }

  toggle(entry: CatalogEntry | string): void {
    const key = this.resolveKey(entry);
    if (this.enabledEntries.has(key)) this.enabledEntries.delete(key);
    else this.enabledEntries.add(key);
  }

  private enabledHooks(): CatalogHook[] {
    const hooks: CatalogHook[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (!this.isEnabledDirectly(entry)) continue;
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

  /** Capture the immutable effective Hook membership for one Evaluation. */
  enabledHookSet(): EnabledHookSet {
    return createEnabledHookSet(this.enabledHooks());
  }
}
