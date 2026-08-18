# HooKit

Hooks with outcome-selected owned Actions for Pi events. Reads
`hookit.json` to decide Event Outcomes and request supported Pi Effects.

## Architecture

- **`hookit/index.ts`** — thin Pi adapter. Authorizes catalog storage after
  checking project trust, loads session state, snapshots Pi's rich callback
  context onto bounded scalar metadata, captures one Enabled Hook Set,
  subscribes passively to Pi's `tool_execution_start`/`_end` lifecycle,
  brackets each supported Native Event callback with the session
  ExecutionReporter
  (tool-wave collection + combined Execution Wave flush + late append),
  translates the first Event Outcome in each Hook Evaluation Outcome into
  Pi callbacks, and delivers ordered Effects best-effort without changing
  Event Outcomes when delivery fails. It maps delivery-neutral Action Requests
  onto ordinary
  Pi context/API operations; it owns no catalog or hook policy.
- **`hookit/hook-catalog/`** — the session-scoped deep Hook Catalog
  module. Its facade exposes immutable `HookCatalog` snapshots, entries
  without storage paths, explicit `{ source, name }` identities, structured
  load/mutation results, and one domain-intent mutation union. Private format
  machinery owns authorized global/optional-project reads, complete validation,
  canonical source and storage eligibility, whole-record source-preserving
  merge, provenance,
  canonical persisted Hook and Preset records (including effective
  `shell: "true"`), post-merge Preset relationship validation, candidate
  validation before persistence, re-read-before-write mutations, local-default
  preservation, and best-effort atomic replacement. Every successful mutation
  returns a fresh catalog; failures leave the caller's prior snapshot intact.
- **`hookit/hook-evaluation/`** — the session-scoped deep Hook Evaluation
  module. Its facade exposes `HookEvaluation`, `createEnabledHookSet`, the
  typed Native Event map, bounded Evaluation Context, Hook Evaluation Outcome,
  event-typed Event Outcomes, and delivery-neutral Effects. One private
  Event-evaluation mechanism uses the
  exhaustive adapter registry for candidate/Filter/environment projection,
  filter → `when` → shell Hook Invocations, immutable individual Hook Results,
  fail-closed aggregation, owned-Action selection, Effects, and ordered
  Evaluation Report rows for both Native Events and Hook Result Events. The
  outer Hook Evaluation
  alone projects Hook Result Events and prevents recursion. The public outcome
  exposes the Native Event Outcome first, followed by one pass/report Hook
  Result Event Outcome per originating Hook Result; corrective retry
  deduplication remains session-scoped. Ordinary
  shells run via real `child_process.exec`; exact `true`/`false` shortcuts stay
  hidden in the shared evaluator. No shell port exists solely for tests.
- **`hookit/domain/entry.ts` / `domain/validation.ts`** — shared persisted
  entry types, canonical source/name key/ref parsing, `HookIndex` lookups,
  and persisted-entry validation reused by catalog storage and the external
  repository adapter.
- **`hookit/config.ts`** — Pi-specific global/project storage-location
  resolution only. Project trust is decided by callers before the optional
  project location is included.
- **`hookit/installer.ts`** — external GitHub repository adapter
  (`fetchHookFiles`/`fetchHookFile`, session-cached `fetchRepoEntries`) plus
  pure outdated classification and picker helpers. It performs no local
  persistence; fetched entries are submitted to Hook Catalog mutations.
- **`hooks/`** — the remote-only first-party Core catalog under canonical
  Source `meffmadd/HooKit`: 35 opt-in Hooks and the `read-only` Preset. Core
  entries are schema-, catalog-, installation-, and behavior-tested with
  HooKit, but npm packaging excludes the complete directory. Specialized and
  incubating entries belong to `meffmadd/HooKit-extras`.
- **`hookit/ui/execution-report.ts`** — the one defensive custom-entry
  module for durable context-neutral Execution Reports. It owns the
  session-scoped `ExecutionReporter` (tracks tools in `tool_execution_start`
  order with monotonic start/end timestamps, brackets every supported callback
  with `begin`/`complete`, assigns segment order at `begin`, collects every
  tool Hook Evaluation for one tool execution lifecycle into one combined
  Execution Wave that flushes a single report at the next non-tool event entry,
  appends
  ordinary Events immediately, waits for `session_shutdown` to flush a pending
  wave, discards an incomplete tool lifecycle rather than inventing an end, and
  persists one end-to-end `durationMs` = `max(end) − min(start)` across tool
  lifecycle) plus the shared defensive renderer (strict new-shape-only
  validation with an unavailable fallback for malformed current-type entries,
  flat `✓/✗` ordered rows with inline `from` origin annotations, per-tool collapsed
  breakdown by unique lifecycle identity, per-segment dim headers in Pi event
  order, configured-key collapsed hint, inset custom message box). Pi owns the
  global expansion binding and session history; the thin adapter wires the
  append callback, forwards tool identity, and flushes on shutdown.
- **`hookit/ui/fuzzy.ts`** — pure fuzzy-match module for the `/hooks` panel search mode: `fuzzyMatch` (case-insensitive greedy subsequence returning matched positions only), `matchQuery` (the v1a strip-spaces → v1b AND-of-tokens seam), `filterSection` (per-section ranker using four coarse ordered tiers — name, description, source, then body fields shell/when/Action/preset-refs — so tier dominance is deterministic and same-tier entries keep catalog order, plus an optional per-field `coerce` that joins a non-string field — a preset's `preset` refs — into the `", "`-joined string `renderHookDetail` also highlights), and `highlightSegments` (splits a target into matched/unmatched runs for render-time highlighting, reusing `matchQuery` so highlights stay consistent with what ranked the row). No TUI deps, unit-testable in isolation.
- **`hookit/ui/components.ts`** — shared UI primitives: `renderDetailList`/
  `DetailList` (the selectable list with inline `event:`/`shell:`/`when:` detail
  and an
  optional focused-row suffix, used by both sectioned panels and every install
  picker), `selectDialog`/`textInputDialog` (built on a shared `dialogShell`),
  `renderHookDetail`, and the one hint formatter for readable configured
  keys, greedy whole-action wrapping, and contextual `›` action runs.
  `selectDialog` supports a focus-aware dynamic hint (`hintFor`) and a
  confirm-on-select guard (`confirmOnSelect`).
- **`hookit/ui/state.ts`** — session enablement between Hook Catalog and
  Hook Evaluation. It accepts fresh Catalogs, restores source-qualified direct
  `enabledEntries` or recomputes defaults, expands enabled Presets with
  source-qualified first-occurrence deduplication, and produces immutable
  Enabled Hook Sets. Failed Catalog mutations retain the known-good Catalog and
  enablement.
- **`hookit/ui/install.ts`** — the install wizard (repo picker → file
  picker → entry picker). The entry picker is a tri-state `Enter`: not
  installed → install, outdated → update, installed → confirm → uninstall.
  It fetches repository content externally, then expresses catalog intent;
  preset plus available missing members are installed as one batch mutation.
- **`hookit/ui/hooks.ts`** — the `/hooks` panel. Detects orphaned
  hooks (installed names removed from their source repo) via an async,
  session-cached `fetchRepoEntries` on panel open, marking them with `⚠` and
  reusing the existing `r` remove flow.
- **`hookit/ui/sectioned-panel.ts`** — `SectionedPanel`, the shared base
  for the `/hooks` panel and the preset editor's hook picker. Owns the
  composition (`render`/`bodyLines`/windowing/`renderSectionHeader`/
  `moveFocus`), full-width muted `DynamicBorder` footer framing, the search
  lifecycle, the section-header `Tab`/`Shift+Tab` jump-key hints, AND the
  shared input (`handleSearchInput`/`handleNavInput`/`toggleFocused`) so both
  views are identical except for panel-specific action keys (which live in
  each subclass `handleInput`).
- **`hookit/ui/preset-editor.ts`** — the preset editor's hook picker
  (`PresetEditorPanel`, a `SectionedPanel` subclass). Adds only the
  panel-specific hooks: header, footer hint, contextual add/remove action,
  `renderSection` (`✓`/space membership badge), empty-state message, and the
  one panel-specific key (`Esc` = commit + back). Search, navigation, and
  toggle are inherited — no parallel path.
- **`skills/hookit/SKILL.md`** — bundled skill describing the format, events,
  filters, Hooks, owned Actions, env vars, and common patterns.
- **`site/`** — the static fumadocs documentation site (Getting Started, Reference,
  Concepts) plus its glossary search and three testing seams. The Reference
  glossary (`content/docs/reference/glossary.mdx`) documents every capitalized
  Term from `CONTEXT.md` with one `## Term [#anchor]` heading per entry. The
  auto-linker (`site/src/glossary-link.ts`, wired as
  `[remarkGlossaryLinks, { oncePerPage: true }]` in `astro.config.mjs`) links
  each Term once per page to `/reference/glossary#anchor` — longest phrase
  first, whole-word and case-sensitive, with `s`/`s'`/`'s`/`ies` flexes and
  never inside existing links, headings, or code. A rehype pass
  (`rehypeGlossaryTooltips`) stamps the emitted links with `data-glossary*`
  attributes (anchor, Term, plain-text definition parsed from the glossary
  page body, so the definition stays single-sourced), and a small vanilla-JS
  tooltip (`site/src/glossary-tooltip.ts`, loaded from `layout.astro`) shows
  a fully opaque definition card after a 300ms dwell, clamped to the visible
  article area (`resolveTooltipPosition`: above the link, flipping below and
  clamping both axes so it never overflows the sidebar or viewport edges);
  the tooltip lives on `document.body` and Astro's `ClientRouter` replaces
  the whole body on each view-transition navigation, so `layout.astro`
  rebuilds it on the `astro:page-load` event (fires on the initial `load` and
  after every navigation) by destroying the previous instance
  (`createGlossaryTooltip().destroy()` removes element + listeners) before
  creating the new one — the tooltip must survive any page change, never
  accumulate instances; the links still navigate. The
  build-level smoke
  test (`tests/docs-build.test.ts`) runs the real `astro build`, asserts every
  Getting Started/Reference/Concepts destination is published, preserves redirects
  for moved Reference pages, and checks the visible 🦉 HooKit brand;
  `tests/docs-examples.test.ts` validates every designated
  fenced `json` block (marked `{/* docs-example:valid */}` or
  `{/* docs-example:invalid */}` in MDX, and `<!-- docs-example:valid -->` or
  `<!-- docs-example:invalid -->` in plain Markdown; invisible in print)
  against the same `schema.json` users configure against; and
  `tests/glossary-link.test.ts` pins the matcher, the transformer shape, and a
  drift guard asserting the glossary page stays in sync with the auto-link
  term list.

## Key Design Decisions

- **Core is a support tier, not a runtime Source kind.** Core Catalog Entries
  use the ordinary remote GitHub adapter and canonical `owner/repo` identity;
  they receive no Hook Catalog or Hook Evaluation special case. They remain
  opt-in and outside the npm artifact.
- Ordinary shell commands run through `child_process.exec` → pipes, redirects,
  `&&`, and `||` work via `/bin/sh`. Exact `true`/`false` commands (including
  `when`) return normal code 0/1 results without a subprocess; no trimming or
  syntax recognition occurs.
- Optional `when` runs first. Ordinary non-zero skips the complete Hook;
  infrastructure failure produces the event-specific code-`null` result.
- Hooks author at least one optional `shell` or singular owned `action`.
  Omitted shell canonicalizes to `"true"`; downstream Catalog/Enabled Hook shapes
  always have an effective shell.
- Owned Actions require `outcome`, may select `code`, and observe only their
  immutable owner's Hook Outcome and code. Their selector metadata is stripped
  from the delivery-neutral Action Request Effect. Selector semantics are
  shared with the outcome/code fields of `hook_result` Filters.
- Hook Evaluation freezes the aggregate Native Event Outcome before result-major
  reactions. For each originating Hook Result, the owned Action is considered
  before its Hook Result Event is evaluated through the same private mechanism.
  The outer Evaluation does not project an Event from a reactive Hook Result,
  so that local result can select its owned Action but is never dispatched
  recursively.
- Tool and lifecycle/session Events run all matching Hooks
  sequentially and aggregate failures. Unexpected per-Hook errors fail the
  event closed without stopping siblings and invent no result or Action.
- The thin adapter maps Effects to `ctx.abort`, `ctx.shutdown`, `ctx.compact`,
  HooKit custom messages, or `pi.events.emit` and delivers them in order,
  best-effort, without changing Event Outcomes. Only the first Native Event
  Outcome has Pi control authority; reactive Event Outcomes remain observable.
- Lifecycle adapters expose bounded scalar candidates through both Filters and
  JSON `PI_EVENT_PAYLOAD`; rich Native Event objects are intentionally deferred.
  `hook_result` exposes only `event`, canonical `hookRef`, originating
  `invocationId`, individual Hook `outcome`, and numeric/`null` `code`. Its
  handlers are awaited without the originating abort signal and can never alter
  the frozen Native Event Outcome; handler Hook/invocation identity remains
  separate.
- `session_before_switch` and `session_before_fork` can cancel. `session_shutdown`
  is not a supported Event because Pi exposes no cancellation result.
- Trusted project entries replace global entries only when Hook Source and
  name both match; whole records replace rather than merging fields.
- **Catalog relationships validate after merge.** Catalog Entry names are
  non-empty and contain neither `/` nor NUL; Preset Hook References are unique.
  An unresolved reference remains valid and dangling, while a reference that
  resolves to a Preset fails the complete Catalog until nesting is supported.
  Mutation candidates undergo the same validation before persistence, so
  installing, updating, or editing into known nesting fails atomically; removing
  a referenced Hook may leave a dangling reference.
- **Canonical source eligibility is one catalog policy.** A section is valid
  only as `local` or one `owner/repo`. Global canonical sections merge
  independently of project `repos`; every project `owner/repo` section must be
  declared in that storage's `repos` array, and missing `repos` permits only
  `local`. Ineligible sections are never silently filtered — they produce a
  catalog failure diagnostic, and a failed mutation leaves the caller's
  known-good Catalog and enablement unchanged.
- **Direct enablement uses canonical keys only.** Saved `enabledEntries`
  restores only NUL-separated `source\0name` keys present in the current
  Catalog; bare names are silently discarded with no unambiguous-name
  resolution, and `isEnabledDirectly` checks only the canonical key. Missing
  saved enablement derives from current defaults, while a saved empty set
  overrides defaults.
- **One Execution Wave per tool execution lifecycle; one end-to-end duration.** Every
  `tool_call`/`tool_result` Hook Evaluation for a batch joins a single combined
  wave bracketed by `tool_execution_start`/`_end` lifecycle. Only Evaluation
  Reports join the wave; Event Outcomes from independent Evaluations remain
  separate. The report has one
  `durationMs` = `max(end) − min(start)`; there is no `criticalPathMs`.
  Individual Hook rows measure passing `when` + main `shell`. A wave with
  an incomplete tool lifecycle is discarded rather than assigned an invented
  end. Tool call and result reports are never split by Event. Evaluation and
  every Effect delivery attempt complete before the observation closes, so
  Execution Duration includes the complete callback-owned work.
- **Reports are flat ordered rows.** A Hook Evaluation Outcome optionally emits
  one Evaluation Report with one ordered `rows` sequence (originating Hook row, its owned Action row, then reactive
  `hook_result` rows and their Actions, per originating Hook Result). Reporting
  rows carry no Invocation ID, row-level Event, origin Invocation ID, Action
  payload, shell text,
  or depth. The renderer draws those rows flat with `from` origin annotations —
  no causal maps, consumed sets, or reactive display-only result rows.
- **Fuzzy search ranks by coarse field tier, not relevance.** Entries rank by
  their highest matching field tier (name > description > source > body); ties
  keep catalog order. Matched positions drive highlighting only.
- **Search swaps `groups`/`nav`, not the renderer.** The `/hooks` panel's
  fuzzy-search mode filters by pointing `this.groups`/`this.nav` at filtered
  subsets of the same `Hook` objects (originals saved and restored on `Esc`).
  `bodyLines`, `renderSection`, and the windowing math run **unchanged** against
  the filtered model — one shared implementation, no parallel render path.
  Ranking is per-section (`filterSection`) so section grouping and order stay
  stable while matches rank inside each section; empty sections drop out.
- **Outdated detection excludes `default`.** The content signature
  (`entryContentSignature`) compares only repo-driven fields
  (`description`, `event`, canonical `shell`, optional owned `action`, `filter`,
  `when`); `default` is a local
  toggle, never a repo-driven change. Catalog update intent preserves the
  current persisted preference.
- **Outdated is per-file; orphaned is panel-wide.** The install wizard entry
  picker detects outdated hooks (installed name, content differs) using the
  file already being browsed — no extra fetch. The `/hooks` panel detects
  orphaned hooks (installed name missing from the repo) via a session-cached
  `fetchRepoEntries`. Both degrade silently on network failure.
- **Prefer one shared implementation over two.** Catalog persistence and
  validation, Hook Evaluation, execution-entry rendering, list/dialog
  rendering, sectioned-panel composition + input, and text measuring/wrapping
  each live in a single module (`hook-catalog/`, `hook-evaluation/`,
  `ui/execution-report.ts`, `ui/sectioned-panel.ts`, `ui/components.ts`, and
  pi-tui's `visibleWidth`/`wrapTextWithAnsi` respectively) that every caller
  builds on. When adding a new view or event, extend the shared core instead of
  copying the logic — two copies will silently drift.
- **Sectioned panels share input, not just rendering.** `SectionedPanel`
  owns the search-mode block and the normal-mode navigation keys
  (`handleSearchInput`/`handleNavInput`) plus `toggleFocused`; the `/hooks`
  panel and the preset editor's hook picker are identical except for
  panel-specific action keys in each subclass `handleInput` (search first via
  `handleSearchInput`, then panel-specific keys, then `handleNavInput` last).
  The only keys that differ are the hint line and each panel's own actions
  (`i`/`n`/`p`/`d`/`r`/`t`/`e`/`Esc`=cancel in `/hooks`; `Esc`=commit in
  the preset editor).
- **Highlighting is a render concern, not a filter concern.** Search match
  highlighting recomputes `highlightSegments(query, field)` per visible field
  at render time rather than threading matched positions through the panel.
  The matching algorithm stays single-sourced in `matchQuery` (both
  `filterSection` and `highlightSegments` call it — reuse, not duplication);
  the redundant calls are microseconds and avoid a shapes change, new
  panel-side positions state, and a second helper. The name highlights via the
  panel's `renderLabel` (one method shared by the focused and unfocused row
  paths); `shell`/`when` highlight in `renderHookDetail`, pre-styled before
  the ANSI-aware `wrapTextWithAnsi` so highlights carry across wrapped lines.
  A field lights up iff its `matchQuery` is a subsequence (it contributed to
  there being a result). The `preset` field is ranked via a `coerce` join
  (`filterSection` joins the array with `", "`, the same join
  `renderHookDetail` uses for the `hooks:` detail) at the `shell`/`when`
  tier, so a search for a ref name surfaces the referencing preset and
  highlights it across the joined string — the coerce output must match the
  renderer's join so highlight positions align with the rank.
- **Focused-entry actions are contextual; panel-wide actions stay in the
  footer.** Both sectioned panels append an unboxed accent `›` action run as
  the final focused-row detail. `/hooks` predicts individual enable/disable
  and default transitions, always offers removal, and offers editing only for
  local presets; search retains only its still-applicable Enter action. The preset
  editor predicts membership add/remove. The persistent footer contains only
  search, panel-wide commands, and close/back, framed by full-width muted
  `DynamicBorder` rules. Shared hint formatting normalizes configured Pi key
  ids without changing input matching and wraps only between action segments.
- **Only local presets are editable; repo presets are read-only.** The `/hooks`
  panel's `e` action is gated on `source === "local"`; a non-local preset
  carries a `❄` (snowflake, dim) badge, omits `e edit preset` from its
  contextual action run, shows a `❄ non-editable` detail note, and defensively
  notifies if `e` is pressed anyway. Catalog `edit-local-preset` intent
  enforces local-only ownership and preserves the on-disk `default`. Forking a
  repo preset to local on edit was removed. The `❄`/`§`/`⚠` badges are all
  text-presentation BMP glyphs (reliable single-width in monospace terminals),
  not emoji.
