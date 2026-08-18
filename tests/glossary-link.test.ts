/**
 * Tests for the glossary auto-linking seam (`site/src/glossary-link.ts`).
 *
 * Two seams are pinned here, mirroring the repo's "single source of truth"
 * rule:
 *
 * 1. The pure matcher `linkifyGlossaryText` (case-sensitive longest-match
 *    over `GLOSSARY_TERMS`, whole-word boundaries, plural/possessive flexes,
 *    once-per-page `seen`).
 * 2. The remark transformer shape: links plain `text` nodes only — never
 *    inside existing links, headings, or code — without nesting anchors, and
 *    every `GLOSSARY_TERMS` entry is declared as a `## Term [#anchor]`
 *    heading on the glossary page (so the page can never drift from the
 *    link list).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GLOSSARY_TERMS,
  getGlossaryDefinitions,
  linkifyGlossaryText,
  parseGlossaryDefinitions,
  rehypeGlossaryTooltips,
  remarkGlossaryLinks,
} from "../site/src/glossary-link.js";
import type { GlossarySegment } from "../site/src/glossary-link.js";

const here = dirname(fileURLToPath(import.meta.url));
const glossaryMdx = readFileSync(
  join(here, "..", "site", "content", "docs", "reference", "glossary.mdx"),
  "utf-8",
);

// ── Term-list integrity ───────────────────────────────────────────

describe("GLOSSARY_TERMS integrity", () => {
  it("declares each Term once with a unique non-empty anchor", () => {
    const anchors = new Set<string>();
    for (const { term, anchor } of GLOSSARY_TERMS) {
      assert.ok(term.length > 0, `empty term in ${JSON.stringify({ term, anchor })}`);
      assert.match(anchor, /^[a-z0-9-]+$/, `anchor ${anchor} should be a slug`);
      assert.ok(!anchors.has(anchor), `duplicate anchor ${anchor}`);
      anchors.add(anchor);
    }
  });

  it("keeps the product names out of auto-linking", () => {
    const linked = new Set(GLOSSARY_TERMS.map((t) => t.term));
    assert.ok(!linked.has("HooKit"), "HooKit brand name should not auto-link");
    assert.ok(!linked.has("Pi"), "Pi brand name should not auto-link");
  });
});

// ── Pure matcher unit tests ───────────────────────────────────────

function hrefsOf(segments: GlossarySegment[]): { text: string; href?: string }[] {
  return segments.map(({ text, href }) => (href ? { text, href } : { text }));
}

describe("linkifyGlossaryText", () => {
  it("links a bare capitalized Term", () => {
    assert.deepEqual(hrefsOf(linkifyGlossaryText("A Hook end.")), [
      { text: "A " },
      { text: "Hook", href: "/reference/glossary#hook" },
      { text: " end." },
    ]);
  });

  it("does not link lowercase or mid-word matches", () => {
    assert.equal(linkifyGlossaryText("run a hook, reeHook, Hook_result").length, 1);
    assert.equal(linkifyGlossaryText("Preconditionally, Hooked").length, 1);
  });

  it("links plural and possessive flexes as one label", () => {
    assert.deepEqual(
      hrefsOf(linkifyGlossaryText("Hooks Events' Action's")),
      [
        { text: "Hooks", href: "/reference/glossary#hook" },
        { text: " " },
        { text: "Events'", href: "/reference/glossary#event" },
        { text: " " },
        { text: "Action's", href: "/reference/glossary#action" },
      ],
    );
  });

  it("maps `y` words to their `ies` plurals", () => {
    assert.deepEqual(hrefsOf(linkifyGlossaryText("Catalog Entries, Core Catalog Entries")), [
      { text: "Catalog Entries", href: "/reference/glossary#catalog-entry" },
      { text: ", " },
      { text: "Core Catalog Entries", href: "/reference/glossary#core-catalog-entry" },
    ]);
  });

  it("matches the longest phrase first (Hook Result Event > Hook Result > Hook)", () => {
    assert.deepEqual(
      hrefsOf(linkifyGlossaryText("Hook Result Event Hook Result Hook")),
      [
        { text: "Hook Result Event", href: "/reference/glossary#hook-result-event" },
        { text: " " },
        { text: "Hook Result", href: "/reference/glossary#hook-result" },
        { text: " " },
        { text: "Hook", href: "/reference/glossary#hook" },
      ],
    );
  });

  it("does not split outside word boundaries (Event Outcome vs Event)", () => {
    assert.deepEqual(hrefsOf(linkifyGlossaryText("Event Outcome vs Event")), [
      { text: "Event Outcome", href: "/reference/glossary#event-outcome" },
      { text: " vs " },
      { text: "Event", href: "/reference/glossary#event" },
    ]);
  });

  it("links once per anchor when a `seen` set is supplied", () => {
    const seen = new Set<string>();
    const segments = linkifyGlossaryText("a Hook, a Hook, an Event", seen);
    assert.deepEqual(
      segments.filter((s) => s.href).map(({ text, href }) => ({ text, href })),
      [
        { text: "Hook", href: "/reference/glossary#hook" },
        { text: "Event", href: "/reference/glossary#event" },
      ],
    );
    assert.equal(segments.filter((s) => s.href).length, 2);
    assert.equal(
      segments.filter((s) => !s.href).map((s) => s.text).join(""),
      "a , a Hook, an ",
    );
    assert.deepEqual(seen, new Set(["hook", "event"]));
  });

  it("links repeatedly when `oncePerPage` is not applied", () => {
    const segments = linkifyGlossaryText("a Hook, a Hook", null);
    assert.equal(segments.filter((s) => s.href === "/reference/glossary#hook").length, 2);
  });
});

// ── Remark AST transform tests ────────────────────────────────────

function transform(body: unknown, oncePerPage = true) {
  const tree = { type: "root", children: [body] };
  const transformer = remarkGlossaryLinks({ oncePerPage });
  transformer(tree as never);
  return (tree.children as unknown[])[0];
}

describe("remarkGlossaryLinks transformer", () => {
  it("wraps a Term in a link node without nesting", () => {
    const out = transform({
      type: "paragraph",
      children: [
        { type: "text", value: "A Hook blocks the tool." },
      ],
    }) as { children: unknown[] };
    assert.equal(out.children.length, 3);
    assert.equal((out.children[0] as { type: string }).type, "text");
    assert.equal((out.children[0] as { value: string }).value, "A ");
    assert.deepEqual(
      (out.children[1] as { type: string; url: string }).type,
      "link",
    );
    assert.equal(
      (out.children[1] as { url: string }).url,
      "/reference/glossary#hook",
    );
    assert.equal((out.children[2] as { value: string }).value, " blocks the tool.");
  });

  it("links inside strong/emphasis but not inside existing links", () => {
    const out = transform({
      type: "paragraph",
      children: [
        { type: "text", value: "See " },
        {
          type: "link",
          url: "/concepts/evaluation",
          children: [{ type: "text", value: "Hook Evaluation" }],
        },
        { type: "text", value: " and the " },
        { type: "strong", children: [{ type: "text", value: "Enabled Hook Set" }] },
        { type: "text", value: "." },
      ],
    }) as { children: unknown[] };
    const kind = (n: unknown) => (n as { type: string }).type;
    const childTypes = out.children.map(kind);
    assert.deepEqual(childTypes, [
      "text", "link", "text", "strong", "text",
    ]);
    // Existing link keeps its plain text child (no nested anchor).
    const existing = out.children[1] as { children: unknown[] };
    assert.equal(existing.children.length, 1);
    const strong = out.children[3] as { children: unknown[] };
    assert.equal(kind(strong.children[0]), "link");
  });

  it("leaves headings and code untouched", () => {
    const out = transform({
      type: "root",
      children: [
        { type: "heading", children: [{ type: "text", value: "Hook Evaluation" }] },
        {
          type: "paragraph",
          children: [{ type: "inlineCode", value: "hook_result" }, { type: "text", value: " stays plain" }],
        },
      ],
    }) as { children: unknown[] };
    const heading = out.children[0] as { children: unknown[] };
    assert.deepEqual((heading.children[0] as { type: string }).type, "text");
    const paragraph = out.children[1] as { children: unknown[] };
    assert.deepEqual(
      paragraph.children.map((c) => (c as { type: string }).type),
      ["inlineCode", "text"],
    );
  });

  it("links once per page by default and repeatedly with oncePerPage:false", () => {
    const once = transform({
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "First Hook." }] },
        { type: "paragraph", children: [{ type: "text", value: "Second Hook." }] },
      ],
    }) as { children: { children: { type: string }[] }[] };
    const onceLinks = once.children.flatMap((p) =>
      p.children.filter((c) => c.type === "link"),
    );
    assert.equal(onceLinks.length, 1);

    const all = transform(
      {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "text", value: "First Hook." }] },
          { type: "paragraph", children: [{ type: "text", value: "Second Hook." }] },
        ],
      },
      false,
    ) as { children: { children: { type: string }[] }[] };
    const allLinks = all.children.flatMap((p) =>
      p.children.filter((c) => c.type === "link"),
    );
    assert.equal(allLinks.length, 2);
  });
});

// ── Glossary page drift guard ─────────────────────────────────────

describe("glossary.mdx stays in sync with GLOSSARY_TERMS", () => {
  it("declares `## Term [#anchor]` for every auto-linked Term", () => {
    const headingById = new Map<string, string>();
    for (const line of glossaryMdx.split("\n")) {
      const match = /^##\s+(.+?)\s*\[#([a-z0-9-]+)\]\s*$/.exec(line.trim());
      if (match) headingById.set(match[2], match[1]);
    }
    for (const { term, anchor } of GLOSSARY_TERMS) {
      assert.equal(
        headingById.get(anchor),
        term,
        `glossary.mdx should declare \`## ${term} [#${anchor}]\` for the auto-link`,
      );
    }
  });

  it("declares no stray custom anchors outside the auto-linked Terms", () => {
    // `report` Outcome is documented on the page but is a lowercase `report`
    // code in prose, so it is deliberately not in the auto-link list.
    const known = new Set(GLOSSARY_TERMS.map((t) => t.anchor));
    known.add("report-outcome");
    for (const match of glossaryMdx.matchAll(/^##\s+.*?\[#([a-z0-9-]+)\]\s*$/gm)) {
      assert.ok(
        known.has(match[1]),
        `glossary.mdx anchor #${match[1]} is not in GLOSSARY_TERMS`,
      );
    }
  });
});

// ── Tooltip definitions ───────────────────────────────────────────

describe("parseGlossaryDefinitions", () => {
  it("maps each heading to its Term and first paragraph", () => {
    const raw = [
      "---",
      "title: Glossary",
      "---",
      "",
      "Intro paragraph.",
      "",
      "## Hook [#hook]",
      "",
      "A Catalog Entry that subscribes to an `event` and contains a shell,",
      "an owned Action, or both.",
      "> **Avoid**: Assertion",
      "",
      "## Event Outcome [#event-outcome]",
      "",
      "The complete **aggregated** decision for the Event.",
    ].join("\n");
    const map = parseGlossaryDefinitions(raw);
    assert.deepEqual([...map.keys()], ["hook", "event-outcome"]);
    assert.equal(map.get("hook")?.term, "Hook");
    assert.equal(
      map.get("hook")?.definition,
      "A Catalog Entry that subscribes to an event and contains a shell, an owned Action, or both.",
    );
    assert.equal(
      map.get("event-outcome")?.definition,
      "The complete aggregated decision for the Event.",
    );
  });

  it("keeps the `report` Outcome term (stripped backticks) for its heading", () => {
    const map = parseGlossaryDefinitions("## `report` Outcome [#report-outcome]\n\nFeedback stays an Effect.\n");
    assert.equal(map.get("report-outcome")?.term, "`report` Outcome");
  });
});

describe("getGlossaryDefinitions covers the auto-link list", () => {
  it("provides a non-empty definition for every GLOSSARY_TERMS anchor", () => {
    const definitions = getGlossaryDefinitions();
    for (const { term, anchor } of GLOSSARY_TERMS) {
      const entry = definitions.get(anchor);
      assert.ok(entry, `no tooltip definition for ${term} (#${anchor})`);
      assert.equal(entry.term, term);
      assert.ok(
        entry.definition.length > 0,
        `empty definition for ${term} (#${anchor})`,
      );
    }
  });
});

// ── Rehype tooltip stamping ───────────────────────────────────────

describe("rehypeGlossaryTooltips", () => {
  function props(tree: { children: { tagName: string; properties: Record<string, unknown> }[] }) {
    const out: Record<string, string>[] = [];
    tree.children.forEach((el) =>
      out.push({
        tag: el.tagName,
        href: String(el.properties.href ?? ""),
        anchor: String(el.properties.dataGlossary ?? ""),
        term: String(el.properties.dataGlossaryTerm ?? ""),
        def: String(el.properties.dataGlossaryDef ?? ""),
      }),
    );
    return out;
  }

  it("stamps data-glossary attributes on glossary links only", () => {
    const definitions = new Map([
      ["hook", { term: "Hook", definition: "A Catalog Entry that runs a decision shell." }],
    ]);
    const tree = {
      type: "root",
      children: [
        { type: "element", tagName: "a", properties: { href: "/reference/glossary#hook" } },
        { type: "element", tagName: "a", properties: { href: "/concepts/evaluation" } },
        { type: "element", tagName: "a", properties: { href: "/reference/glossary#unknown-anchor" } },
      ],
    } as never;
    rehypeGlossaryTooltips({ definitions })(tree);
    assert.deepEqual(props(tree as never), [
      { tag: "a", href: "/reference/glossary#hook", anchor: "hook", term: "Hook", def: "A Catalog Entry that runs a decision shell." },
      { tag: "a", href: "/concepts/evaluation", anchor: "", term: "", def: "" },
      { tag: "a", href: "/reference/glossary#unknown-anchor", anchor: "", term: "", def: "" },
    ]);
  });
});
