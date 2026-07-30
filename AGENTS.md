# pi-assert

Shell-assertion guard for pi. Reads `asserts.json` to block tool calls that
fail user-defined shell checks.

## Architecture

- **`pi-assert/index.ts`** — thin Pi adapter. Authorizes catalog storage after
  checking project trust, loads session state, snapshots Pi's rich callback
  context onto bounded scalar metadata, captures one Active Assertion Set,
  attributes and appends per-trigger execution entries, translates explicit
  Hook Evaluation outcomes into Pi callbacks, and delivers ordered semantic
  effects best-effort. It owns no catalog or hook policy.
- **`pi-assert/assertion-catalog/`** — the session-scoped deep Assertion Catalog
  module. Its facade exposes immutable `AssertionCatalog` snapshots, entries
  without storage paths, explicit `{ source, name }` identities, structured
  load/mutation results, and one domain-intent mutation union. Private format
  machinery owns authorized global/optional-project reads, complete validation,
  repository eligibility, whole-record source-preserving merge, provenance,
  canonical persisted records, re-read-before-write mutations, local-default
  preservation, and best-effort atomic replacement. Every successful mutation
  returns a fresh catalog; failures leave the caller's prior snapshot intact.
- **`pi-assert/hook-evaluation/`** — the session-scoped deep Hook Evaluation
  module. Its facade exposes `HookEvaluation`, `createActiveAssertionSet`, the
  typed native event map, bounded execution context, explicit outcomes, and
  delivery-neutral effects. Private collaborators own the exhaustive adapter
  registry, candidate/filter/environment projection, filter → `when` → shell
  Assertion Invocations, frozen synthetic `assert_result` dispatch, fail-closed
  policy, transaction-local immutable execution reporting (including synthetic
  handler-to-origin association), and corrective retry deduplication. Shells
  run via real `child_process.exec`; no shell port exists solely for tests.
- **`pi-assert/domain/entry.ts` / `domain/validation.ts`** — shared persisted
  entry types, canonical source/name key/ref parsing, `AssertIndex` lookups,
  and persisted-entry validation reused by catalog storage and the external
  repository adapter.
- **`pi-assert/config.ts`** — Pi-specific global/project storage-location
  resolution only. Project trust is decided by callers before the optional
  project location is included.
- **`pi-assert/installer.ts`** — external GitHub repository adapter
  (`fetchRuleFiles`/`fetchRuleFile`, session-cached `fetchRepoEntries`) plus
  pure outdated classification and picker helpers. It performs no local
  persistence; fetched entries are submitted to Assertion Catalog mutations.
- **`pi-assert/ui/execution-report.ts`** — the one defensive custom-entry
  payload snapshot and renderer for durable context-neutral per-trigger
  execution summaries. It owns the inset custom-message box, configured-key
  collapsed hint, expanded presentation, bounded persisted trigger metadata,
  duration alignment, and synthetic-handler nesting; Pi owns the global
  expansion binding and session history.
- **`pi-assert/ui/fuzzy.ts`** — pure fuzzy-match module for the `/asserts` panel search mode: `fuzzyMatch` (case-insensitive subsequence + numeric fuzz score), `matchQuery` (the v1a strip-spaces → v1b AND-of-tokens seam), `filterSection` (per-section ranker with numeric per-field tiers so field dominance is deterministic, plus an optional per-field `coerce` that joins a non-string field — a preset's `preset` refs — into the `", "`-joined string `renderAssertDetail` also highlights), and `highlightSegments` (splits a target into matched/unmatched runs for render-time highlighting, reusing `matchQuery` so highlights stay consistent with what ranked the row). No TUI deps, unit-testable in isolation.
- **`pi-assert/ui/components.ts`** — shared UI primitives: `renderDetailList`/
  `DetailList` (the selectable list with inline `shell:`/`when:` detail and an
  optional focused-row suffix, used by both sectioned panels and every install
  picker), `selectDialog`/`textInputDialog` (built on a shared `dialogShell`),
  `renderAssertDetail`, and the one hint formatter for readable configured
  keys, greedy whole-action wrapping, and contextual `›` action runs.
  `selectDialog` supports a focus-aware dynamic hint (`hintFor`) and a
  confirm-on-select guard (`confirmOnSelect`).
- **`pi-assert/ui/state.ts`** — session activation between Assertion Catalog
  and Hook Evaluation. It accepts fresh catalogs, reconciles source-qualified
  saved/default activation, expands one preset level with deduplication, and
  produces immutable Active Assertion Sets. Failed catalog mutations retain
  the known-good catalog and activation.
- **`pi-assert/ui/install.ts`** — the install wizard (repo picker → file
  picker → entry picker). The entry picker is a tri-state `Enter`: not
  installed → install, outdated → update, installed → confirm → uninstall.
  It fetches repository content externally, then expresses catalog intent;
  preset plus available missing members are installed as one batch mutation.
- **`pi-assert/ui/asserts.ts`** — the `/asserts` panel. Detects orphaned
  asserts (installed names removed from their source repo) via an async,
  session-cached `fetchRepoEntries` on panel open, marking them with `⚠` and
  reusing the existing `r` remove flow.
- **`pi-assert/ui/sectioned-panel.ts`** — `SectionedPanel`, the shared base
  for the `/asserts` panel and the preset editor's assert picker. Owns the
  composition (`render`/`bodyLines`/windowing/`renderSectionHeader`/
  `moveFocus`), full-width muted `DynamicBorder` footer framing, the search
  lifecycle, the section-header `Tab`/`Shift+Tab` jump-key hints, AND the
  shared input (`handleSearchInput`/`handleNavInput`/`toggleFocused`) so both
  views are identical except for panel-specific action keys (which live in
  each subclass `handleInput`).
- **`pi-assert/ui/preset-editor.ts`** — the preset editor's assert picker
  (`PresetEditorPanel`, a `SectionedPanel` subclass). Adds only the
  panel-specific hooks: header, footer hint, contextual add/remove action,
  `renderSection` (`✓`/space membership badge), empty-state message, and the
  one panel-specific key (`Esc` = commit + back). Search, navigation, and
  toggle are inherited — no parallel path.
- **`skills/pi-assert/SKILL.md`** — bundled skill describing the format, hooks,
  filters, shell, env vars, and common patterns.

## Key Design Decisions

- Shell commands run through `child_process.exec` → pipes, redirects, `&&`, `||`
  all work via `/bin/sh`.
- Optional `when` precondition shell runs first; main `shell` only executes if
  `when` exits 0. Skip expensive asserts when they don't apply.
- Default timeout of 5 seconds prevents hanging asserts.
- Tool hooks fail fast. `turn_end`, `agent_end`, `agent_settled`, and cancellable
  session guards aggregate every failure; Hook Evaluation's private adapter
  registry is the source of truth for each hook's action and feedback.
- Lifecycle adapters expose bounded scalar candidates through both filters and
  JSON `PI_EVENT_PAYLOAD`; rich/native event objects are intentionally deferred.
  `assert_result` exposes only `event`, canonical `assertionRef`, originating
  `runId`, individual `outcome`, and numeric/`null` `code`. Its handlers are
  awaited without the originating abort signal and can never alter the frozen
  originating outcome; handler assertion/run identity remains separate.
- `session_before_switch` and `session_before_fork` can cancel. `session_shutdown`
  is not a supported assertion hook because Pi exposes no cancellation result.
- Trusted project entries replace global entries only when Assertion Source and
  name both match; whole records replace rather than merging fields.
- No special handling for `"false"` — it's just the Unix `false` command
  (always exits 1).
- **Search swaps `groups`/`nav`, not the renderer.** The `/asserts` panel's
  fuzzy-search mode filters by pointing `this.groups`/`this.nav` at filtered
  subsets of the same `Assert` objects (originals saved and restored on `Esc`).
  `bodyLines`, `renderSection`, and the windowing math run **unchanged** against
  the filtered model — one shared implementation, no parallel render path.
  Ranking is per-section (`filterSection`) so section grouping and order stay
  stable while matches rank inside each section; empty sections drop out.
- **Outdated detection excludes `default`.** The content signature
  (`entryContentSignature`) compares only repo-driven fields
  (`description`, `hook`, `shell`, `filter`, `when`); `default` is a local
  toggle, never a repo-driven change. Catalog update intent preserves the
  current persisted preference.
- **Outdated is per-file; orphaned is panel-wide.** The install wizard entry
  picker detects outdated asserts (installed name, content differs) using the
  file already being browsed — no extra fetch. The `/asserts` panel detects
  orphaned asserts (installed name missing from the repo) via a session-cached
  `fetchRepoEntries`. Both degrade silently on network failure.
- **Prefer one shared implementation over two.** Catalog persistence and
  validation, Hook Evaluation, execution-entry rendering, list/dialog
  rendering, sectioned-panel composition + input, and text measuring/wrapping
  each live in a single module (`assertion-catalog/`, `hook-evaluation/`,
  `ui/execution-report.ts`, `ui/sectioned-panel.ts`, `ui/components.ts`, and
  pi-tui's `visibleWidth`/`wrapTextWithAnsi` respectively) that every caller
  builds on. When adding a new view or hook, extend the shared core instead of
  copying the logic — two copies will silently drift.
- **Sectioned panels share input, not just rendering.** `SectionedPanel`
  owns the search-mode block and the normal-mode navigation keys
  (`handleSearchInput`/`handleNavInput`) plus `toggleFocused`; the `/asserts`
  panel and the preset editor's assert picker are identical except for
  panel-specific action keys in each subclass `handleInput` (search first via
  `handleSearchInput`, then panel-specific keys, then `handleNavInput` last).
  The only keys that differ are the hint line and each panel's own actions
  (`i`/`n`/`p`/`d`/`r`/`t`/`e`/`Esc`=cancel in `/asserts`; `Esc`=commit in
  the preset editor).
- **Highlighting is a render concern, not a filter concern.** Search match
  highlighting recomputes `highlightSegments(query, field)` per visible field
  at render time rather than threading `FuzzyResult.positions` through the
  panel. The matching algorithm stays single-sourced in `matchQuery` (both
  `filterSection` and `highlightSegments` call it — reuse, not duplication);
  the redundant calls are microseconds and avoid a `FuzzyResult`/`SectionMatch`
  shape change, new panel-side positions state, and a second helper. The name
  highlights via the panel's `renderLabel` (one method shared by the active
  and inactive row paths); `shell`/`when` highlight in `renderAssertDetail`,
  pre-styled before the ANSI-aware `wrapTextWithAnsi` so highlights carry
  across wrapped lines. A `score === 0` dead path returns no segments, so a
  field lights up iff it contributed to ranking.  The `preset` field is
  fuzzy-ranked via a `coerce` join (`filterSection` joins the array with `", "`,
  the same join `renderAssertDetail` uses for the `asserts:` detail) at the
  `shell`/`when` tier, so a search for a ref name surfaces the referencing
  preset and highlights it across the joined string — the coerce output must
  match the renderer's join so highlight positions align with the rank.
- **Focused-entry actions are contextual; panel-wide actions stay in the
  footer.** Both sectioned panels append an unboxed accent `›` action run as
  the final focused-row detail. `/asserts` predicts individual enable/disable
  and default transitions, always offers removal, and offers editing only for
  local presets; search retains only its still-active Enter action. The preset
  editor predicts membership add/remove. The persistent footer contains only
  search, panel-wide commands, and close/back, framed by full-width muted
  `DynamicBorder` rules. Shared hint formatting normalizes configured Pi key
  ids without changing input matching and wraps only between action segments.
- **Only local presets are editable; repo presets are read-only.** The `/asserts`
  panel's `e` action is gated on `source === "local"`; a non-local preset
  carries a `❄` (snowflake, dim) badge, omits `e edit preset` from its
  contextual action run, shows a `❄ non-editable` detail note, and defensively
  notifies if `e` is pressed anyway. Catalog `edit-local-preset` intent
  enforces local-only ownership and preserves the on-disk `default`. Forking a
  repo preset to local on edit was removed. The `❄`/`§`/`⚠` badges are all
  text-presentation BMP glyphs (reliable single-width in monospace terminals),
  not emoji.
