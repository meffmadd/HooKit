/**
 * Auto-links capitalized glossary Terms in the documentation to the on-site
 * Reference glossary (`content/docs/reference/glossary.mdx`).
 *
 * The mapping (`GLOSSARY_TERMS`) is the single source of truth for what gets
 * linked: the glossary page declares one `## Term [#anchor]` heading per
 * entry, and `tests/glossary-link.test.ts` asserts the page stays in sync
 * with this list. Adding a term here (and to the glossary page) links it
 * across every prose occurrence without touching page sources.
 *
 * Matching is deliberately narrow so links never corrupt code, cross-links,
 * or navigation:
 *
 * - case-sensitive on the exact capitalized Term, longest phrase first
 *   (`Hook Result Event` beats `Hook Result` beats `Hook`), with only the
 *   plural/possessive flexes `s`, `s'`, `'s`, and `y` → `ies`;
 * - text only — fenced `code`, `inlineCode`, `html`, JSX/MDX nodes, existing
 *   `link`/`linkReference`, and every `heading` subtree are left untouched;
 * - by default each Term links once per page (its first linkable
 *   occurrence), keeping prose readable while guaranteeing every Term on
 *   every page navigates to the glossary. `oncePerPage: false` links every
 *   occurrence.
 *
 * Register with the canonical computed form so MDX treats it as a plugin
 * factory: `[remarkGlossaryLinks, { oncePerPage: true }]`. No TUI deps; the
 * matching core (`linkifyGlossaryText`) is pure and unit-testable in
 * isolation.
 *
 * Tooltips: `rehypeGlossaryTooltips` reads the glossary page body and stamps
 * each auto-linked `<a>` with `data-glossary-*` attributes (anchor, Term,
 * definition). `global.css` turns those into hover/focus tooltips; the
 * definition stays single-sourced in `glossary.mdx`.
 */

import type { Plugin } from "unified";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { visit } from "unist-util-visit";
import type { Element as HastElement } from "hast";

export interface GlossaryTerm {
  /** Canonical capitalized Term as it appears in prose. */
  term: string;
  /** Custom heading id on the glossary page (`## Term [#anchor]`). */
  anchor: string;
}

const GLOSSARY_URL = "/reference/glossary";

/**
 * Single source of truth for auto-linked Terms (longest phrases first is
 * applied at pattern-build time, so source order here does not matter).
 * The `report` Outcome kind is documented on the glossary page but never
 * auto-linked: it is a lowercase `report` code value in prose, not a
 * capitalized Term.
 */
export const GLOSSARY_TERMS: GlossaryTerm[] = [
  { term: "Hook Result Event", anchor: "hook-result-event" },
  { term: "Hook Evaluation Outcome", anchor: "hook-evaluation-outcome" },
  { term: "Enabled Catalog Entry", anchor: "enabled-catalog-entry" },
  { term: "Extras Catalog Entry", anchor: "extras-catalog-entry" },
  { term: "Core Catalog Entry", anchor: "core-catalog-entry" },
  { term: "Execution Duration", anchor: "execution-duration" },
  { term: "Execution Wave", anchor: "execution-wave" },
  { term: "Execution Report", anchor: "execution-report" },
  { term: "Evaluation Report", anchor: "evaluation-report" },
  { term: "Hook Invocation", anchor: "hook-invocation" },
  { term: "Invocation ID", anchor: "invocation-id" },
  { term: "Action Request", anchor: "action-request" },
  { term: "Enabled Hook Set", anchor: "enabled-hook-set" },
  { term: "Hook Reference", anchor: "hook-reference" },
  { term: "Hook Evaluation", anchor: "hook-evaluation" },
  { term: "Native Event", anchor: "native-event" },
  { term: "Hook Outcome", anchor: "hook-outcome" },
  { term: "Event Outcome", anchor: "event-outcome" },
  { term: "Hook Result", anchor: "hook-result" },
  { term: "Hook Catalog", anchor: "hook-catalog" },
  { term: "Catalog Entry", anchor: "catalog-entry" },
  { term: "Hook Source", anchor: "hook-source" },
  { term: "Enabled Hook", anchor: "enabled-hook" },
  { term: "Precondition", anchor: "precondition" },
  { term: "Hook", anchor: "hook" },
  { term: "Event", anchor: "event" },
  { term: "Action", anchor: "action" },
  { term: "Effect", anchor: "effect" },
  { term: "Preset", anchor: "preset" },
  { term: "Filter", anchor: "filter" },
  { term: "Section", anchor: "section" },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface BuiltPattern {
  re: RegExp;
  anchorBySurface: Map<string, string>;
}

let _built: BuiltPattern | null = null;

/** Build the combined matcher once: longest surface first, per-surface flex. */
function buildPattern(): BuiltPattern {
  if (_built) return _built;
  const surfaces: string[] = [];
  const anchorBySurface = new Map<string, string>();
  for (const { term, anchor } of GLOSSARY_TERMS) {
    anchorBySurface.set(term, anchor);
    surfaces.push(escapeRegExp(term));
    // `y` → `ies`: "Catalog Entry" surfaces as "Catalog Entries".
    if (term.endsWith("y")) {
      const plural = `${term.slice(0, -1)}ies`;
      anchorBySurface.set(plural, anchor);
      surfaces.push(escapeRegExp(plural));
    }
  }
  surfaces.sort((a, b) => b.length - a.length);
  // (?:s'?|'?s)? keeps "Hooks", "Hooks'", and "Hook's" as one link
  // label; look-arounds keep matches whole-word (lowercase fields, `pi_*`,
  // camelCase, and plural-only compounds like "Hooked" never match).
  const re = new RegExp(
    `(?<![A-Za-z0-9_])(?:(${surfaces.join("|")})(?:s'?|'?s)?)(?![A-Za-z0-9_])`,
    "g",
  );
  _built = { re, anchorBySurface };
  return _built;
}

export interface GlossarySegment {
  text: string;
  href?: string;
}

/**
 * Pure linker for one text run. Returns the run split into plain and linked
 * segments; a segment carries `href` when the glossary Term should become a
 * link. When `seen` is provided (once-per-page), a Term links only on its
 * first occurrence in that page and stays plain afterwards.
 */
export function linkifyGlossaryText(
  value: string,
  seen: Set<string> | null = null,
): GlossarySegment[] {
  if (!value) return [];
  const { re, anchorBySurface } = buildPattern();
  re.lastIndex = 0;
  const segments: GlossarySegment[] = [];
  let last = 0;
  for (const match of value.matchAll(re)) {
    const index = match.index!;
    const full = match[0];
    if (index > last) segments.push({ text: value.slice(last, index) });
    const anchor = anchorBySurface.get(match[1]);
    if (anchor && (!seen || !seen.has(anchor))) {
      seen?.add(anchor);
      segments.push({ text: full, href: `${GLOSSARY_URL}#${anchor}` });
    } else {
      segments.push({ text: full });
    }
    last = index + full.length;
  }
  if (last < value.length) segments.push({ text: value.slice(last) });
  return segments.length > 0 ? segments : [{ text: value }];
}

const SKIP_CONTAINER_TYPES = new Set([
  "link",
  "linkReference",
  "html",
  "code",
  "inlineCode",
  "heading",
]);

export interface RemarkGlossaryOptions {
  /** Link each Term only on its first occurrence per page (default `true`). */
  oncePerPage?: boolean;
}

/**
 * Remark plugin factory: `unified().use(remarkGlossaryLinks, {...})` (or
 * `[remarkGlossaryLinks, { oncePerPage: true }]` inside a PluggableList).
 * Adds glossary links to every `text` node that is not inside a link,
 * heading, code, or MDX/JSX subtree.
 */
export const remarkGlossaryLinks: Plugin<[RemarkGlossaryOptions?]> = (
  options: RemarkGlossaryOptions = {},
) => {
  const oncePerPage = options.oncePerPage ?? true;
  return (tree) => {
    const seen = oncePerPage ? new Set<string>() : null;
    transformChildren(tree, false, seen);
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformChildren(parent: any, inSkipContext: boolean, seen: Set<string> | null): void {
  if (!parent || !Array.isArray(parent.children)) return;
  const children = parent.children;
  let i = 0;
  while (i < children.length) {
    const child = children[i];
    if (!child || typeof child !== "object") {
      i++;
      continue;
    }
    const type = child.type;
    if (type === "text") {
      if (!inSkipContext) {
        const segments = linkifyGlossaryText(String(child.value ?? ""), seen);
        if (segments.length === 1 && segments[0].href) {
          children[i] = makeLink(segments[0]);
          i++;
          continue;
        }
        if (segments.length > 1) {
          children.splice(
            i,
            1,
            ...segments.map((segment) =>
              segment.href ? makeLink(segment) : makeText(segment.text),
            ),
          );
          i += segments.length;
          continue;
        }
      }
      i++;
      continue;
    }
    const childSkipContext =
      inSkipContext ||
      SKIP_CONTAINER_TYPES.has(type) ||
      (typeof type === "string" && type.startsWith("mdx"));
    transformChildren(child, childSkipContext, seen);
    i++;
  }
}

function makeLink(segment: { href: string; text: string }) {
  return {
    type: "link",
    url: segment.href,
    children: [{ type: "text", value: segment.text }],
  };
}

function makeText(value: string) {
  return { type: "text", value };
}

// ── Tooltip definitions (single-sourced from the glossary page) ──────────

export interface GlossaryDefinition {
  /** Canonical Term (heading text on the glossary page). */
  term: string;
  /** Plain-text definition paragraph, inline code/bold markers stripped. */
  definition: string;
}

const GLOSSARY_MDX_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "content",
  "docs",
  "reference",
  "glossary.mdx",
);

/**
 * Parse `## Term [#anchor]` headings and their first paragraph from the
 * glossary page source. Pure and fixture-testable: skips frontmatter and
 * `> **Avoid**:` blockquotes, joins soft-wrapped paragraph lines, and stops
 * at the next heading.
 */
export function parseGlossaryDefinitions(raw: string): Map<string, GlossaryDefinition> {
  const map = new Map<string, GlossaryDefinition>();
  let current: { anchor: string; term: string; lines: string[] } | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*\[#([a-z0-9-]+)\]\s*$/.exec(line.trim());
    if (heading) {
      if (current) flushDefinition(map, current);
      current = { anchor: heading[2], term: heading[1].trim(), lines: [] };
      continue;
    }
    if (!current) continue; // frontmatter + intro before the first heading
    if (line.trim().startsWith(">")) continue; // `> **Avoid**: ...` notes
    if (current.lines.length > 0 && line.trim() === "") continue; // trailing blank
    if (line.trim() === "") continue; // blank between heading and definition
    current.lines.push(line);
  }
  if (current) flushDefinition(map, current);
  return map;
}

function flushDefinition(
  map: Map<string, GlossaryDefinition>,
  current: { anchor: string; term: string; lines: string[] },
): void {
  const definition = current.lines
    .map((line) =>
      line
        .replace(/[`*]/g, "") // strip inline code and bold/italic markers
        .trim(),
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  map.set(current.anchor, { term: current.term, definition });
}

let _definitionsCache: ReadonlyMap<string, GlossaryDefinition> | null = null;

/**
 * Definition lookup keyed by glossary anchor, read once from the glossary
 * page. Every auto-link Term has an entry here (the drift guard in
 * `tests/glossary-link.test.ts` pins this), so tooltips can never point at
 * an unknown page anchor.
 */
export function getGlossaryDefinitions(): ReadonlyMap<string, GlossaryDefinition> {
  if (!_definitionsCache) {
    _definitionsCache = parseGlossaryDefinitions(readFileSync(GLOSSARY_MDX_PATH, "utf8"));
  }
  return _definitionsCache;
}

export interface RehypeGlossaryTooltipsOptions {
  /**
   * Anchor → definition map. Defaults to the real glossary page; inject one
   * in tests to avoid file I/O.
   */
  definitions?: ReadonlyMap<string, GlossaryDefinition> | null;
}

/**
 * Rehype transformer factory: stamps every `<a href="/reference/glossary#a">`
 * with `data-glossary`, `data-glossary-term`, and `data-glossary-def` so the
 * CSS in `global.css` can render hover/focus tooltips. The link itself keeps
 * navigating to the Reference glossary.
 */
export const rehypeGlossaryTooltips: Plugin<[RehypeGlossaryTooltipsOptions?]> = (
  options: RehypeGlossaryTooltipsOptions = {},
) => {
  const definitions = options.definitions ?? getGlossaryDefinitions();
  return (tree) => {
    visit(tree, "element", (node: HastElement) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string") return;
      const match = /^\/reference\/glossary#([a-z0-9-]+)$/.exec(href);
      if (!match) return;
      const definition = definitions.get(match[1]);
      if (!definition) return;
      node.properties.dataGlossary = match[1];
      node.properties.dataGlossaryTerm = definition.term;
      node.properties.dataGlossaryDef = definition.definition;
    });
  };
};
