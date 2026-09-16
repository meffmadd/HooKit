/**
 * Tests for `PresetEditorPanel` — the preset editor's sectioned, searchable
 * hook picker.  Behaves like the `/hooks` view (sections by source,
 * fzf-style search, Tab/Shift+Tab cross-section navigation) but with checkbox
 * semantics: `Enter` toggles membership (`✓`), `Esc` commits + goes back.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PresetEditorPanel } from "../hookit/ui/preset-editor.js";
import type { CatalogEntry } from "../hookit/hook-catalog/index.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ── Helpers ───────────────────────────────────────────────────────

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const SPACE = " ";
const TAB = "\t";

/** A theme that wraps accented text in brackets so hooks can see it. */
function mockTheme(): Theme {
  return {
    fg: (role: string, text: string) =>
      role === "accent" ? `[${text}]` : role === "success" ? `{${text}}` : text,
    bold: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function makeHook(
  name: string,
  source = "local",
  opts: { shell?: string; when?: string; description?: string } = {},
): CatalogEntry {
  return {
    name,
    source,
    description: opts.description ?? `desc-${name}`,
    event: "tool_call",
    shell: opts.shell ?? "true",
    when: opts.when,
    default: false,
    path: `/tmp/${name}.json`,
  };
}

function makeAction(name: string, source = "local"): CatalogEntry {
  return {
    name,
    source,
    description: `desc-${name}`,
    event: "tool_call",
    shell: "true",
    action: {
      type: "message",
      outcome: "pass",
      message: "Review the result",
      delivery: "followUp",
    },
    default: false,
  };
}

function makePanel(
  hooks: CatalogEntry[],
  selected: Set<string> = new Set(),
  opts: { name?: string; description?: string } = {},
): PresetEditorPanel {
  const panel = new PresetEditorPanel(
    hooks,
    opts.name ?? "my-preset",
    opts.description ?? "A preset.",
    selected,
  );
  panel.setTheme(mockTheme());
  return panel;
}

/** Strip the mock theme's `[]` accent and `{}` success wrappers. */
function plain(s: string): string {
  return s.replace(/[\[\]{}]/g, "");
}

/** The focused row (starts with the accent-wrapped `> `). */
function focusedLine(lines: string[]): string | undefined {
  return lines.find((l) => plain(l).startsWith("> "));
}

// ═══════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel rendering", () => {
  it("groups Hooks by source (local first, then repos alpha)", () => {
    const panel = makePanel([
      makeHook("zeta", "owner/repo"),
      makeHook("alpha", "local"),
      makeHook("beta", "owner/repo"),
    ]);
    const lines = panel.render(80);
    // Section headers may carry `Tab`/`Shift+Tab` jump-key hints after the
    // label (2-space separator); split them off to get the bare source.
    const sources = lines
      .map((l) => plain(l).trim().split(/\s{2,}/)[0])
      .filter((s) => s === "Local" || s === "owner/repo");
    // Local section first, then the repo.
    assert.deepEqual(sources, ["Local", "owner/repo"]);
  });

  it("renders a ✓ badge for selected (member) hooks and a space for others", () => {
    const panel = makePanel(
      [makeHook("alpha"), makeHook("beta")],
      new Set(["local/alpha"]),
    );
    const lines = panel.render(80);
    const alphaLine = lines.find((l) => plain(l).includes("alpha"))!;
    const betaLine = lines.find((l) => plain(l).includes("beta"))!;
    assert.ok(plain(alphaLine).includes("✓"), "alpha (member) has ✓");
    assert.ok(!plain(betaLine).includes("✓"), "beta (non-member) has no ✓");
  });

  it("shows the preset name + description in the header", () => {
    const panel = makePanel([makeHook("a")], new Set(), {
      name: "my-preset",
      description: "Guards writes.",
    });
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => plain(l).includes("Edit preset") && plain(l).includes("my-preset")),
      "header shows title + name",
    );
    assert.ok(
      lines.some((l) => plain(l).includes("Guards writes.")),
      "header shows description",
    );
  });

  it("renders shell/when detail under the focused row", () => {
    const panel = makePanel([makeHook("a", "local", { shell: "git status", when: "true" })]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => plain(l).includes("shell: git status")),
      "detail shows shell",
    );
    assert.ok(
      lines.some((l) => plain(l).includes("when: true")),
      "detail shows when",
    );
  });

  it("renders Hooks with owned Actions as selectable", () => {
    const panel = makePanel([makeAction("notify")]);
    const lines = panel.render(100);
    assert.ok(lines.some((line) => plain(line).includes("notify")));
    assert.ok(
      lines.some((line) => plain(line).includes("type: message")),
      "detail identifies the owned Action",
    );
  });

  it("shows 'No Hooks to select' when empty", () => {
    const panel = makePanel([]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => plain(l).includes("No Hooks to select")),
      "empty state message",
    );
  });

  it("excludes Presets while retaining all Hooks", () => {
    const preset = {
      name: "other-preset",
      source: "local",
      description: "d",
      preset: ["local/guard"],
      default: false,
      path: "/tmp/p.json",
    } as unknown as CatalogEntry;
    const shell = makeHook("guard");
    const action = makeAction("notify");
    const panel = makePanel([shell, action, preset]);
    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => plain(l).includes("other-preset")),
      "preset is not in the picker",
    );
    assert.ok(
      lines.some((l) => plain(l).includes("guard")),
      "shell Hook is in the picker",
    );
    assert.ok(
      lines.some((l) => plain(l).includes("notify")),
      "Hook with an Action is in the picker",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Enter toggle
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel Enter toggle", () => {
  it("Enter adds the focused hook to the selection", () => {
    const panel = makePanel([makeHook("alpha")]);
    assert.deepEqual(panel.value, []);
    panel.handleInput(ENTER);
    assert.deepEqual(panel.value, ["local/alpha"]);
  });

  it("Enter removes an already-selected focused hook", () => {
    const panel = makePanel([makeHook("alpha")], new Set(["local/alpha"]));
    assert.deepEqual(panel.value, ["local/alpha"]);
    panel.handleInput(ENTER);
    assert.deepEqual(panel.value, []);
  });

  it("Enter toggles without committing (returns undefined)", () => {
    const panel = makePanel([makeHook("alpha")]);
    const result = panel.handleInput(ENTER);
    assert.strictEqual(result, undefined);
  });

  it("Space is a no-op in normal mode (not a toggle)", () => {
    const panel = makePanel([makeHook("alpha")]);
    panel.handleInput(SPACE);
    assert.deepEqual(panel.value, [], "Space did not toggle");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Esc commit
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel commit", () => {
  it("Esc commits the current selection in item order", () => {
    const panel = makePanel(
      [makeHook("a"), makeHook("b"), makeHook("c")],
      new Set(),
    );
    // Toggle a (focused first), then down to b and toggle b.
    panel.handleInput(ENTER); // a
    panel.handleInput(DOWN);
    panel.handleInput(ENTER); // b
    const result = panel.handleInput(ESC); // Esc commits + back
    assert.deepEqual(result, { value: ["local/a", "local/b"] });
  });

  it("Esc commits the working selection (not cancel)", () => {
    const panel = makePanel([makeHook("a")], new Set(["local/a"]));
    const result = panel.handleInput(ESC);
    assert.deepEqual(result, { value: ["local/a"] });
  });

  it("Esc exits query editing without locking or committing", () => {
    const panel = makePanel([makeHook("alpha"), makeHook("beta")]);
    panel.handleInput("/");
    panel.handleInput("alp");
    assert.ok(panel.isSearchActive, "search entered");
    const result = panel.handleInput(ESC);
    assert.strictEqual(result, undefined, "Esc exits search, no result");
    assert.ok(!panel.isSearchActive, "search exited instead of being locked");
    assert.ok(panel.render(80).some((line) => plain(line).includes("beta")), "full picker restored");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel search", () => {
  it("/ enters search, Enter locks the filter, and Esc exits", () => {
    const panel = makePanel([makeHook("alpha"), makeHook("beta"), makeHook("gamma")]);
    panel.handleInput("/");
    assert.ok(panel.isSearchActive);
    panel.handleInput("alp"); // matches alpha's name only (not "local" source)
    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("alpha")), "alpha matches");
    assert.ok(!lines.some((l) => plain(l).includes("beta")), "beta filtered out");
    assert.ok(!lines.some((l) => plain(l).includes("gamma")), "gamma filtered out");
    panel.handleInput(ENTER); // lock search → filtered work mode
    assert.ok(panel.isSearchActive, "result set retained in filtered work mode");
    panel.handleInput(ESC); // exit
    assert.ok(!panel.isSearchActive);
  });

  it("Enter locks search mode without toggling the focused match", () => {
    const panel = makePanel([makeHook("alpha"), makeHook("beta")]);
    panel.handleInput("/");
    panel.handleInput("al"); // matches alpha
    panel.handleInput(ENTER); // lock — not append or toggle
    assert.deepEqual(panel.value, [], "locking search did not toggle the focused match");
    assert.ok(panel.render(80).some((line) => /^  \/al/.test(line) && !line.includes("▏")));
  });

  it("Enter toggles only after the search is locked (and does not commit)", () => {
    const panel = makePanel([makeHook("alpha"), makeHook("beta")]);
    panel.handleInput("/");
    panel.handleInput("al");
    assert.strictEqual(panel.handleInput(ENTER), undefined, "first Enter locks search");
    const result = panel.handleInput(ENTER);
    assert.strictEqual(result, undefined, "second Enter toggles, but does not commit");
    assert.deepEqual(panel.value, ["local/alpha"], "toggled the locked focused match");
  });

  it("Space feeds the query in search mode (not a toggle)", () => {
    const panel = makePanel([makeHook("alpha")]);
    panel.handleInput("/");
    panel.handleInput("al"); // matches alpha
    panel.handleInput(SPACE); // Space is a query char, not a toggle
    const lines = panel.render(80);
    // The /query line shows the space appended (mock theme wraps accent in []).
    const queryLine = lines.find((l) => plain(l).includes("/al "));
    assert.ok(queryLine, "Space appended to the query (shown in the /query line)");
    assert.deepEqual(panel.value, [], "Space did not toggle");
  });

  it("shows 'No matches' when the query matches nothing", () => {
    const panel = makePanel([makeHook("alpha")]);
    panel.handleInput("/");
    panel.handleInput("z");
    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("No matches")));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Filtered work mode — the shared three-state search lifecycle. Enter locks
// the current filter; `/` resumes the retained query; Esc clears search
// WITHOUT committing (undefined); a further Esc from normal mode saves and
// returns.
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel filtered work mode", () => {
  /** Editing `/query▏` line (accent + cursor). */
  const editingQuery = (lines: string[]) =>
    lines.find((l) => l.includes("▏") && l.includes("/"));
  /** Dim cursorless `/query` line in filtered work mode. */
  const filteredQuery = (lines: string[]) =>
    lines.find((l) => /^  \//.test(l) && !l.includes("▏"));

  it("Enter enters filtered work mode and retains rows, focus, and query", () => {
    const panel = makePanel([makeHook("alpha"), makeHook("beta"), makeHook("gamma")]);
    panel.handleInput("/");
    panel.handleInput("alp");
    const result = panel.handleInput(ENTER); // lock filter

    assert.strictEqual(result, undefined, "filtered work mode does not commit or toggle");
    assert.ok(panel.isSearchActive, "search stays active in filtered work mode");
    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("alpha")), "match stays");
    assert.ok(!plain(lines.join("\n")).includes("beta"), "query still filters");
    assert.equal(panel.nav.focusedItem?.name, "alpha", "focused match retained");
    const q = filteredQuery(lines);
    assert.ok(q && plain(q).includes("/alp"), "dim cursorless retained query");
    assert.ok(lines.some((l) => plain(l).includes("clear search")), "footer shows clear search");
  });

  it("filtered footer advertises / search + clear search; Enter add/remove stays contextual", () => {
    const panel = makePanel([makeHook("alpha")]);
    panel.handleInput("/");
    panel.handleInput("alp");
    panel.handleInput(ENTER); // filtered
    const footer = plain(panel.render(80).find((l) => l.includes("clear search")) ?? "");
    assert.equal(footer, "  / search · Esc clear search");
    const action = panel.render(80).find((l) => plain(l).includes("Enter add"))!;
    assert.ok(plain(action).includes("›"), "focused-row membership action stays");
  });

  it("navigation and Enter add/remove work in filtered work mode", () => {
    const panel = makePanel([makeHook("no-env"), makeHook("env-thing")]);
    panel.handleInput("/");
    for (const ch of "env") panel.handleInput(ch);
    panel.handleInput(ENTER); // filtered work mode

    assert.equal(panel.nav.focusedItem?.name, "no-env");
    panel.handleInput(ENTER);
    assert.deepEqual(panel.value, ["local/no-env"], "Enter adds the focused match");
    panel.handleInput(DOWN);
    assert.equal(panel.nav.focusedItem?.name, "env-thing", "arrow navigation works on matches");
    panel.handleInput(ENTER);
    assert.deepEqual(
      panel.value,
      ["local/no-env", "local/env-thing"],
      "Enter adds the second match",
    );
  });

  it("unrelated printable input leaves the retained query unchanged", () => {
    const panel = makePanel([makeHook("alpha")]);
    panel.handleInput("/");
    panel.handleInput("al");
    panel.handleInput(ENTER); // filtered
    panel.handleInput("x"); // must not append to the query
    const q = filteredQuery(panel.render(80));
    assert.ok(q && plain(q).includes("/al"), "query unchanged by non-/ printable input");
  });

  it("`/` resumes the exact retained query (editing cursor and exit-search footer)", () => {
    const panel = makePanel([makeHook("no-env"), makeHook("write-guard")]);
    panel.handleInput("/");
    for (const ch of "no env") panel.handleInput(ch); // literal space in the query
    panel.handleInput(ENTER); // filtered

    panel.handleInput("/"); // resume
    let q = editingQuery(panel.render(80));
    assert.ok(q && plain(q).includes("/no env"), "exact retained query including the space");
    assert.ok(panel.render(80).some((l) => l.includes("exit search")), "editing footer returns");
    panel.handleInput("x");
    q = editingQuery(panel.render(80));
    assert.ok(q && plain(q).includes("/no envx"), "new chars append on resume");
  });

  it("Esc clears a locked search without committing; the next Esc commits", () => {
    const panel = makePanel([makeHook("alpha"), makeHook("beta")]);
    panel.handleInput("/");
    panel.handleInput("al");
    panel.handleInput(ENTER); // lock filter
    panel.handleInput(ENTER); // add alpha from filtered work mode
    assert.ok(panel.isSearchActive);

    const cleared = panel.handleInput(ESC);
    assert.strictEqual(cleared, undefined, "clearing search does NOT commit");
    assert.ok(!panel.isSearchActive, "search cleared");

    const committed = panel.handleInput(ESC); // normal-mode cancel
    assert.deepEqual(committed, { value: ["local/alpha"] }, "normal-mode Esc saves and returns");
  });

  it("Esc with an empty query exits search immediately", () => {
    const panel = makePanel([makeHook("alpha")]);
    panel.handleInput("/");
    const result = panel.handleInput(ESC);
    assert.strictEqual(result, undefined, "empty-query cancel does not commit");
    assert.ok(!panel.isSearchActive, "exits search immediately");
  });

  it("clearing search restores the full picker, then normal Esc saves", () => {
    const panel = makePanel([makeHook("no-env"), makeHook("env-thing")]);
    panel.handleInput("/");
    for (const ch of "env") panel.handleInput(ch);
    panel.handleInput(ENTER); // filtered (both match)
    assert.ok(!panel.render(80).some((l) => plain(l).includes("No matches")));
    panel.nav.moveWithin("down");
    panel.handleInput(ENTER); // toggle env-thing
    panel.handleInput(ESC); // clear search (no commit)
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => plain(l).includes("no-env")) &&
        lines.some((l) => plain(l).includes("env-thing")),
      "full picker restored after clearing",
    );
    const result = panel.handleInput(ESC); // normal commit
    assert.deepEqual(result, { value: ["local/env-thing"] });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel navigation", () => {
  it("down moves focus within a section", () => {
    const panel = makePanel([makeHook("a"), makeHook("b"), makeHook("c")]);
    panel.handleInput(DOWN);
    const lines = panel.render(80);
    const focused = focusedLine(lines);
    assert.ok(focused && plain(focused).includes("b"), "focus moved to b");
  });

  it("down at a section boundary crosses to the next section", () => {
    const panel = makePanel([
      makeHook("a", "local"),
      makeHook("b", "owner/repo"),
    ]);
    panel.handleInput(DOWN); // a is last in local → cross to b in owner/repo
    const lines = panel.render(80);
    const focused = focusedLine(lines);
    assert.ok(focused && plain(focused).includes("b"), "crossed to next section");
  });

  it("Tab cycles to the next section", () => {
    const panel = makePanel([
      makeHook("a", "local"),
      makeHook("b", "owner/repo"),
    ]);
    panel.handleInput(TAB); // Tab → next section
    const lines = panel.render(80);
    const focused = focusedLine(lines);
    assert.ok(focused && plain(focused).includes("b"), "Tab moved to next section");
  });

  it("section headers show Tab/Shift+Tab jump-key hints (shared with /hooks)", () => {
    const panel = makePanel([
      makeHook("a", "local"),
      makeHook("b", "owner/repo"),
    ]);
    // Focused on Local (index 0): the next section (owner/repo) shows `Tab`.
    let lines = panel.render(80);
    const repoHeader = lines.find((l) => plain(l).trim().startsWith("owner/repo"))!;
    assert.ok(repoHeader, "owner/repo header renders");
    assert.ok(
      plain(repoHeader).includes("Tab"),
      "next-section header shows the Tab jump-key hint",
    );
    // Tab to owner/repo: the previous section (Local) now shows `Shift+Tab`.
    panel.handleInput(TAB);
    lines = panel.render(80);
    const localHeader = lines.find((l) => plain(l).trim().startsWith("Local"))!;
    assert.ok(localHeader, "Local header renders");
    assert.ok(
      plain(localHeader).includes("Shift+Tab"),
      "prev-section header shows the Shift+Tab jump-key hint",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Hint line
// ═══════════════════════════════════════════════════════════════════

describe("PresetEditorPanel hints", () => {
  it("renders focused membership action separately from the panel footer", () => {
    const panel = makePanel([makeHook("a")]);
    const lines = panel.render(80);
    const action = lines.find((l) => plain(l).includes("Enter add"))!;
    const footer = lines.find((l) => plain(l).includes("save & back"))!;
    assert.ok(action && plain(action).includes("›"), "focused row advertises Enter add");
    assert.ok(plain(footer).startsWith("  / search"), "footer starts with search");
    assert.ok(plain(footer).includes("Esc save & back"), "footer advertises save & back");
    assert.ok(!plain(footer).includes("Enter"), "footer omits focused-row toggling");
  });

  it("predicts Enter remove for an existing member and updates after toggling", () => {
    const panel = makePanel([makeHook("a")], new Set(["local/a"]));
    let action = panel.render(80).find((l) => plain(l).includes("Enter remove"));
    assert.ok(action, "existing membership predicts removal");
    panel.handleInput(ENTER);
    action = panel.render(80).find((l) => plain(l).includes("Enter add"));
    assert.ok(action, "action updates after removal");
  });

  it("hides membership actions while editing and advertises locking search", () => {
    const panel = makePanel([makeHook("alpha")]);
    panel.handleInput("/");
    panel.handleInput("a");
    const lines = panel.render(80);
    assert.ok(!lines.some((l) => plain(l).includes("› Enter add")));
    const footer = plain(lines.find((l) => plain(l).includes("lock search")) ?? "");
    assert.equal(footer, "  Enter lock search · Esc exit search");
  });

  it("keeps the focused row, contextual action, and framed footer in a constrained viewport", () => {
    const lines = makePanel([makeHook("a")]).render(60, 9);
    assert.ok(lines.some((l) => plain(l).startsWith("> ") && plain(l).includes("a")));
    assert.ok(lines.some((l) => plain(l).includes("› Enter add")));
    assert.match(lines.at(-3) ?? "", /^─+$/);
    assert.ok(plain(lines.at(-2) ?? "").includes("save & back"));
    assert.match(lines.at(-1) ?? "", /^─+$/);
  });
});
