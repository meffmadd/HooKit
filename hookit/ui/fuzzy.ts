/**
 * Pure fuzzy-match helpers for the `/hooks` panel search mode.
 *
 * No `Theme` / TUI deps so this is unit-testable in isolation. The panel calls
 * `filterSection` once per section; `filterSection` routes every field through
 * `matchQuery` (the v1a → v1b seam), and `matchQuery` calls the pure
 * single-string matcher `fuzzyMatch`.
 *
 * Matching is a case-insensitive greedy subsequence only: returned positions
 * drive highlighting, and ranking uses four coarse ordered field tiers with
 * stable catalog order within a tier. There are no relevance heuristics —
 * no match bonuses, gap penalties, camel-case detection, or score clamping.
 */

import type {
  CatalogHook,
  CatalogEntry,
  CatalogPreset,
} from "../hook-catalog/index.js";
import { actionDetailText } from "../domain/entry.js";

/**
 * Pure case-insensitive greedy subsequence matcher. Returns the matched
 * indices in `target` (driving highlighting), or `null` when `query` is not a
 * subsequence of `target`. Never sees spaces in the query — callers normalize
 * whitespace out first (`matchQuery`).
 */
export function fuzzyMatch(
  query: string,
  target: string,
): readonly number[] | null {
  if (query.length === 0) return [];

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const positions: number[] = [];

  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q.charCodeAt(qi);
    let found = -1;
    while (ti < t.length) {
      if (t.charCodeAt(ti) === ch) {
        found = ti;
        ti++; // next search starts after this match
        break;
      }
      ti++;
    }
    if (found < 0) return null;
    positions.push(found);
  }
  return positions;
}

/**
 * Query-normalized match — the v1a → v1b seam.
 *
 * Spaces are ignored for matching (stripped), so `"no env"` matches
 * `"no-env"`; the display keeps the spaces verbatim. `fuzzyMatch`,
 * `filterSection`, and the panel are unchanged by the space handling.
 */
export function matchQuery(
  query: string,
  target: string,
): readonly number[] | null {
  return fuzzyMatch(query.replace(/\s+/g, ""), target);
}

export interface Segment {
  text: string;
  matched: boolean;
}

/**
 * Split `target` into matched/unmatched runs for `query`'s subsequence, for
 * rendering highlights. Routes through `matchQuery` (same space-stripping,
 * same positions the ranker used) so a highlight is consistent with what
 * matched the hook: a field lights up iff it contributed to ranking.
 *
 * Returns `null` when there's no usable match — an empty/whitespace query or
 * a non-subsequence — so the caller renders the target plain. Pure, no TUI
 * deps; unit-testable alongside `fuzzyMatch`.
 */
export function highlightSegments(
  query: string,
  target: string,
): Segment[] | null {
  const positions = matchQuery(query, target);
  if (positions === null || positions.length === 0 || target.length === 0) {
    return null;
  }

  const matched = new Set(positions);
  const segs: Segment[] = [];
  let buf = "";
  let bufMatched = false;
  for (let i = 0; i < target.length; i++) {
    const isMatched = matched.has(i);
    if (i === 0) {
      buf = target[i]!;
      bufMatched = isMatched;
      continue;
    }
    if (isMatched === bufMatched) {
      buf += target[i]!;
    } else {
      segs.push({ text: buf, matched: bufMatched });
      buf = target[i]!;
      bufMatched = isMatched;
    }
  }
  if (buf.length > 0) segs.push({ text: buf, matched: bufMatched });
  return segs;
}

/**
 * Per-field config: which catalog-entry field, its coarse ordered tier, and
 * an optional `coerce` that turns a non-string field value into the string
 * `matchQuery` ranks on. Without `coerce` the value is used only when it's
 * already a non-empty string. `coerce`'s output must match the string the
 * renderer feeds `highlightSegments` so a highlight aligns with the rank —
 * `renderHookDetail` joins a preset's refs with the same `", "`.
 */
const FIELDS: {
  field: keyof CatalogHook | keyof CatalogPreset;
  tier: number;
  coerce?: (v: unknown) => string;
}[] = [
  { field: "name", tier: 0 },
  { field: "description", tier: 1 },
  { field: "source", tier: 2 },
  { field: "shell", tier: 3 },
  { field: "when", tier: 3 },
  { field: "action", tier: 3, coerce: (v) =>
    typeof v === "object" && v !== null
      ? actionDetailText(v as NonNullable<CatalogHook["action"]>)
      : "" },
  // A preset's `preset` refs are a string array; `coerce` joins them (with
  // `", "`, matching `renderHookDetail`'s `hooks:` join) so a search for a
  // ref name surfaces the preset that references it. Same tier as
  // `shell`/`when` — it's the preset's body text.
  { field: "preset", tier: 3, coerce: (v) => (Array.isArray(v) ? v.join(", ") : "") },
];

/**
 * Filter + rank one section's catalog entries against a query, best-first.
 * Empty (or all-whitespace) query returns every entry in original order.
 *
 * Ranking is per-section by design — the panel calls this once per section so
 * section grouping and order stay stable while matches rank inside each
 * section. An entry ranks by its **highest matching tier** only (name >
 * description > source > shell/when/Action/preset-refs). Entries in the same
 * tier retain catalog order: no target-position or match-gap quality changes
 * ordering. A non-subsequence match in any field drops the entry from the
 * section.
 */
export function filterSection(
  query: string,
  entries: readonly CatalogEntry[],
): CatalogEntry[] {
  const stripped = query.replace(/\s+/g, "");
  if (!stripped) return Array.from(entries);

  const ranked: Array<{ entry: CatalogEntry; tier: number }> = [];
  for (const entry of entries) {
    // FIELDS is ordered by priority, so the first matching field wins.
    for (const { field, tier, coerce } of FIELDS) {
      const raw = (entry as unknown as Record<string, unknown>)[field];
      const value = coerce
        ? coerce(raw)
        : typeof raw === "string" ? raw : "";
      if (value.length === 0) continue;
      if (matchQuery(stripped, value) !== null) {
        ranked.push({ entry, tier });
        break;
      }
    }
  }

  // Tier 0 (name) outranks every higher number; ties keep catalog order via a
  // stable sort.
  ranked.sort((a, b) => a.tier - b.tier);
  return ranked.map((item) => item.entry);
}
