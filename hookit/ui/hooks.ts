import { type ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  isCatalogPreset,
  type HookIdentity,
  type CatalogEntry,
  type CatalogPreset,
} from "../hook-catalog/index.js";
import { entryKey, entryRef } from "../domain/entry.js";
import { catalogStorageLocations } from "../config.js";
import { fetchRepoEntries } from "../installer.js";
import {
  HINT_D_DISABLE_ALL,
  HINT_ESC_CANCEL,
  HINT_ESC_CLOSE,
  HINT_ESC_EXIT_SEARCH,
  HINT_ENTER_CONFIRM,
  HINT_I_INSTALL_HOOKS,
  HINT_N_NEW_PRESET,
  HINT_SEARCH,
  OverlayBox,
  SectionNavigator,
  sectionedPanelHeight,
  sectionedPanelOverlay,
  renderContextualActions,
  renderDetailList,
  renderHintLine,
  textInputDialog,
  type HintItem,
} from "./components.js";
import { highlightSegments } from "./fuzzy.js";
import {
  SectionedPanel,
  groupHooksBySource,
  type Group,
} from "./sectioned-panel.js";
import {
  formatCatalogFailure,
  resolvePresetMembers,
  type HooksState,
} from "./state.js";
import { runInstallWizard } from "./install.js";
import { runPresetEditor } from "./preset-editor.js";

// Order: always-present **Presets** section first (header shown even when
// empty, so `p`/`n` always have a home), then `local`, then repos alpha.
// Presets are hoisted out of their real source into the synthetic Presets
// group for display; mutations use the selected entry's canonical source/name
// identity, never the synthetic group label.
const PRESETS_SOURCE = "Presets";
function groupBySource(entries: CatalogEntry[]): Group[] {
  const presets = entries.filter(isCatalogPreset);
  const hooks = entries.filter((a) => !isCatalogPreset(a));
  return [{
    source: PRESETS_SOURCE,
    hooks: presets,
  }, ...groupHooksBySource(hooks)];
}

// ---------------------------------------------------------------------------
// Preset coverage — the reverse of session activation's preset expansion.
//
// For each Hook that is a member of an **active** Preset, this maps
// `source\x00name` → the names of the active presets that reference it.
// Mirrors session activation exactly: only active presets contribute, dangling
// and nested-preset refs are skipped, refs split on the last `/`.  Used by
// `renderStatus` to show `active · via {preset}` on a member that isn't
// individually active but runs because an active preset expanded to it.
// ---------------------------------------------------------------------------
function buildPresetCoverage(
  hooks: CatalogEntry[],
  isActive: (hook: CatalogEntry) => boolean,
): Map<string, string[]> {
  const coverage = new Map<string, string[]>();
  for (const a of hooks) {
    if (!isActive(a) || !isCatalogPreset(a)) continue;
    for (const member of resolvePresetMembers(hooks, a)) {
      const key = entryKey(member.source, member.name);
      const list = coverage.get(key) ?? [];
      list.push(a.name);
      coverage.set(key, list);
    }
  }
  return coverage;
}

// ---------------------------------------------------------------------------
// HooksPanel — model + render + input for the /hooks toggle UI.
// ---------------------------------------------------------------------------
type PanelAction =
  | "cancel"
  | "install"
  | "reload"
  | "create-preset"
  | { type: "edit-preset"; preset: CatalogPreset };

interface PanelFocusBookmark {
  readonly identity?: HookIdentity;
  readonly sectionSource: string;
  readonly sectionIndex: number;
  readonly rowIndex: number;
}

interface PanelExit {
  readonly action: Exclude<PanelAction, "cancel">;
  readonly focus: PanelFocusBookmark;
}

export class HooksPanel extends SectionedPanel {
  private confirm: { name: string; source: string } | null = null;

  /**
   * Composite keys (`${source}\0${name}`) of installed hooks that no longer
   * exist in their source repo (removed upstream).  Keyed by source+name so a
   * local hook (or a different repo's hook) sharing a name with an
   * orphaned repo hook is never mis-badged.  Populated asynchronously by
   * `startOrphanCheck`; empty until the fetch settles.  Local hooks are
   * never orphaned.
   */
  private orphaned = new Set<string>();

  /**
   * Reverse map: `source\x00name` → active preset names that reference it.
   * Lazy-computed and invalidated on toggle/disable-all (`_coverage = null`).
   * See {@link buildPresetCoverage}.
   */
  private _coverage: Map<string, string[]> | null = null;
  private get coverage(): Map<string, string[]> {
    if (this._coverage === null) {
      this._coverage = buildPresetCoverage(this.state.entries, (a) => this.activeFor(a));
    }
    return this._coverage;
  }

  /**
   * Reverse lookup for dangling-ref detection: `"source/name"` → the installed
   * Hook at that ref (Presets excluded — a ref to a Preset is a
   * nested-preset ref, always dangling for v1).  Lazy-computed once: the
   * panel is recreated after every reload (install/remove/create), and within
   * a panel instance `state.entries` (which hooks exist) never changes —
   * only `active` and `default` flags do — so the map is stable for the
   * panel's lifetime.  Synchronous, unlike the async orphaned fetch.
   */
  private _byRef: Map<string, CatalogEntry> | null = null;
  private get byRef(): Map<string, CatalogEntry> {
    if (this._byRef === null) {
      this._byRef = new Map(
        this.state.entries
          .filter((a) => !isCatalogPreset(a))
          .map((a) => [entryRef(a.source, a.name), a]),
      );
    }
    return this._byRef;
  }

  /**
   * The refs of Preset `a` that do not resolve to an installed Hook.
   * Empty for non-presets and for presets whose every ref resolves.  A preset
   * is `§` (dangling) iff this is non-empty.  Refs split on the last `/`
   * (matches session expansion), but the lookup key is the full `"source/name"`
   * ref string, so a malformed ref (no `/`) simply won't be in the map.
   */
  private danglingRefs(a: CatalogEntry): string[] {
    if (!isCatalogPreset(a)) return [];
    const out: string[] = [];
    for (const ref of a.preset) {
      if (!this.byRef.has(ref)) out.push(ref);
    }
    return out;
  }

  /** `true` iff `a` is a preset with at least one dangling ref (`§` badge). */
  private isDangling(a: CatalogEntry): boolean {
    return this.danglingRefs(a).length > 0;
  }

  /** `true` iff `a` was removed from its source repo (`⚠` badge, async). */
  private isOrphaned(a: CatalogEntry): boolean {
    return this.orphaned.has(entryKey(a.source, a.name));
  }

  /** Re-render callback, set by the caller so async fetch resolution can flip badges in. */
  private requestRender: () => void = () => {};

  /** Search guard: nothing to search when the config is broken or empty. */
  protected canSearch(): boolean {
    return !this.state.broken && this.state.entries.length > 0;
  }

  constructor(
    private state: HooksState,
    initialFocus?: PanelFocusBookmark,
  ) {
    super();
    this.groups = groupBySource(state.entries);
    this.nav = new SectionNavigator<CatalogEntry>(
      this.groups.map((g) => ({ items: g.hooks })),
    );

    const setFocus = (section: number, row: number): void => {
      this.nav.focus = section;
      this.nav.selection[section] = row;
    };

    // Catalog mutations install fresh immutable entry objects. Restore by
    // canonical identity rather than object reference when the entry survives.
    const identity = initialFocus?.identity;
    if (identity) {
      for (let section = 0; section < this.groups.length; section++) {
        const index = this.groups[section]!.hooks.findIndex(
          (entry) =>
            entry.source === identity.source && entry.name === identity.name,
        );
        if (index >= 0) {
          setFocus(section, index);
          return;
        }
      }
    }

    // A removed entry has no identity to restore. Stay in its display section
    // at the same row (next item, or previous when the old row was last).
    if (initialFocus && this.groups.length > 0) {
      const matchingSection = this.groups.findIndex(
        (group) => group.source === initialFocus.sectionSource,
      );
      if (matchingSection >= 0 && this.groups[matchingSection]!.hooks.length > 0) {
        const lastRow = this.groups[matchingSection]!.hooks.length - 1;
        setFocus(
          matchingSection,
          Math.min(initialFocus.rowIndex, lastRow),
        );
        return;
      }

      // If the display section emptied or disappeared, move to the first row
      // of the next non-empty section, or the last row of the previous one.
      const nextStart = matchingSection >= 0
        ? matchingSection + 1
        : Math.min(initialFocus.sectionIndex, this.groups.length);
      for (let section = nextStart; section < this.groups.length; section++) {
        if (this.groups[section]!.hooks.length > 0) {
          setFocus(section, 0);
          return;
        }
      }
      const previousStart = matchingSection >= 0
        ? matchingSection - 1
        : Math.min(initialFocus.sectionIndex - 1, this.groups.length - 1);
      for (let section = previousStart; section >= 0; section--) {
        const lastRow = this.groups[section]!.hooks.length - 1;
        if (lastRow >= 0) {
          setFocus(section, lastRow);
          return;
        }
      }

      // No entries remain; retain the nearest section header.
      setFocus(
        matchingSection >= 0
          ? matchingSection
          : Math.min(initialFocus.sectionIndex, this.groups.length - 1),
        0,
      );
      return;
    }

    // Open on the first non-empty section so the user lands on a real row.
    // The Presets section is always first but may be empty; falling back to
    // it (index 0) when every section is empty keeps `p`/`n` reachable.
    const firstNonEmpty = this.groups.findIndex((g) => g.hooks.length > 0);
    if (firstNonEmpty >= 0) this.nav.focus = firstNonEmpty;
  }

  /** Capture a stable focus bookmark before the command loop rebuilds the panel. */
  focusBookmark(): PanelFocusBookmark {
    const sectionIndex = this.nav.focusedSection;
    const group = this.groups[sectionIndex];
    const rowIndex = this.nav.focusedIndex;
    const selected = group?.hooks[rowIndex];
    return {
      ...(selected
        ? { identity: { source: selected.source, name: selected.name } }
        : {}),
      sectionSource: group?.source ?? PRESETS_SOURCE,
      sectionIndex,
      rowIndex,
    };
  }

  /** Wire the TUI re-render callback (called inside `ctx.ui.custom`). */
  setRequestRender(fn: () => void): void {
    this.requestRender = fn;
  }

  /**
   * Kick off async repo fetches to detect orphaned hooks — installed names
   * missing from their source repo.  When all fetches settle, populates
   * `orphaned` and triggers a re-render so `⚠` badges appear.
   *
   * Skipped entirely when the config is broken (hard-fail posture) or when
   * there are no repo-sourced hooks.  Network failures degrade silently:
   * a repo that can't be fetched contributes no orphaned entries (no `⚠`),
   * and the session cache means the next open retries.
   */
  startOrphanCheck(): void {
    if (this.state.broken) return;

    const repos = new Set<string>();
    for (const a of this.state.entries) {
      if (a.source !== "local") repos.add(a.source);
    }
    if (repos.size === 0) return;

    // Fetch each repo's entries (session-cached per repo@ref).
    const fetches = [...repos].map(async (repo) => {
      try {
        return [repo, await fetchRepoEntries(repo)] as const;
      } catch {
        return null; // network failure → no orphaned detection for this repo
      }
    });

    Promise.all(fetches).then((results) => {
      const orphaned = new Set<string>();
      for (const result of results) {
        if (!result) continue;
        const [repo, entries] = result;
        for (const a of this.state.entries) {
          if (a.source === repo && !entries.has(a.name)) {
            orphaned.add(entryKey(a.source, a.name));
          }
        }
      }
      this.orphaned = orphaned;
      this.requestRender();
    });
  }

  // ── Hooks (override SectionedPanel defaults) ──────────────────────
  // `render`/`bodyLines`/`renderUnboundedBody`/`renderSectionHeader`/
  // `renderInactiveSectionHeader`/`moveFocus` are all inherited from
  // `SectionedPanel` — the two panels share one composition path.  These
  // hooks supply the panel-specific branches that `bodyLines` delegates to.
  protected emptyBodyLines(_width: number): string[] {
    // No hooks at all (fresh install or broken config).  The Presets
    // section is still rendered (header shown even when empty — the home
    // for `p`/`n`) so the user has somewhere to land; the message guides them.
    return [
      ...this.renderHeaderLines(),
      this.renderSectionHeader(0),
      this.theme.fg(
        "dim",
        this.state.broken
          ? "Configuration is invalid; fix hookit.json to continue."
          : "No hooks defined! Press " +
            this.theme.fg("accent", "i") + " to install or " +
            this.theme.fg("accent", "n") + " for a new preset.",
      ),
    ];
  }

  protected modeBodyLines(_width: number): string[] | null {
    if (!this.confirm) return null;
    return [...this.renderHeaderLines(), "", `  Remove "${this.confirm.name}"?`];
  }

  protected detailPrefixFor(a: CatalogEntry, _width: number): string[] {
    return [
      ...this.readonlyDetailLines(a),
      ...this.orphanedDetailLines(a),
      ...this.danglingDetailLines(a),
    ];
  }

  protected detailSuffixFor(a: CatalogEntry, width: number): string[] {
    const items: HintItem[] = [
      ["Enter", this.activeFor(a) ? "disable" : "enable"],
    ];
    if (!this.searchActive) {
      items.push(["t", a.default ? "unset default" : "set default"]);
      items.push(["r", "remove"]);
      if (isCatalogPreset(a) && a.source === "local") {
        items.push(["e", "edit preset"]);
      }
    }
    return renderContextualActions(this.theme, width, items, this.keybindings);
  }

  protected renderHeaderLines(): string[] {
    return [
      this.theme.fg("accent", this.theme.bold("Hooks")),
      this.theme.fg(
        "muted",
        `${this.state.active.size}/${this.state.entries.length} enabled`,
      ),
      "",
    ];
  }

  // ── Render helpers ─────────────────────────────────────────────────
  private activeFor(entry: CatalogEntry): boolean {
    return this.state.isActive(entry);
  }

  /** The plain row label: `name` plus the optional ` (default)` tag. */
  private plainLabel(a: CatalogEntry): string {
    return a.default ? `${a.name} (default)` : a.name;
  }

  /**
   * Styled status string for a hook row.  Three states:
   *
   *  - individually active → `enabled` (accent)
   *  - covered by an active preset but not individually active →
   *    `active · via {preset}` where `active` is dim and `via {preset}`
   *    is accent
   *  - disabled → `disabled` (dim)
   *
   * A hook active both individually and via a preset shows just `enabled`
   * (the `via` is redundant — it runs either way).  Multiple covering presets
   * collapse to `via {n} presets`.
   */
  private renderStatus(a: CatalogEntry): string {
    if (this.activeFor(a)) {
      return this.theme.fg("accent", "enabled");
    }
    const via = this.coverage.get(entryKey(a.source, a.name));
    if (via && via.length > 0) {
      const label = via.length === 1
        ? `via ${via[0]}`
        : `via ${via.length} presets`;
      return (
        this.theme.fg("dim", "active") +
        this.theme.fg("dim", " · ") +
        this.theme.fg("accent", label)
      );
    }
    return this.theme.fg("dim", "disabled");
  }

  /**
   * Render the name (+ optional " (default)" suffix) with query matches
   * highlighted, then `padding` aligned to the label column.
   *
   * `base` styles unmatched text (and the suffix + padding); `highlight`
   * styles matched chars.  When search is inactive or the name doesn't
   * match, the whole name+suffix+padding is styled via `base` as a single
   * run — byte-identical to the pre-highlight render (so the empty-padding
   * and column-alignment cases are unchanged).  ANSI codes are zero visible
   * width, so highlighting never disturbs the padding math.
   */
  private renderLabel(
    a: CatalogEntry,
    base: (s: string) => string,
    highlight: (s: string) => string,
    padding: string,
  ): string {
    const segs =
      this.searchActive ? highlightSegments(this.query, a.name) : null;
    if (!segs) return base(this.plainLabel(a) + padding);
    const suffix = a.default ? " (default)" : "";
    return (
      segs
        .map((s) => (s.matched ? highlight(s.text) : base(s.text)))
        .join("") + base(suffix + padding)
    );
  }

  /**
   * Adds the `p` jump key for the Presets section (always shown, even when
   * focused, so the jump target is discoverable from any section) on top of
   * the base's shared `Tab`/`Shift+Tab` cycle hints.
   */
  protected sectionHeaderKeys(index: number): string[] {
    // `p` jumps to the Presets section (always index 0); the base adds the
    // shared `Tab`/`Shift+Tab` cycle hints on the sections a cycle lands on.
    const keys = super.sectionHeaderKeys(index);
    if (this.groups[index].source === PRESETS_SOURCE) keys.unshift("p");
    return keys;
  }

  protected renderSection(
    width: number,
    group: Group,
    focused: boolean,
    selectedIndex: number,
    start = 0,
    end = group.hooks.length,
  ): string[] {
    if (!focused) {
      // Dimmed static listing.
      const { badgeFor, badgeWidth, maxLabelWidth } = this.badgeLayout(group);
      const lines: string[] = [];
      const muted = (s: string) => this.theme.fg("muted", s);
      const accent = (s: string) => this.theme.fg("accent", s);
      for (const a of group.hooks) {
        const badge = badgeFor(a);
        const labelW = visibleWidth(this.plainLabel(a)) + badgeWidth(a);
        const padding = " ".repeat(Math.max(0, maxLabelWidth - labelW));
        const status = this.renderStatus(a);
        lines.push(
          `   ${badge}${this.renderLabel(a, muted, accent, padding)}  ${status}`,
        );
      }
      return lines;
    }

    // Active section: delegate to the shared renderDetailList so the row
    // layout, "> " highlight prefix, and inline shell/when (or hooks:)
    // detail block are identical to the install wizard's hook-entry
    // picker.  We pass our own [start, end) window (the panel manages
    // per-section scrolling and renders its own scroll indicator outside
    // the section).
    //
    // Badges render OUTSIDE the accent wrap so their colours hold on the
    // selected row.  Left-to-right: `P ` (preset, accent), `§ ` (dangling,
    // warning), `⚠ ` (orphaned, warning).  `§`+`⚠` co-occur; `P` is always
    // on presets.  The width of every present badge is reserved in
    // `maxLabelWidth` so the status column stays aligned across mixed badge
    // sets (a `P § ⚠` preset and a bare `⚠` hook line up).
    const theme = this.theme;
    const { badgeFor, badgeWidth, maxLabelWidth } = this.badgeLayout(group);

    return renderDetailList(theme, width, {
      items: group.hooks,
      selectedIndex,
      window: [start, end],
      showScrollIndicator: false,
      highlightQuery: this.searchActive ? this.query : undefined,
      renderRow: (a, selected) => {
        const badge = badgeFor(a);
        const labelW = visibleWidth(this.plainLabel(a)) + badgeWidth(a);
        const padding = " ".repeat(Math.max(0, maxLabelWidth - labelW));
        const base = selected
          ? (s: string) => theme.fg("accent", s)
          : (s: string) => s;
        const highlight = selected
          ? (s: string) => theme.fg("accent", theme.underline(s))
          : (s: string) => theme.fg("accent", s);
        const labelText = this.renderLabel(a, base, highlight, padding);
        const valueText = this.renderStatus(a);
        return `${badge}${labelText}  ${valueText}`;
      },
      detailFor: (a) => a,
      detailPrefix: (a) => this.detailPrefixFor(a, width),
      detailSuffix: (a, detailWidth) => this.detailSuffixFor(a, detailWidth),
    });
  }

  /**
   * Per-render badge geometry for one section: the styled badge string, its
   * visible width, and the section-wide `maxLabelWidth` (label + badges) so
   * the status column aligns across mixed badge sets.  The three badge
   * strings are built once and their widths cached — `visibleWidth` would
   * otherwise re-measure the ANSI-wrapped string per row.
   */
  private badgeLayout(group: Group): {
    badgeFor: (a: CatalogEntry) => string;
    badgeWidth: (a: CatalogEntry) => number;
    maxLabelWidth: number;
  } {
    const theme = this.theme;
    // `❄` marks non-local presets as read-only (only local presets are
    // editable via `e`).  Local presets carry no badge.  `§` (dangling) and
    // `⚠` (orphaned) still apply to presets of any source.
    const LOCK_BADGE = theme.fg("dim", "❄ ");
    const DANGLE_BADGE = theme.fg("warning", "§ ");
    const ORPHAN_BADGE = theme.fg("warning", "⚠ ");
    const LOCK_W = visibleWidth(LOCK_BADGE);
    const DANGLE_W = visibleWidth(DANGLE_BADGE);
    const ORPHAN_W = visibleWidth(ORPHAN_BADGE);
    const isLocked = (a: CatalogEntry): boolean => isCatalogPreset(a) && a.source !== "local";
    const badgeFor = (a: CatalogEntry): string => {
      let b = "";
      if (isLocked(a)) b += LOCK_BADGE;
      if (this.isDangling(a)) b += DANGLE_BADGE;
      if (this.isOrphaned(a)) b += ORPHAN_BADGE;
      return b;
    };
    const badgeWidth = (a: CatalogEntry): number =>
      (isLocked(a) ? LOCK_W : 0) +
      (this.isDangling(a) ? DANGLE_W : 0) +
      (this.isOrphaned(a) ? ORPHAN_W : 0);
    const maxLabelWidth = Math.max(
      0,
      ...group.hooks.map((a) => visibleWidth(this.plainLabel(a)) + badgeWidth(a)),
    );
    return { badgeFor, badgeWidth, maxLabelWidth };
  }

  /**
   * Contextual warning line shown in the detail block under a focused
   * orphaned hook — explains what the `⚠` badge means and how to act on
   * it.  Returns `[]` for non-orphaned hooks so the detail block is
   * unchanged.
   */
  private orphanedDetailLines(a: CatalogEntry): string[] {
    if (!this.isOrphaned(a)) return [];
    return [
      "    " +
        this.theme.fg("warning", "⚠ ") +
        this.theme.fg("dim", "removed from source repo — press r to uninstall"),
    ];
  }

  /**
   * Contextual note shown in the detail block under a focused non-local
   * preset — explains what the `❄` badge means: only local presets are
   * editable via `e`; a repo preset is read-only.  Guides the user to the
   * workaround (copy via `n`) since fork-on-edit was removed.  Returns `[]`
   * for local presets and non-presets so the detail block is unchanged.
   */
  private readonlyDetailLines(a: CatalogEntry): string[] {
    if (!isCatalogPreset(a) || a.source === "local") return [];
    return [
      "    " +
        this.theme.fg("dim", "❄ ") +
        this.theme.fg("dim", "non-editable — cannot copy via n; n creates an empty preset"),
    ];
  }

  /**
   * Contextual warning line shown in the detail block under a focused preset
   * with one or more dangling refs (`§` badge) — lists the refs that don't
   * resolve to an installed Hook. Returns `[]` for non-Presets and
   * for presets whose every ref resolves, so the detail block is unchanged.
   */
  private danglingDetailLines(a: CatalogEntry): string[] {
    const refs = this.danglingRefs(a);
    if (refs.length === 0) return [];
    const label = refs.length === 1 ? "dangling ref" : "dangling refs";
    return [
      "    " +
        this.theme.fg("warning", "§ ") +
        this.theme.fg("dim", `${label}: ${refs.join(", ")}`),
    ];
  }

  /** Panel-wide footer actions; focused-row actions live in the detail suffix. */
  protected hintLine(width?: number): string[] {
    if (this.confirm) {
      return renderHintLine(this.theme, width, [
        ["y", "confirm"],
        ["n", "cancel"],
      ], this.keybindings);
    }

    if (this.searchActive) {
      return renderHintLine(
        this.theme,
        width,
        [HINT_ESC_EXIT_SEARCH],
        this.keybindings,
      );
    }

    const items: HintItem[] = [HINT_SEARCH];
    if (this.state.active.size > 0) items.push(HINT_D_DISABLE_ALL);
    items.push(HINT_I_INSTALL_HOOKS, HINT_N_NEW_PRESET, HINT_ESC_CLOSE);
    return renderHintLine(this.theme, width, items, this.keybindings);
  }

  // ── Theme access ───────────────────────────────────────────────────
  // We capture the theme at construction time (passed in by ctx.ui.custom).
  // The `!` is safe: the panel is always created and rendered inside
  // `ctx.ui.custom(...)`, which calls `setTheme(theme)` before the
  // first `render()`.  TypeScript can't see that ordering, so we hook
  // definite assignment.
  private _theme!: Theme;

  /**
   * The extension context for the current `handleInput` call.  Set at the
   * top of `handleInput` so the shared `toggleFocused()` (parameterless, in
   * the base) can reach `state.updateStatus(ctx)` without threading `ctx`
   * through the shared input path.
   */
  private _ctx!: ExtensionContext;

  setTheme(theme: Theme): void {
    this._theme = theme;
  }

  protected get theme(): Theme {
    return this._theme;
  }

  // ── Input ──────────────────────────────────────────────────────────
  /**
   * Handle a key.  Returns a string when the panel wants the dialog to
   * close (cancel / install / reload), or `undefined` to keep going.
   */
  handleInput(data: string, ctx: ExtensionContext): PanelAction | undefined {
    this._ctx = ctx;

    // ── Confirmation mode ──
    if (this.confirm) {
      if (matchesKey(data, "y")) {
        const { name, source } = this.confirm;
        const result = this.state.mutate({
          type: "remove",
          identity: { source, name },
        });
        this.confirm = null;
        if (!result.ok) {
          ctx.ui.notify(
            `hookit: failed to remove "${name}" — ${formatCatalogFailure(result)}`,
            "error",
          );
          return undefined;
        }
        this._coverage = null;
        this.state.persist();
        return "reload";
      }
      if (matchesKey(data, "n") || this.matchesCancel(data)) {
        this.confirm = null;
        return undefined;
      }
      return undefined;
    }

    // ── Search mode (shared with every sectioned panel) ──
    // Whitelist navigators + Enter + Esc + Backspace; everything else (incl.
    // Space and `r`/`t`/`d`/`i`) feeds the query.  `r`/`t`/`d`/`i` are
    // unreachable until `Esc` exits search.  Owned by `SectionedPanel`.
    if (this.handleSearchInput(data)) return undefined;

    // ── Panel-specific hotkeys (hooks-panel-only) ──
    // `/` (search), Enter (toggle), Tab/Shift+Tab, arrows are shared and live
    // in `handleNavInput` at the bottom; `i`/`n`/`p`/Esc are hooks-only.
    if (matchesKey(data, "i")) {
      if (this.state.projectTrusted === false) {
        ctx.ui.notify("hookit: trust this project before installing hooks.", "error");
        return undefined;
      }
      if (this.state.broken) {
        ctx.ui.notify("hookit: fix hookit.json before installing hooks.", "error");
        return undefined;
      }
      return "install";
    }
    // `n` opens the new-preset dialog (handled by the command loop).  In
    // confirm mode `n` cancels (confirm is checked first); in search `n`
    // feeds the query (search is checked first) — so this branch is only
    // reached in normal mode.
    if (matchesKey(data, "n")) {
      if (this.state.projectTrusted === false) {
        ctx.ui.notify("hookit: trust this project before creating a preset.", "error");
        return undefined;
      }
      if (this.state.broken) {
        ctx.ui.notify("hookit: fix hookit.json before creating a preset.", "error");
        return undefined;
      }
      return "create-preset";
    }
    // `p` jumps to the always-first Presets section (row 0, or the header
    // when empty).  Presets is always index 0 (see `groupBySource`).
    if (matchesKey(data, "p")) {
      this.nav.focus = 0;
      this.nav.selection[0] = 0;
      return undefined;
    }
    if (this.matchesCancel(data)) return "cancel";

    const focused = this.groups[this.nav.focusedSection];
    if (!focused) return undefined;

    // ── d: disable all active hooks (no-op when none active) ──
    if (matchesKey(data, "d")) {
      if (this.state.active.size === 0) return undefined;
      this.state.disableAll();
      this._coverage = null;
      this.state.persist();
      this.state.updateStatus(ctx);
      return undefined;
    }

    // ── r: remove selected catalog identity ──
    if (matchesKey(data, "r")) {
      const selected = focused.hooks[this.nav.focusedIndex];
      if (selected) {
        this.confirm = { name: selected.name, source: selected.source };
      }
      return undefined;
    }

    // ── t: toggle the selected entry's persisted default preference ──
    if (matchesKey(data, "t")) {
      const selected = focused.hooks[this.nav.focusedIndex];
      if (!selected) return undefined;
      const result = this.state.mutate({
        type: "set-default",
        identity: { source: selected.source, name: selected.name },
        value: !selected.default,
      });
      if (!result.ok) {
        ctx.ui.notify(
          `hookit: failed to toggle default — ${formatCatalogFailure(result)}`,
          "error",
        );
        return undefined;
      }
      return "reload";
    }

    // ── e: edit focused preset (local presets only) ──
    // Returns an `edit-preset` action carrying the focused preset; the command
    // loop runs the two-step editor (`description` → `hooks` panel, the same
    // sectioned panel as `/hooks`: Tab/Shift+Tab, `Enter` toggles membership,
    // `Esc` commits + back) and submits local-preset edit intent to the catalog.
    // Only local presets are editable. A non-local preset is read-only (`❄`):
    // its contextual action line omits `e edit preset` and the detail block
    // explains the restriction. Pressing `e` anyway notifies (defensive). An
    // `Esc` with no changes is a no-op (see `editPreset`).  Non-presets
    // notify instead of acting.
    if (matchesKey(data, "e")) {
      const selected = focused.hooks[this.nav.focusedIndex];
      if (!selected) return undefined;
      if (!isCatalogPreset(selected)) {
        ctx.ui.notify(
          "hookit: e edits presets only — select a preset first.",
          "info",
        );
        return undefined;
      }
      if (selected.source !== "local") {
        ctx.ui.notify(
          "hookit: only local presets are editable — this preset is read-only (❄).",
          "info",
        );
        return undefined;
      }
      return { type: "edit-preset", preset: selected };
    }

    // ── Shared navigation (`/` search, Enter toggle, Tab/Shift+Tab cycle,
    // arrows) — identical to the preset editor's hook picker. ──
    if (this.handleNavInput(data)) return undefined;

    return undefined;
  }

  // ── Shared input hook ───────────────────────────────────────────────
  /** Toggle the active state of the currently focused hook. */
  protected toggleFocused(): void {
    const focused = this.groups[this.nav.focusedSection];
    const selected = focused?.hooks[this.nav.focusedIndex];
    if (!selected) return;
    if (this.activeFor(selected)) this.state.disable(selected);
    else this.state.enable(selected);
    this._coverage = null;
    this.state.persist();
    this.state.updateStatus(this._ctx);
  }
}

// ---------------------------------------------------------------------------
// createLocalPreset — `n` new local preset.  Prompts for a name, warns (does
// not silently overwrite) if the name already exists in the local section,
// then submits an empty local preset installation to the catalog.
// ---------------------------------------------------------------------------
export async function createLocalPreset(
  ctx: ExtensionContext,
  state: HooksState,
): Promise<HookIdentity | undefined> {
  const name = await textInputDialog(ctx, {
    title: "New preset",
    label: "Preset name:",
    hint: [HINT_ENTER_CONFIRM, HINT_ESC_CANCEL],
  });
  if (!name) return; // cancelled

  // Creating is intentionally not an upsert: preserve an existing local entry.
  if (state.entries.some((a) => a.source === "local" && a.name === name)) {
    ctx.ui.notify(
      `hookit: "${name}" already exists locally — remove it first.`,
      "warning",
    );
    return;
  }

  const mutation = state.mutate({
    type: "install",
    entries: [{
      identity: { source: "local", name },
      entry: { description: "", preset: [] },
    }],
  });
  if (!mutation.ok) {
    ctx.ui.notify(
      `hookit: failed to create preset — ${formatCatalogFailure(mutation)}`,
      "error",
    );
    return;
  }
  ctx.ui.notify(`hookit: created preset "${name}".`, "info");
  return { source: "local", name };
}

// ---------------------------------------------------------------------------
// editPreset — `e` edit focused preset.  Two-step editor (Q18: lean two-step
// to keep `dialogShell` single-purpose): `description` (text) → `hooks`
// panel (the same sectioned panel as `/hooks`: Tab/Shift+Tab to navigate,
// `Enter` to toggle membership, `Esc` to commit + go back).
//
// Local-only (the `e` handler gates on `source === "local"`; non-local
// presets are read-only `❄` and never reach here). Catalog policy preserves
// the entry's local default preference.
// Forking a repo preset to local on edit was removed — to customize a repo
// preset, copy its content into a new local preset via `n`.
// ---------------------------------------------------------------------------
async function editPreset(
  ctx: ExtensionContext,
  state: HooksState,
  preset: CatalogPreset,
): Promise<void> {
  // Step 1: description (text), seeded with the current description.
  const description = await textInputDialog(ctx, {
    title: "Edit preset",
    label: "Description:",
    initial: preset.description,
    allowEmpty: true,
    hint: [HINT_ENTER_CONFIRM, HINT_ESC_CANCEL],
  });
  if (description === null) return; // cancelled — no data loss

  // Step 2: hooks — the same sectioned panel as `/hooks` (sections by
  // source, fzf-style search, Tab/Shift+Tab navigation). Executable entries
  // are offered: nested presets are dangling for v1, so a ref to a preset is
  // excluded from the picker.  `Enter` toggles membership (`✓`), `Esc`
  // commits + goes back.
  const result = await runPresetEditor(ctx, state, preset, description);

  // No-op guard: skip the write when nothing actually changed, so opening
  // the editor and pressing Esc with no edits doesn't rewrite the file.
  // Membership is compared as a set — the editor can't reorder refs, so a
  // set-equal result means the user toggled nothing.
  const sameDesc = description === preset.description;
  const sameMembers =
    result.value.length === preset.preset.length &&
    result.value.every((r) => preset.preset.includes(r));
  if (sameDesc && sameMembers) return;

  const mutation = state.mutate({
    type: "edit-local-preset",
    identity: { source: preset.source, name: preset.name },
    description,
    preset: result.value,
  });
  if (!mutation.ok) {
    ctx.ui.notify(
      `hookit: failed to edit preset — ${formatCatalogFailure(mutation)}`,
      "error",
    );
    return;
  }
  ctx.ui.notify(`hookit: edited preset "${preset.name}".`, "info");
}

// ---------------------------------------------------------------------------
// runHooksCommand — shows the panel, runs install on demand, and loops
// back so a freshly installed hook is immediately toggleable.
// ---------------------------------------------------------------------------
export function registerHooksCommand(
  pi: ExtensionAPI,
  state: HooksState,
): void {
  pi.registerCommand("hooks", {
    description: "Activate / deactivate hooks",
    handler: async (_args, ctx) => {
      const trustAware = ctx as ExtensionContext & {
        isProjectTrusted?: () => boolean;
      };
      const projectTrusted =
        trustAware.isProjectTrusted?.() ?? state.projectTrusted;
      if (projectTrusted === state.projectTrusted) {
        state.refresh();
      } else {
        // A trust transition changes which storage is authorized, so it starts
        // a new catalog lineage rather than refreshing the old one.
        state.load(
          catalogStorageLocations(ctx.cwd, projectTrusted),
          projectTrusted,
        );
      }
      state.updateStatus(ctx);

      // Each successful action already installs a fresh catalog snapshot.
      // Re-enter only to rebuild the panel around that snapshot, carrying a
      // focus bookmark through every child flow and mutation.
      let reloadFocus: PanelFocusBookmark | undefined;
      while (true) {
        const initialFocus = reloadFocus;
        reloadFocus = undefined;
        const exit = await ctx.ui.custom<PanelExit | null>(
          (tui, theme, kb, done) => {
            const panel = new HooksPanel(state, initialFocus);
            panel.setTheme(theme);
            panel.setKeybindings(kb);
            // Wire the re-render callback so the async orphaned-check can
            // flip `⚠` badges in when `fetchRepoEntries` settles.
            panel.setRequestRender(() => tui.requestRender());
            panel.startOrphanCheck();

            const panelHeight = sectionedPanelHeight(tui.terminal.rows);

            const panelComponent = {
              render: (w: number) => panel.render(w, panelHeight),
              invalidate: () => {},
              handleInput: () => {},
            };

            const box = new OverlayBox(theme, 2, 1);
            box.addChild(panelComponent);

            const container = new Container();
            container.addChild(box);

            return {
              render: (w: number) => container.render(w),
              invalidate: () => container.invalidate(),
              handleInput: (data: string) => {
                const action = panel.handleInput(data, ctx);
                if (action) {
                  done(action === "cancel"
                    ? null
                    : { action, focus: panel.focusBookmark() });
                }
                tui.requestRender();
              },
            };
          },
          sectionedPanelOverlay(),
        );

        if (exit === null) break;

        const { action, focus } = exit;
        reloadFocus = focus;
        if (action === "install") {
          await runInstallWizard(ctx, state);
          continue;
        }
        if (action === "create-preset") {
          const created = await createLocalPreset(ctx, state);
          if (created) reloadFocus = { ...focus, identity: created };
          continue;
        }
        if (typeof action === "object") {
          await editPreset(ctx, state, action.preset);
          continue;
        }
        if (action === "reload") continue;
      }
    },
  });
}
