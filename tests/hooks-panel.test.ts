/**
 * Tests for HooksPanel rendering / keyboard navigation.
 */

import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  HooksPanel,
  registerHooksCommand,
} from "../hookit/ui/hooks.js";
import { HooksState } from "../hookit/ui/state.js";
import type { CatalogEntry } from "../hookit/hook-catalog/index.js";
import { clearRepoEntriesCache } from "../hookit/installer.js";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

// ── Helpers ───────────────────────────────────────────────────────

/** A theme that wraps accented text in brackets so hooks can see it. */
function mockTheme(): Theme {
  return {
    fg: (role: string, text: string) =>
      role === "accent" ? `[${text}]` : text,
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function makeHook(
  name: string,
  source = "local",
  isDefault = false,
  opts: { shell?: string; when?: string } = {},
): CatalogEntry {
  return {
    name,
    source,
    description: "d",
    event: "tool_call",
    shell: opts.shell ?? "true",
    when: opts.when,
    default: isDefault,
  };
}

function makePanel(
  entries: CatalogEntry[],
  enabledEntries: Set<string> = new Set(),
): HooksPanel {
  const state = {
    entries,
    enabledEntries,
    isEnabledDirectly(entry: CatalogEntry) {
      return enabledEntries.has(entry.name) ||
        enabledEntries.has(`${entry.source}\x00${entry.name}`);
    },
    enable(entry: CatalogEntry) { enabledEntries.add(entry.name); },
    disable(entry: CatalogEntry) { enabledEntries.delete(entry.name); },
    disableAll() { enabledEntries.clear(); },
    persist() {},
    updateStatus() {},
  } as unknown as HooksState;

  const panel = new HooksPanel(state);
  panel.setTheme(mockTheme());
  return panel;
}

/** A preset referencing `refs` (qualified `source/name` refs). */
function makePreset(
  name: string,
  refs: string[],
  source = "local",
  isDefault = false,
): CatalogEntry {
  return {
    name,
    source,
    description: "d",
    preset: refs,
    default: isDefault,
  };
}

/** Minimal ExtensionContext mock for handleInput tests. */
function makeCtx(): ExtensionContext {
  return {
    ui: {
      notify() {},
      theme: mockTheme(),
      setStatus() {},
    },
  } as unknown as ExtensionContext;
}

/** Extract the currently highlighted hook row. */
function focusedLine(lines: string[]): string | undefined {
  return lines.find((line) => line.startsWith("[> "));
}

/** Strip the mock theme's `[]` accent wrappers so substring checks survive per-char highlighting. */
function plain(s: string): string {
  return s.replace(/[\[\]]/g, "");
}

/**
 * Find the rendered row for `name` (not a detail line like `hooks:`/`shell:`).
 * A row carries an enabled/disabled status; a detail line
 * (e.g. the preset's `hooks: local/guard`) does not.  Needed since M3: the
 * Presets section renders first, so a preset's `hooks:` detail mentioning a
 * member name can appear before the member's own row.
 */
function rowFor(lines: string[], name: string): string | undefined {
  return lines.find((l) => {
    const p = plain(l);
    return p.includes(name) && /enabled|disabled/.test(p);
  });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("HooksPanel", () => {
  it("highlights the first item initially", () => {
    const panel = makePanel([
      makeHook("alpha"),
      makeHook("beta"),
      makeHook("gamma"),
    ]);

    const lines = panel.render(80);
    const highlighted = focusedLine(lines);

    assert.equal(highlighted, "[> ][alpha]  disabled");
  });

  it("moves the highlight down on arrow down", () => {
    const panel = makePanel([
      makeHook("alpha"),
      makeHook("beta"),
      makeHook("gamma"),
    ]);

    // Move down
    panel.nav.moveWithin("down");

    const lines = panel.render(80);
    const highlighted = focusedLine(lines);

    assert.equal(highlighted, "[> ][beta ]  disabled");
    assert.ok(
      lines.some((line) => line.includes("alpha") && !line.startsWith("[> ][alpha]")),
      "previous item should no longer be highlighted",
    );
  });

  it("moves the highlight up on arrow up", () => {
    const panel = makePanel([
      makeHook("alpha"),
      makeHook("beta"),
      makeHook("gamma"),
    ]);

    panel.nav.moveWithin("down");
    panel.nav.moveWithin("down");
    panel.nav.moveWithin("up");

    const lines = panel.render(80);
    const highlighted = focusedLine(lines);

    assert.equal(highlighted, "[> ][beta ]  disabled");
  });

  it("aligns values when default tag makes labels uneven", () => {
    const panel = makePanel([
      makeHook("short"),
      makeHook("longname", "local", true),
    ]);

    const lines = panel.render(80);
    const highlighted = focusedLine(lines);

    assert.equal(highlighted, "[> ][short             ]  disabled");
  });

  it("windows a long active section when terminal height is constrained", () => {
    const panel = makePanel(
      Array.from({ length: 8 }, (_, i) => makeHook(`a-${i}`)),
    );

    // The framed footer and focused-row action are both reserved by viewport
    // accounting; height 16 leaves room for a three-row active window.
    const lines = panel.render(80, 16);
    const activeHeader = lines.find((l) => l.includes("[Local]"));

    assert.ok(activeHeader, "active section header is shown");
    assert.equal(
      lines.filter((l) => l.includes("a-")).length,
      3,
      "shows a windowed view of the hooks",
    );
    assert.ok(
      lines.some((l) => l.includes("a-0")),
      "selected hook stays visible",
    );
    assert.ok(
      !lines.some((l) => l.includes("a-7")),
      "hooks outside the window are hidden",
    );
    assert.ok(
      lines.some((l) => l.includes("(1/8)")),
      "shows scroll indicator",
    );
  });

  it("centers the active window around the selected hook", () => {
    const panel = makePanel(
      Array.from({ length: 8 }, (_, i) => makeHook(`a-${i}`)),
    );

    // Move selection to the 7th Hook (index 6)
    for (let i = 0; i < 6; i++) panel.nav.moveWithin("down");

    const lines = panel.render(80, 12);
    assert.ok(
      lines.some((l) => l.includes("a-6")),
      "selected hook a-6 is visible",
    );
    assert.ok(
      !lines.some((l) => l.includes("a-0")),
      "top hooks are scrolled out",
    );
    assert.ok(
      lines.some((l) => l.includes("(7/8)")),
      "scroll indicator follows selection",
    );
  });

  it("always shows inactive section headers around the active anchor", () => {
    const panel = makePanel([
      makeHook("above-1", "repo/aaa"),
      makeHook("active-1", "repo/mid"),
      makeHook("active-2", "repo/mid"),
      makeHook("below-1", "repo/zzz"),
    ]);

    // Move focus from the first section down to the middle section.
    panel.nav.cross("down");

    const lines = panel.render(80, 17);

    assert.ok(
      lines.some((l) => l.includes("repo/aaa")),
      "shows header of section above",
    );
    assert.ok(
      lines.some((l) => l.includes("active-1")),
      "shows active section hooks",
    );
    assert.ok(
      lines.some((l) => l.includes("repo/zzz")),
      "shows header of section below",
    );
    assert.ok(
      !lines.some((l) => l.includes("above-1")),
      "does not render hooks of inactive sections",
    );
    assert.ok(
      !lines.some((l) => l.includes("below-1")),
      "does not render hooks of inactive sections",
    );
  });

  it("renders inactive section headers but not their hooks", () => {
    const panel = makePanel([
      ...Array.from({ length: 2 }, (_, i) => makeHook(`active-${i}`)),
      ...Array.from({ length: 5 }, (_, i) => makeHook(`below-${i}`, "repo/below")),
    ]);

    const lines = panel.render(80, 14);

    assert.ok(
      lines.some((l) => l.includes("active-0")),
      "shows active section hooks",
    );
    assert.ok(
      lines.some((l) => l.includes("repo/below")),
      "shows inactive section header",
    );
    assert.ok(
      !lines.some((l) => l.includes("below-0")),
      "does not render hooks of inactive sections",
    );
  });

  it("shows adjacent section headers even when vertical space is tight", () => {
    const panel = makePanel([
      makeHook("above-1", "repo/aaa"),
      ...Array.from({ length: 10 }, (_, i) => makeHook(`active-${i}`, "repo/mid")),
      makeHook("below-1", "repo/zzz"),
    ]);

    panel.nav.cross("down");

    const lines = panel.render(80, 12);

    assert.ok(
      lines.some((l) => l.includes("repo/aaa")),
      "shows header of section above even when tight",
    );
    assert.ok(
      lines.some((l) => l.includes("repo/zzz")),
      "shows header of section below even when tight",
    );
    assert.ok(
      lines.some((l) => l.includes("active-0")),
      "shows at least one Hook in the focused section",
    );
    assert.ok(
      lines.some((l) => l.includes("(1/10)")),
      "shows scroll indicator because active section is windowed",
    );
  });

  it("always renders the Hooks header as the first line", () => {
    const panel = makePanel(
      Array.from({ length: 8 }, (_, i) => makeHook(`a-${i}`)),
    );

    for (const h of [5, 8, 10, 12, 15, 20, undefined]) {
      const lines = panel.render(80, h);
      assert.ok(
        lines[0]?.includes("Hooks"),
        `first line should be header for terminalHeight=${String(h)}`,
      );
    }
  });

  it("renders the selected hook's shell command in the detail panel", () => {
    const panel = makePanel([
      makeHook("alpha", "local", false, { shell: "echo hello" }),
      makeHook("beta"),
    ]);

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("shell:") && l.includes("echo hello")),
      "shows the shell command for the highlighted hook",
    );
  });

  it("renders the when precondition when present", () => {
    const panel = makePanel([
      makeHook("alpha", "local", false, {
        shell: "echo hello",
        when: "test -f ./flag",
      }),
    ]);

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("when:") && l.includes("test -f ./flag")),
      "shows the when precondition",
    );
  });

  it("omits the when line when the hook has no when precondition", () => {
    const panel = makePanel([
      makeHook("alpha", "local", false, { shell: "echo hello" }),
    ]);

    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("when:")),
      "does not show a when line when absent",
    );
  });

  it("wraps long shell commands in the detail panel", () => {
    const longShell =
      "echo one two three four five six seven eight nine ten eleven twelve";
    const panel = makePanel([
      makeHook("alpha", "local", false, { shell: longShell }),
    ]);

    const lines = panel.render(40);
    assert.ok(
      lines.some((l) => l.includes("shell:") && l.includes("echo")),
      "first detail line shows the shell label",
    );
    assert.ok(
      lines.some((l) => !l.includes("shell:") && l.includes("twelve")),
      "wrapped continuation line appears",
    );
  });

  it("updates the detail panel when the selection moves", () => {
    const panel = makePanel([
      makeHook("alpha", "local", false, { shell: "echo alpha" }),
      makeHook("beta", "local", false, { shell: "echo beta" }),
    ]);

    let lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("echo alpha")),
      "initial detail shows alpha's shell",
    );
    assert.ok(
      !lines.some((l) => l.includes("echo beta")),
      "beta's shell is not shown yet",
    );

    panel.nav.moveWithin("down");
    lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("echo beta")),
      "detail updates to beta's shell after moving down",
    );
  });

  // ── Hint line ───────────────────────────────────────────────────

  it("shows the d disable-all action when entries are enabled", () => {
    const panel = makePanel([makeHook("alpha")], new Set(["alpha"]));
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("[d] disable all")),
      "shows disable all when an entry is enabled",
    );
  });

  it("hides the d disable-all action when nothing is enabled", () => {
    const panel = makePanel([makeHook("alpha")]);
    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("disable all")),
      "hides disable all when nothing is enabled",
    );
  });

  it("binds the focused-row remove action to r (not d)", () => {
    const panel = makePanel([makeHook("alpha", "repo/owner")]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("[›]") && l.includes("[r] remove")),
      "remove is bound to r in the contextual action line",
    );
    assert.ok(
      !lines.some((l) => l.includes("[d] remove")),
      "remove is not bound to d",
    );
  });

  // ── d / r keybindings ───────────────────────────────────────────

  it("d clears directly enabled entries and persists", () => {
    const active = new Set(["alpha", "beta"]);
    let persisted = false;
    let statusUpdated = false;
    const state = {
      entries: [makeHook("alpha"), makeHook("beta")],
      enabledEntries: active,
      disableAll() { active.clear(); },
      persist() { persisted = true; },
      updateStatus() { statusUpdated = true; },
    } as unknown as HooksState;

    const panel = new HooksPanel(state);
    panel.setTheme(mockTheme());

    panel.handleInput("d", makeCtx());

    assert.equal(active.size, 0, "direct enablement is cleared");
    assert.ok(persisted, "persist is called");
    assert.ok(statusUpdated, "status bar is refreshed");
  });

  it("d is a no-op when nothing is enabled directly", () => {
    let persisted = false;
    const state = {
      entries: [makeHook("alpha")],
      enabledEntries: new Set<string>(),
      disableAll() { /* should not run */ },
      persist() { persisted = true; },
      updateStatus() { },
    } as unknown as HooksState;

    const panel = new HooksPanel(state);
    panel.setTheme(mockTheme());

    panel.handleInput("d", makeCtx());

    assert.ok(!persisted, "must not persist an already-empty enabled set");
  });

  it("r opens the remove confirm for a non-local hook", () => {
    const panel = makePanel([makeHook("alpha", "repo/owner")]);
    panel.handleInput("r", makeCtx());

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes(`Remove "alpha"?`)),
      "r opens the remove confirm dialog",
    );
  });

  it("r opens the remove confirm for a local hook too", () => {
    const panel = makePanel([makeHook("alpha")]);
    panel.handleInput("r", makeCtx());

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes(`Remove "alpha"?`)),
      "r opens the remove confirm for local hooks (no notify gate)",
    );
  });

  it("shows the contextual remove action for a local section", () => {
    const panel = makePanel([makeHook("alpha")]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("[›]") && l.includes("[r] remove")),
      "the remove action appears for local entries too",
    );
  });

  it("remove confirm shows a y/n keybinding hint", () => {
    const panel = makePanel([makeHook("alpha", "repo/owner")]);
    panel.handleInput("r", makeCtx());

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => /y.*confirm/.test(l) && /n.*cancel/.test(l)),
      "confirm renders the y/n hint (matches the install flow)",
    );
  });

  it("renders predictive focused-row actions in the required order", () => {
    const panel = makePanel([makeHook("alpha")]);
    const action = plain(panel.render(100).find((l) => l.includes("[›]")) ?? "");
    assert.match(
      action,
      /› Enter enable · t set default · r remove/,
      "disabled, non-default entry advertises its next transitions",
    );

    const enabledDefault = makePanel(
      [makeHook("alpha", "local", true)],
      new Set(["alpha"]),
    );
    const next = plain(enabledDefault.render(100).find((l) => l.includes("[›]")) ?? "");
    assert.match(next, /› Enter disable · t unset default · r remove/);
  });

  it("Enter toggles direct enablement even when a Preset covers the entry", () => {
    const panel = makePanel(
      [makeHook("guard"), makePreset("safety", ["local/guard"])],
      new Set(["safety"]),
    );
    panel.nav.cycleSection("next"); // Presets → Local (guard)
    const action = plain(panel.render(100).find((l) => l.includes("[›]")) ?? "");
    assert.ok(action.includes("Enter enable"), "next Enter individually enables guard");
    assert.ok(!action.includes("Enter disable"), "preset coverage does not redefine the toggle");
  });

  it("places contextual actions after warning and hook detail lines", () => {
    const panel = makePanel([
      makeHook("alpha", "local", false, { shell: "echo alpha", when: "true" }),
    ]);
    const lines = panel.render(100);
    const shell = lines.findIndex((l) => l.includes("shell:"));
    const when = lines.findIndex((l) => l.includes("when:"));
    const action = lines.findIndex((l) => l.includes("[›]"));
    const topBorder = lines.findIndex((l) => /^─+$/.test(l));
    assert.ok(shell >= 0 && when > shell && action > when, "action follows shell/when details");
    assert.ok(topBorder > action, "action is the final focused-row detail before the footer");
  });

  it("keeps only panel-wide commands in the normal footer, in order", () => {
    const panel = makePanel([makeHook("alpha")], new Set(["alpha"]));
    const footer = plain(panel.render(120).find((l) => l.includes("close")) ?? "");
    assert.match(
      footer,
      /^  \/ search · d disable all · i install hooks · n new preset · Esc close$/,
    );
    assert.ok(!footer.includes("Enter"), "focused-row toggle is not global");
    assert.ok(!footer.includes(" t ") && !footer.includes(" r ") && !footer.includes(" e "));
  });

  it("renders and accepts customized select bindings", () => {
    const active = new Set<string>();
    const panel = makePanel([makeHook("alpha")], active);
    panel.setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.confirm": "space",
      "tui.select.cancel": "ctrl+x",
    }));

    let lines = panel.render(100);
    assert.ok(lines.some((l) => l.includes("[Space] enable")));
    assert.ok(lines.some((l) => l.includes("[Ctrl-X] close")));
    panel.handleInput(" ", makeCtx());
    assert.ok(active.has("alpha"), "custom confirm key toggles the focused entry");
    lines = panel.render(100);
    assert.ok(lines.some((l) => l.includes("[Space] disable")));
    assert.equal(panel.handleInput("\x18", makeCtx()), "cancel", "custom cancel key closes");
  });

  // Structural guard: `render` is the single emission point that frames the
  // persistent footer in every mode.
  it("every render mode ends with a framed hint", () => {
    const panel = makePanel([
      makeHook("alpha", "repo/owner"),
      makeHook("beta", "repo/owner"),
    ]);
    const assertFramed = (lines: string[], label: string): void => {
      assert.match(lines.at(-1) ?? "", /^─+$/, `${label}: bottom border`);
      assert.match(lines.at(-3) ?? "", /^─+$/, `${label}: top border`);
      assert.ok((lines.at(-2) ?? "").trim(), `${label}: hint between borders`);
    };

    assertFramed(makePanel([]).render(80, 20), "empty");
    assertFramed(panel.render(80, 20), "bounded normal");
    assertFramed(panel.render(80), "unbounded normal");
    panel.handleInput("r", makeCtx());
    assertFramed(panel.render(80, 20), "confirm");
  });

  it("renders both footer rules full-width with the borderMuted theme role", () => {
    const roles: string[] = [];
    const theme = {
      fg(role: string, text: string) { roles.push(role); return text; },
      bg: (_role: string, text: string) => text,
      bold: (text: string) => text,
      underline: (text: string) => text,
      strikethrough: (text: string) => text,
    } as unknown as Theme;
    const panel = makePanel([makeHook("alpha")]);
    panel.setTheme(theme);
    const borders = panel.render(37).filter((l) => /^─+$/.test(l));
    assert.equal(borders.length, 2);
    assert.ok(borders.every((line) => line.length === 37), "rules span the panel width");
    assert.ok(roles.filter((role) => role === "borderMuted").length >= 2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Section cycling — Tab / Shift+Tab jump focus between sections
// ═══════════════════════════════════════════════════════════════════

describe("HooksPanel section cycling (Tab/Shift+Tab)", () => {
  it("cycleSection next wraps last→first across three sections", () => {
    const panel = makePanel([
      makeHook("local-1"),
      makeHook("aaa-1", "repo/aaa"),
      makeHook("zzz-1", "repo/zzz"),
    ]);
    // Sections: Presets(0, empty), local(1), repo/aaa(2), repo/zzz(3).
    // Initial focus is local(1) (first non-empty). local → repo/aaa → repo/zzz → Presets (wrap).
    panel.nav.cycleSection("next");
    assert.equal(panel.nav.focusedSection, 2);
    panel.nav.cycleSection("next");
    assert.equal(panel.nav.focusedSection, 3);
    panel.nav.cycleSection("next");
    assert.equal(panel.nav.focusedSection, 0, "wraps last→first");
  });

  it("cycleSection prev wraps first→last", () => {
    const panel = makePanel([
      makeHook("local-1"),
      makeHook("aaa-1", "repo/aaa"),
      makeHook("zzz-1", "repo/zzz"),
    ]);
    // Start on Presets (the first section, index 0) to test prev-wrap to last.
    panel.nav.focus = 0;
    panel.nav.cycleSection("prev");
    assert.equal(panel.nav.focusedSection, 3, "wraps first→last"); // repo/zzz
    panel.nav.cycleSection("prev");
    assert.equal(panel.nav.focusedSection, 2); // repo/aaa
  });

  it("cycleSection preserves each section's remembered row", () => {
    const panel = makePanel([
      makeHook("local-1"),
      makeHook("local-2"),
      makeHook("aaa-1", "repo/aaa"),
      makeHook("aaa-2", "repo/aaa"),
      makeHook("aaa-3", "repo/aaa"),
    ]);
    // Walk down two rows in the local section.
    panel.nav.moveWithin("down");
    panel.nav.moveWithin("down");
    assert.equal(panel.nav.focusedIndex, 1, "local section at row 1");

    // Tab to repo/aaa (fresh section, remembers its own row 0), then back.
    panel.nav.cycleSection("next");
    assert.equal(panel.nav.focusedSection, 2);
    assert.equal(panel.nav.focusedIndex, 0, "repo section starts at its row 0");
    panel.nav.cycleSection("prev");
    assert.equal(panel.nav.focusedSection, 1);
    assert.equal(panel.nav.focusedIndex, 1, "local row restored after round-trip");
  });

  it("cycleSection is a no-op with a single section", () => {
    // A preset-only panel has exactly one section (Presets); shell-only
    // panels always have Presets + local (two) since M3 hoisted presets.
    const panel = makePanel([makePreset("only-preset", [])]);
    const moved = panel.nav.cycleSection("next");
    assert.equal(moved, false);
    assert.equal(panel.nav.focusedSection, 0, "focus unchanged");
  });

  it("Tab key moves focus to the next section", () => {
    const panel = makePanel([
      makeHook("local-1"),
      makeHook("aaa-1", "repo/aaa"),
      makeHook("zzz-1", "repo/zzz"),
    ]);
    panel.handleInput("\t", makeCtx());
    assert.equal(panel.nav.focusedSection, 2, "Tab advances to next section");
  });

  it("Shift+Tab (\x1b[Z) moves focus to the previous section", () => {
    const panel = makePanel([
      makeHook("local-1"),
      makeHook("aaa-1", "repo/aaa"),
      makeHook("zzz-1", "repo/zzz"),
    ]);
    // Move to the middle section first.
    panel.nav.cycleSection("next");
    assert.equal(panel.nav.focusedSection, 2);
    // Shift+Tab via its real escape sequence.
    panel.handleInput("\x1b[Z", makeCtx());
    assert.equal(panel.nav.focusedSection, 1, "Shift+Tab returns to previous section");
  });

  it("Tab is a no-op with a single section", () => {
    // Preset-only → one section (Presets); Tab is a no-op.
    const panel = makePanel([makePreset("only-preset", [])]);
    panel.handleInput("\t", makeCtx());
    assert.equal(panel.nav.focusedSection, 0, "focus stays on the only section");
  });

  it("Tab is ignored while a remove confirm is open", () => {
    const panel = makePanel([
      makeHook("local-1"),
      makeHook("aaa-1", "repo/aaa"),
    ]);
    // Open the remove confirm on the focused local Hook.
    panel.handleInput("r", makeCtx());
    const focusBefore = panel.nav.focusedSection;
    panel.handleInput("\t", makeCtx());
    assert.equal(
      panel.nav.focusedSection,
      focusBefore,
      "Tab does not move focus during confirm",
    );
    // Confirm is still open (Tab didn't dismiss it).
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes(`Remove "local-1"?`)),
      "confirm dialog remains open after Tab",
    );
  });

  it("shows the Tab cycle hint only with more than one section", () => {
    const multi = makePanel([
      makeHook("local-1"),
      makeHook("aaa-1", "repo/aaa"),
    ]);
    const multiHint = multi.render(80, 20).find((l) => l.includes("Tab"));
    assert.ok(multiHint, "Tab hint shown with multiple sections");

    const single = makePanel([makePreset("only-preset", [])]);
    const singleHint = single.render(80, 20).find((l) => l.includes("Tab"));
    assert.ok(!singleHint, "Tab hint hidden with a single section");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Orphaned detection — installed hooks removed from their source repo
// ═══════════════════════════════════════════════════════════════════

/** Mock fetch helpers (mirroring install.test.ts conventions). */
function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mockFileItem(path: string, content: unknown): unknown {
  const json = JSON.stringify(content);
  const b64 = Buffer.from(json).toString("base64");
  return {
    name: path.split("/").pop(),
    path,
    sha: "abc123",
    size: json.length,
    type: "file",
    content: b64,
    encoding: "base64",
  };
}

function mockTreeBlob(path: string): unknown {
  return { path, mode: "100644", type: "blob", sha: "abc123", size: 100 };
}

/**
 * Mock `fetch` so the trees call returns the given blob paths, and each
 * contents call returns the given file contents (single file).
 */
function mockRepoFetch(blobPaths: string[], fileContent: unknown): void {
  mock.method(globalThis, "fetch", (url: string) => {
    if (url.includes("/git/trees/")) {
      return mockJsonResponse({
        sha: "tree-sha",
        url,
        tree: blobPaths.map(mockTreeBlob),
        truncated: false,
      });
    }
    // contents call
    return mockJsonResponse(mockFileItem(blobPaths[0]!, fileContent));
  });
}

describe("HooksPanel orphaned detection", () => {
  // Each test gets a fresh fetchRepoEntries cache.
  before(() => clearRepoEntriesCache());
  after(() => clearRepoEntriesCache());

  it("marks orphaned hooks with ⚠ after the fetch settles", async () => {
    clearRepoEntriesCache();
    mockRepoFetch(["hooks/defaults.json"], {
      "hook-a": { description: "A.", event: "tool_call", shell: "true" },
      "hook-b": { description: "B.", event: "tool_call", shell: "false" },
    });

    // "hook-c" is installed but NOT in the repo → orphaned.
    const panel = makePanel([
      makeHook("hook-a", "some/repo"),
      makeHook("hook-c", "some/repo"),
    ]);

    let rendered = false;
    panel.setRequestRender(() => { rendered = true; });
    panel.startOrphanCheck();

    // Before the fetch settles, no ⚠ badges.
    let lines = panel.render(80);
    const hookC = lines.find((l) => l.includes("hook-c"));
    assert.ok(hookC, "hook-c row exists before fetch");
    assert.ok(!hookC!.includes("⚠"), "no ⚠ before fetch settles");

    // Let the async fetch settle.
    await new Promise((r) => setImmediate(r));

    lines = panel.render(80);
    const orphanLine = lines.find((l) => l.includes("hook-c"));
    const keptLine = lines.find((l) => l.includes("hook-a"));
    assert.ok(orphanLine?.includes("⚠"), "orphaned Hook gets ⚠ badge");
    assert.ok(!keptLine?.includes("⚠"), "non-orphaned Hook has no ⚠");
    assert.ok(rendered, "requestRender was called when fetch settled");
  });

  it("does not mark local hooks as orphaned (no fetch)", async () => {
    clearRepoEntriesCache();
    let fetchCalled = false;
    mock.method(globalThis, "fetch", () => { fetchCalled = true; return mockJsonResponse({}); });

    const panel = makePanel([makeHook("local-hook", "local")]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();

    await new Promise((r) => setImmediate(r));
    assert.ok(!fetchCalled, "no fetch for local-only hooks");

    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("⚠")),
      "local hooks never get ⚠",
    );
  });

  it("skips the check entirely when the config is broken", async () => {
    clearRepoEntriesCache();
    let fetchCalled = false;
    mock.method(globalThis, "fetch", () => { fetchCalled = true; return mockJsonResponse({}); });

    const state = {
      entries: [makeHook("hook-a", "some/repo")],
      enabledEntries: new Set<string>(),
      broken: true,
    } as unknown as HooksState;

    const panel = new HooksPanel(state);
    panel.setTheme(mockTheme());
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();

    await new Promise((r) => setImmediate(r));
    assert.ok(!fetchCalled, "no fetch when config is broken");
  });

  it("degrades silently on network failure (no ⚠, no throw)", async () => {
    clearRepoEntriesCache();
    mock.method(globalThis, "fetch", () => {
      throw new Error("connect ECONNREFUSED");
    });

    const panel = makePanel([makeHook("hook-a", "some/repo")]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();

    await new Promise((r) => setImmediate(r));

    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("⚠")),
      "no ⚠ badges when fetch fails",
    );
  });

  it("aligns orphaned and non-orphaned rows (status column)", async () => {
    clearRepoEntriesCache();
    mockRepoFetch(["hooks/defaults.json"], {
      "kept": { description: "K.", event: "tool_call", shell: "true" },
    });

    // "kept" is in the repo; "orphan" is not.
    const panel = makePanel([
      makeHook("kept", "some/repo"),
      makeHook("orphan", "some/repo"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    const lines = panel.render(80);
    const keptLine = lines.find((l) => l.includes("kept"))!;
    const orphanLine = lines.find((l) => l.includes("orphan"))!;

    // Strip the mock theme's `[]` accent wrappers and the `> `/`  ` prefix
    // so the comparison is on the row body only (the selected row has extra
    // `[]` chars that shift `indexOf`).
    const strip = (s: string) => s.replace(/[\[\]]/g, "").replace(/^[> ]{2}/, "");
    const keptBody = strip(keptLine);
    const orphanBody = strip(orphanLine);

    // Both rows should have "disabled" at the same column — the ⚠ badge
    // width is reserved so the status column stays aligned.
    const keptStatusCol = keptBody.indexOf("disabled");
    const orphanStatusCol = orphanBody.indexOf("disabled");
    assert.ok(keptStatusCol > 0 && orphanStatusCol > 0, "both show status");
    assert.strictEqual(
      keptStatusCol,
      orphanStatusCol,
      "status columns align despite the ⚠ badge",
    );
  });

  it("r remove still works on an orphaned hook", async () => {
    clearRepoEntriesCache();
    mockRepoFetch(["hooks/defaults.json"], {
      "kept": { description: "K.", event: "tool_call", shell: "true" },
    });

    const panel = makePanel([
      makeHook("kept", "some/repo"),
      makeHook("orphan", "some/repo"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    // Move down to the orphaned hook and press r.
    panel.nav.moveWithin("down");
    panel.handleInput("r", makeCtx());

    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes(`Remove "orphan"?`)),
      "r opens the remove confirm for the orphaned hook",
    );
  });

  it("does NOT badge a local hook that shares a name with an orphaned repo hook", async () => {
    clearRepoEntriesCache();
    // Repo has "shared-name" but NOT "orphan-only".
    mockRepoFetch(["hooks/defaults.json"], {
      "shared-name": { description: "S.", event: "tool_call", shell: "true" },
    });

    // A local hook and a repo hook both named "shared-name"; plus a repo
    // hook "orphan-only" that IS orphaned.  The local "shared-name" must
    // never get ⚠, and the repo "shared-name" (exists upstream) must not
    // either — only "orphan-only" is badged.
    const panel = makePanel([
      makeHook("shared-name", "local"),
      makeHook("shared-name", "some/repo"),
      makeHook("orphan-only", "some/repo"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    const lines = panel.render(80);

    // The repo "orphan-only" hook IS orphaned → ⚠.
    const orphanLine = lines.find((l) => l.includes("orphan-only"));
    assert.ok(orphanLine?.includes("⚠"), "repo orphan gets ⚠");

    // Neither "shared-name" row (local nor repo) should be badged — the local
    // one is local (never orphaned), the repo one exists upstream.
    const sharedLines = lines.filter((l) => l.includes("shared-name"));
    assert.strictEqual(sharedLines.length, 2, "both shared-name rows rendered");
    for (const l of sharedLines) {
      assert.ok(!l.includes("⚠"), "shared-name row is not badged");
    }
  });

  it("does NOT badge a repo-A hook sharing a name with an orphaned repo-B hook", async () => {
    clearRepoEntriesCache();
    // repo-a has "dup"; repo-b does NOT (so repo-b's "dup" is orphaned).
    mock.method(globalThis, "fetch", (url: string) => {
      const isRepoA = url.includes("/repos/owner/repo-a");
      if (url.includes("/git/trees/")) {
        return mockJsonResponse({
          tree: [mockTreeBlob("hooks/defaults.json")],
          truncated: false,
        });
      }
      const content = isRepoA
        ? { "dup": { description: "A.", event: "tool_call", shell: "true" } }
        : { "other": { description: "B.", event: "tool_call", shell: "true" } };
      return mockJsonResponse(mockFileItem("hooks/defaults.json", content));
    });

    // "dup" exists in repo-a but NOT in repo-b → repo-b's "dup" is orphaned.
    // repo-a's "dup" must NOT be badged.
    const panel = makePanel([
      makeHook("dup", "owner/repo-a"),
      makeHook("dup", "owner/repo-b"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    const lines = panel.render(80);
    const dupLines = lines.filter((l) => l.includes("dup"));
    assert.strictEqual(dupLines.length, 2, "both dup rows rendered");
    // Exactly one should be badged (repo-b's), the other not (repo-a's).
    // Without the composite source+name key, BOTH would be badged (both share
    // the name "dup", which is in the orphaned set via repo-b).
    const badged = dupLines.filter((l) => l.includes("⚠"));
    assert.strictEqual(badged.length, 1, "only one dup is orphaned");
  });

  it("shows a contextual 'removed from source repo' line under a focused orphaned hook", async () => {
    clearRepoEntriesCache();
    mockRepoFetch(["hooks/defaults.json"], {
      "kept": { description: "K.", event: "tool_call", shell: "true" },
    });

    const panel = makePanel([
      makeHook("kept", "some/repo"),
      makeHook("orphan", "some/repo"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    // Focus the orphaned Hook (index 1 in the repo section).
    panel.nav.moveWithin("down");

    const lines = panel.render(80);
    const orphanIdx = lines.findIndex((l) => l.includes("orphan"));
    assert.ok(orphanIdx >= 0, "orphan row exists");

    // The line directly under the orphaned hook should be the contextual
    // warning — NOT just the shell/when detail.
    const detailLine = lines[orphanIdx + 1];
    assert.ok(
      detailLine?.includes("removed from source repo"),
      "contextual warning appears under the focused orphaned hook",
    );
    assert.ok(
      detailLine?.includes("press r to uninstall"),
      "warning tells the user how to act on it",
    );
  });

  it("does NOT show the 'removed from source repo' line under a non-orphaned hook", async () => {
    clearRepoEntriesCache();
    mockRepoFetch(["hooks/defaults.json"], {
      "kept": { description: "K.", event: "tool_call", shell: "true" },
    });

    const panel = makePanel([makeHook("kept", "some/repo")]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    const lines = panel.render(80);
    const keptIdx = lines.findIndex((l) => l.includes("kept"));
    assert.ok(keptIdx >= 0, "kept row exists");

    // The line under a non-orphaned hook should be the shell detail, NOT
    // the orphaned warning.
    const detailLine = lines[keptIdx + 1];
    assert.ok(
      detailLine?.includes("shell:"),
      "non-orphaned hook shows shell detail",
    );
    assert.ok(
      !lines.some((l) => l.includes("removed from source repo")),
      "no orphaned warning anywhere for a non-orphaned hook",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// Fuzzy search mode (/ to search, Esc to exit)
// ═══════════════════════════════════════════════════════════════════

describe("HooksPanel fuzzy search", () => {
  // The mock theme wraps accent text in [], so the query line renders as
  // "  [/query▏]" (accent) and a block cursor ▏.
  const queryLine = (lines: string[]) =>
    lines.find((l) => l.includes("▏") && l.includes("/"));

  it("`/` enters search mode and renders the query line", () => {
    const panel = makePanel([makeHook("alpha"), makeHook("beta")]);
    panel.handleInput("/", makeCtx());

    assert.ok(panel.isSearchActive, "search is active after /");
    const lines = panel.render(80);
    assert.ok(queryLine(lines), "renders the /query▏ line");
  });

  it("registers /hooks with enable/disable language", () => {
    const state = {
      entries: [],
      enabledEntries: new Set<string>(),
      broken: false,
      projectTrusted: false,
      refresh() {},
      updateStatus() {},
    } as unknown as HooksState;
    let description: string | undefined;
    const pi = {
      registerCommand(_name: string, command: { description: string }) {
        description = command.description;
      },
    } as unknown as ExtensionAPI;

    registerHooksCommand(pi, state);

    assert.equal(description, "Enable / disable Hooks and Presets");
  });

  it("keeps the bottom search hint visible inside the /hooks overlay", async () => {
    const state = {
      entries: Array.from({ length: 8 }, (_, i) => makeHook(`a-${i}`)),
      enabledEntries: new Set<string>(),
      broken: false,
      projectTrusted: false,
      refresh() {},
      updateStatus() {},
      isEnabledDirectly() { return false; },
      enable() {},
      disable() {},
      disableAll() {},
      persist() {},
    } as unknown as HooksState;

    let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    } as unknown as ExtensionAPI;

    registerHooksCommand(pi, state);
    assert.ok(handler, "registers the /hooks command");

    const rows = 24;
    const ctx = {
      cwd: "/tmp",
      isProjectTrusted: () => false,
      ui: {
        theme: mockTheme(),
        notify() {},
        setStatus() {},
        custom: async (
          factory: (
            tui: { terminal: { rows: number }; requestRender(): void },
            theme: Theme,
            keybindings: object,
            done: () => void,
          ) => { handleInput(data: string): void; render(width: number): string[] },
          options: {
            overlayOptions: { maxHeight: number | string; margin: number };
          },
        ) => {
          const component = factory(
            { terminal: { rows }, requestRender() {} },
            mockTheme(),
            {},
            () => {},
          );
          component.handleInput("/");
          const { maxHeight, margin } = options.overlayOptions;
          const requestedHeight = typeof maxHeight === "number"
            ? maxHeight
            : Math.floor(rows * Number.parseFloat(maxHeight) / 100);
          const overlayMaxHeight = Math.min(requestedHeight, rows - margin * 2);
          const visible = component.render(80).slice(0, overlayMaxHeight);
          assert.ok(
            visible.some((line: string) => line.includes("exit search")),
            "the overlay viewport retains the search hint",
          );
          const lastVisible = [...visible].reverse().find((line: string) => line.trim());
          assert.match(
            lastVisible?.trim() ?? "",
            /^─+$/,
            "the bottom footer border remains visible after the hint",
          );
          return null;
        },
      },
    } as unknown as ExtensionContext;

    await handler!("", ctx);
  });

  it("typing filters within sections and hides empty sections", () => {
    const panel = makePanel([
      makeHook("write-guard"),
      makeHook("no-env"),
      makeHook("read-only", "repo/aaa"),
    ]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("e", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("v", makeCtx());

    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("no-env")),
      "no-env matches 'env'");
    assert.ok(!lines.some((l) => l.includes("write-guard")),
      "write-guard is filtered out");
    assert.ok(!lines.some((l) => l.includes("repo/aaa")),
      "empty section (read-only didn't match) is hidden entirely");
  });

  it("Down moves within the filtered section and crosses to the next non-empty", () => {
    const panel = makePanel([
      makeHook("alpha-env"),
      makeHook("beta-env"),
      makeHook("gamma-thing", "repo/aaa"),
    ]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("e", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("v", makeCtx());
    // Local: alpha-env, beta-env; repo/aaa: gamma-thing also matches 'env'?
    // gamma-thing has no 'e','n','v' subsequence → excluded. So only local.

    // Start at alpha-env (row 0). Down → beta-env.
    panel.handleInput("\x1b[B", makeCtx()); // down
    assert.equal(panel.nav.focusedIndex, 1, "moved within the filtered local section");
  });

  it("Enter toggles the focused match", () => {
    const active = new Set<string>();
    const panel = makePanel(
      [makeHook("no-env"), makeHook("write-guard")],
      active,
    );

    panel.handleInput("/", makeCtx());
    panel.handleInput("e", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("v", makeCtx());
    panel.handleInput("\r", makeCtx()); // Enter toggles no-env

    assert.ok(active.has("no-env"), "Enter toggles the focused match on");
  });

  it("Space appends to the query (and ignores it for matching in v1a)", () => {
    const panel = makePanel([makeHook("no-env"), makeHook("write-guard")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("o", makeCtx());
    panel.handleInput(" ", makeCtx());   // space → query char
    panel.handleInput("e", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("v", makeCtx());

    // query is "no env" → strip → "noenv" which is a subsequence of "no-env".
    assert.ok(panel.isSearchActive, "still in search (Space didn't toggle)");
    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("no-env")),
      "'no env' matches 'no-env' (spaces ignored for matching)");
    // query line should show the literal spaces.
    const q = queryLine(lines);
    assert.ok(q && q.includes("no env"), "query line displays the space");
  });

  it("Tab cycles between non-empty filtered sections", () => {
    const panel = makePanel([
      makeHook("local-env"),
      makeHook("repo-env", "repo/aaa"),
    ]);
    panel.handleInput("/", makeCtx());
    for (const ch of "env") panel.handleInput(ch, makeCtx());

    assert.equal(panel.nav.focusedSection, 0, "starts on local");
    panel.handleInput("\t", makeCtx());
    assert.equal(panel.nav.focusedSection, 1, "Tab cycles to repo/aaa");
  });

  it("Esc exits search WITHOUT closing the panel (returns undefined)", () => {
    const panel = makePanel([makeHook("no-env"), makeHook("write-guard")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("e", makeCtx());
    const result = panel.handleInput("\x1b", makeCtx()); // Esc
    assert.equal(result, undefined, "Esc during search does NOT cancel the panel");
    assert.ok(!panel.isSearchActive, "search mode is exited");
  });

  it("Esc restores focus to the highlighted match in the unfiltered view", () => {
    const panel = makePanel([
      makeHook("alpha"),
      makeHook("no-env"),
      makeHook("write-guard", "repo/aaa"),
    ]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("e", makeCtx());
    panel.handleInput("n", makeCtx());
    panel.handleInput("v", makeCtx());
    // Only "no-env" matches; it's the sole row in the filtered local section.
    assert.equal(panel.nav.focusedSection, 0);
    assert.equal(panel.nav.focusedIndex, 0);

    panel.handleInput("\x1b", makeCtx()); // Esc → exit
    assert.ok(!panel.isSearchActive);
    assert.equal(panel.nav.focusedSection, 1, "back on the local section");
    assert.equal(panel.nav.focusedIndex, 1, "focus restored to no-env's row in the unfiltered view");
  });

  it("empty results render 'No matches' (not 'No hooks defined!')", () => {
    const panel = makePanel([makeHook("alpha"), makeHook("beta")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("z", makeCtx());
    panel.handleInput("z", makeCtx());
    panel.handleInput("z", makeCtx());

    const lines = panel.render(80);
    assert.ok(lines.some((l) => l.includes("No matches")),
      "zero-match query shows 'No matches'");
    assert.ok(!lines.some((l) => l.includes("No hooks defined")),
      "never shows the empty-panel copy during search");
  });

  it("Backspace restores the list after widening back from no matches", () => {
    const panel = makePanel([makeHook("alpha")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("z", makeCtx());
    assert.ok(panel.render(80).some((l) => l.includes("No matches")));
    panel.handleInput("\x7f", makeCtx()); // backspace → query ""
    const lines = panel.render(80);
    assert.ok(lines.some((l) => l.includes("alpha")),
      "back to empty query shows the list again");
  });

  it("focus is preserved when the focused hook still matches", () => {
    const panel = makePanel([makeHook("write-guard"), makeHook("no-env")]);
    panel.handleInput("/", makeCtx());
    // Move to no-env first.
    panel.handleInput("\x1b[B", makeCtx()); // down → no-env
    assert.equal(panel.nav.focusedItem?.name, "no-env");
    // Type 'e' — both still match (filtering may reorder within the section,
    // but focus must stay on no-env, not yank to write-guard).
    panel.handleInput("e", makeCtx());
    assert.equal(panel.nav.focusedItem?.name, "no-env",
      "focus stays on no-env, not reset to write-guard");
  });

  it("focus drops out to the same section's first match when the focused hook is filtered out", () => {
    const panel = makePanel([makeHook("write-guard"), makeHook("no-env")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("\x1b[B", makeCtx()); // down → no-env (index 1)
    assert.equal(panel.nav.focusedIndex, 1);
    // Type 'w' → only write-guard matches; no-env drops out.
    panel.handleInput("w", makeCtx());
    assert.equal(panel.nav.focusedSection, 0,
      "still in the local section (same source)");
    assert.equal(panel.nav.focusedIndex, 0,
      "focus fell back to the first remaining match, not section 0 index 1");
    const lines = panel.render(80);
    assert.ok(lines.some((l) => plain(l).includes("write-guard")));
    assert.ok(!lines.some((l) => l.includes("no-env")));
  });

  it("`/` is a no-op in confirm mode", () => {
    const panel = makePanel([makeHook("alpha", "repo/owner")]);
    panel.handleInput("r", makeCtx()); // open remove confirm
    panel.handleInput("/", makeCtx());
    assert.ok(!panel.isSearchActive, "search not entered during confirm");
    assert.ok(panel.render(80).some((l) => l.includes(`Remove "alpha"?`)),
      "confirm dialog still open");
  });

  it("`/` is a no-op on an empty panel", () => {
    const panel = makePanel([]);
    panel.handleInput("/", makeCtx());
    assert.ok(!panel.isSearchActive, "no search on an empty panel");
  });

  it("normal mode: Space no longer toggles (no-op); Enter toggles", () => {
    const active = new Set<string>();
    const panel = makePanel([makeHook("alpha")], active);

    panel.handleInput(" ", makeCtx()); // Space — should NOT toggle
    assert.equal(active.size, 0, "Space does not toggle in normal mode");

    panel.handleInput("\r", makeCtx()); // Enter — toggles on
    assert.ok(active.has("alpha"), "Enter toggles in normal mode");
  });

  it("shows only Enter context plus exit-search footer while searching", () => {
    const panel = makePanel([makeHook("alpha"), makeHook("beta", "repo/aaa")]);
    panel.handleInput("/", makeCtx());
    const lines = panel.render(100);
    const action = plain(lines.find((l) => l.includes("[›]")) ?? "");
    const footer = plain(lines.find((l) => l.includes("exit search")) ?? "");
    assert.match(action, /^    › Enter enable$/, "only the still-available row action remains");
    assert.match(footer, /^  Esc exit search$/, "footer advertises only leaving search");
    assert.ok(!lines.some((l) => /set default|remove|edit preset|disable all|install hooks/.test(l)));
  });

  it("feeds normal action letters into the query while searching", () => {
    const panel = makePanel([makeHook("tre-hook")]);
    panel.handleInput("/", makeCtx());
    for (const key of "tre") panel.handleInput(key, makeCtx());
    const query = panel.render(100).find((l) => l.includes("▏"));
    assert.ok(query && plain(query).includes("/tre"), "t/r/e are query characters in search");
  });

  // ── Highlight rendering ─────────────────────────────────────────
  // The mock theme wraps accent text in `[]`, so a highlighted name splits
  // into per-char-run accent spans. These tests pin that the highlight is
  // actually emitted (not just that filtering happened).

  it("highlights matched chars in the focused row's name", () => {
    const panel = makePanel([makeHook("no-env"), makeHook("write-guard")]);
    panel.handleInput("/", makeCtx());
    for (const ch of "env") panel.handleInput(ch, makeCtx());

    const lines = panel.render(80);
    // "no-env" is the sole match → focused (selected). The matched 'env'
    // run is its own accent span `[env]`, separate from the unmatched `no-`
    // prefix span — proving per-segment highlighting, not a whole-label wrap.
    const row = lines.find((l) => l.includes("no-env") || (l.includes("no-") && l.includes("env")));
    assert.ok(row, "no-env row renders");
    assert.ok(plain(row!).includes("no-env"), "name is intact after stripping accent");
    assert.ok(row!.includes("[env]"), "matched run is its own accent span");
  });

  it("highlights matched chars in the focused row's shell detail", () => {
    const panel = makePanel([
      makeHook("alpha", "local", false, { shell: "run env-check" }),
    ]);
    panel.handleInput("/", makeCtx());
    for (const ch of "env") panel.handleInput(ch, makeCtx());

    const lines = panel.render(80);
    const shellLine = lines.find((l) => l.includes("shell:"));
    assert.ok(shellLine, "shell detail renders");
    // Matched 'env' run is accent-highlighted (mock wraps accent in []);
    // unmatched chars are muted (mock returns them plain). 'run env-check'
    // has no 'e' before the 'env' token, so the greedy matcher hits it
    // contiguously.
    assert.ok(shellLine!.includes("[env]"),
      "matched chars in the shell command are highlighted");
  });

  // ── Highlight attribute: underline, not bold ────────────────────
  // Bold is too subtle to read against the accent-coloured selected row;
  // underline is hue-independent and fzf's default for current-line matches.
  // These tests use a tag-style theme so the attribute choice is observable.

  it("underlines (not bolds) matched chars on the focused row's name", () => {
    const theme = {
      fg: (_role: string, text: string) => text,
      bold: (text: string) => `<b>${text}</b>`,
      underline: (text: string) => `<u>${text}</u>`,
      strikethrough: (text: string) => text,
    } as unknown as Theme;
    const panel = makePanel([makeHook("no-env"), makeHook("write-guard")]);
    panel.setTheme(theme);

    panel.handleInput("/", makeCtx());
    for (const ch of "env") panel.handleInput(ch, makeCtx());

    const row = panel.render(80).find((l) => l.includes("no-") && l.includes("env"))!;
    assert.ok(row.includes("<u>env</u>"),
      "matched chars on the focused row are underlined");
    assert.ok(!row.includes("<b>"),
      "matched chars are not bolded (bold is unreadable against accent)");
  });

  it("underlines matched chars in the focused row's shell detail", () => {
    const theme = {
      fg: (_role: string, text: string) => text,
      bold: (text: string) => `<b>${text}</b>`,
      underline: (text: string) => `<u>${text}</u>`,
      strikethrough: (text: string) => text,
    } as unknown as Theme;
    const panel = makePanel([
      makeHook("alpha", "local", false, { shell: "run env-check" }),
    ]);
    panel.setTheme(theme);
    panel.handleInput("/", makeCtx());
    for (const ch of "env") panel.handleInput(ch, makeCtx());

    const shellLine = panel.render(80).find((l) => l.includes("shell:"))!;
    assert.ok(shellLine.includes("<u>env</u>"),
      "matched chars in the shell detail are underlined on the focused row");
  });
});

// ── Presets ───────────────────────────────────────────────────────
//
// M1: a preset renders in its existing local/repo group with an `hooks:`
// detail (comma-joined refs) instead of `shell:`/`when:`.  The detail comes
// from `renderHookDetail` dispatching on `preset` first, and the panel's
// `detailFor` branching on `isPreset`.

describe("HooksPanel presets", () => {
  it("renders a preset row in the local group", () => {
    const panel = makePanel([
      makeHook("guard"),
      makePreset("bundle", ["local/guard"]),
    ]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => plain(l).includes("bundle")),
      "the preset row is rendered",
    );
  });

  it("renders a hooks: detail (comma-joined refs) for a focused preset", () => {
    const panel = makePanel([
      makeHook("guard"),
      makePreset("bundle", ["local/guard", "owner/repo/other"]),
    ]);
    // Focus the preset (second row in the local group).
    panel.nav.moveWithin("down");
    const lines = panel.render(80);
    const hooksLine = lines.find((l) => l.includes("hooks:"));
    assert.ok(hooksLine, "a hooks: detail line is shown for the preset");
    assert.ok(
      hooksLine!.includes("local/guard") && hooksLine!.includes("owner/repo/other"),
      "both refs appear comma-joined on the hooks: line",
    );
    // No shell:/when: detail for a preset.
    assert.ok(!lines.some((l) => l.includes("shell:")), "no shell: line for a preset");
    assert.ok(!lines.some((l) => l.includes("when:")), "no when: line for a preset");
  });

  it("renders an empty preset with a hooks: label and no refs", () => {
    const panel = makePanel([makePreset("empty", [])]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => l.includes("hooks:")),
      "the hooks: label shows even for an empty preset",
    );
  });

  it("renders shell:/when: (not hooks:) for a focused shell hook", () => {
    const panel = makePanel([
      makeHook("guard", "local", false, { shell: "false", when: "true" }),
    ]);
    const lines = panel.render(80);
    assert.ok(lines.some((l) => l.includes("shell:")), "shell: shown for a shell Hook");
    assert.ok(lines.some((l) => l.includes("when:")), "when: shown when present");
    assert.ok(!lines.some((l) => l.includes("hooks:")), "no hooks: line for a shell Hook");
  });

  it("toggles a Preset's enabled state like a Hook", () => {
    const active = new Set<string>();
    const panel = makePanel(
      [makePreset("bundle", ["local/guard"])],
      active,
    );
    const ctx = makeCtx();
    // Enter enables either Catalog Entry kind directly.
    panel.handleInput("\r", ctx);
    assert.ok(active.has("bundle"), "preset is enabled after Enter");
    panel.handleInput("\r", ctx);
    assert.ok(!active.has("bundle"), "preset is disabled after a second Enter");
  });
});

// Preset coverage — a member of an enabled Preset shows
// `enabled · via {preset}` instead of `disabled` when not directly enabled.
// The `via {preset}` run is accent; `enabled` is dim. A directly enabled
// member shows just `enabled` (accent). These tests use the mock theme where
// accent = `[...]`, so `via safety` renders as `[via safety]`.
describe("HooksPanel Preset enablement status", () => {
  it("counts directly enabled Catalog Entries rather than effective Hooks", () => {
    const guard = makeHook("guard");
    const safety = makePreset("safety", ["local/guard"]);
    const panel = makePanel([guard, safety], new Set(["safety"]));

    const lines = panel.render(80);

    assert.ok(lines.some((line) => plain(line).includes("1/2 enabled")));
  });

  it("shows 'enabled · via {preset}' for a member of an enabled Preset", () => {
    const panel = makePanel(
      [makeHook("guard"), makePreset("safety", ["local/guard"])],
      new Set(["safety"]),
    );
    const lines = panel.render(80);
    const guardLine = rowFor(lines, "guard");
    assert.ok(guardLine, "guard row is rendered");
    // `guard` is not directly enabled, but enabled `safety` references it.
    assert.ok(
      plain(guardLine!).includes("enabled") && guardLine!.includes("[via safety]"),
      "focused member shows 'enabled · via safety'",
    );
    assert.ok(
      !plain(guardLine!).includes("disabled"),
      "not 'disabled' when covered by an enabled Preset",
    );
  });

  it("shows 'enabled · via {preset}' in a non-focused section", () => {
    const panel = makePanel(
      [
        makeHook("guard", "local"),
        makePreset("safety", ["local/guard"], "local"),
        makeHook("other", "owner/repo"),
      ],
      new Set(["safety"]),
    );
    // Focus the repo section so the local section is non-focused (dimmed).
    panel.nav.cycleSection("next");
    const lines = panel.render(80);
    const guardLine = rowFor(lines, "guard");
    assert.ok(guardLine, "guard row is rendered in the non-focused section");
    assert.ok(
      plain(guardLine!).includes("enabled") && guardLine!.includes("[via safety]"),
      "non-focused member also shows 'enabled · via safety'",
    );
  });

  it("shows plain 'enabled' when a member is enabled directly too", () => {
    const panel = makePanel(
      [makeHook("guard"), makePreset("safety", ["local/guard"])],
      new Set(["guard", "safety"]),
    );
    const lines = panel.render(80);
    const guardLine = rowFor(lines, "guard");
    assert.ok(guardLine, "guard row is rendered");
    assert.ok(
      plain(guardLine!).includes("enabled"),
      "directly enabled member shows 'enabled'",
    );
    assert.ok(
      !guardLine!.includes("via"),
      "no 'via' suffix when already enabled directly",
    );
  });

  it("shows 'disabled' when the covering Preset is disabled", () => {
    const panel = makePanel(
      [makeHook("guard"), makePreset("safety", ["local/guard"])],
      new Set(), // nothing enabled
    );
    const lines = panel.render(80);
    const guardLine = rowFor(lines, "guard");
    assert.ok(guardLine, "guard row is rendered");
    assert.ok(
      plain(guardLine!).includes("disabled"),
      "member shows 'disabled' when the preset is inactive",
    );
    assert.ok(
      !guardLine!.includes("via"),
      "no 'via' suffix when the preset is inactive",
    );
  });

  it("collapses multiple covering presets to 'via {n} presets'", () => {
    const panel = makePanel(
      [
        makeHook("guard"),
        makePreset("p1", ["local/guard"]),
        makePreset("p2", ["local/guard"]),
      ],
      new Set(["p1", "p2"]),
    );
    const lines = panel.render(80);
    const guardLine = rowFor(lines, "guard");
    assert.ok(guardLine, "guard row is rendered");
    assert.ok(
      guardLine!.includes("[via 2 presets]"),
      "multiple covering presets collapse to 'via 2 presets'",
    );
  });

  it("reflects branch enablement restored while the panel remains open", () => {
    const enabledEntries = new Set(["safety"]);
    const panel = makePanel(
      [makeHook("guard"), makePreset("safety", ["local/guard"])],
      enabledEntries,
    );
    assert.ok(rowFor(panel.render(80), "guard")?.includes("[via safety]"));

    enabledEntries.clear();

    assert.ok(plain(rowFor(panel.render(80), "guard")!).includes("disabled"));
  });

  it("updates coverage status after toggling the preset off", () => {
    const active = new Set<string>(["safety"]);
    const panel = makePanel(
      [makeHook("guard"), makePreset("safety", ["local/guard"])],
      active,
    );
    const ctx = makeCtx();

    // Initially: guard shows 'enabled · via safety'.
    let lines = panel.render(80);
    let guardLine = rowFor(lines, "guard");
    assert.ok(guardLine!.includes("[via safety]"), "initially covered by safety");

    // Focus the preset (2nd row) and toggle it off.
    panel.nav.moveWithin("down");
    panel.handleInput("\r", ctx);
    assert.ok(!active.has("safety"), "safety toggled off");

    // After toggle: guard shows 'disabled' (no enabled Preset covers it).
    panel.nav.moveWithin("up"); // focus back to guard
    lines = panel.render(80);
    guardLine = rowFor(lines, "guard");
    assert.ok(
      plain(guardLine!).includes("disabled"),
      "guard reverts to 'disabled' after the covering preset is toggled off",
    );
    assert.ok(!guardLine!.includes("via"), "no 'via' after toggle-off");
  });
});


// ═══════════════════════════════════════════════════════════════════
// M3 — Presets section, p/n keys, badges, dangling-ref (§) detection,
//      and source-qualified catalog mutations.
// ═══════════════════════════════════════════════════════════════════

import { createLocalPreset } from "../hookit/ui/hooks.js";
import { projectFilePath } from "../hookit/config.js";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A theme that tags each role so badge colours are observable in hooks. */
function tagTheme(): Theme {
  return {
    fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
    bold: (t: string) => t,
    underline: (t: string) => t,
    strikethrough: (t: string) => `<s>${t}</s>`,
  } as unknown as Theme;
}

function stateFromDir(
  cwd: string,
  enabledEntries: Set<string> = new Set(),
): HooksState {
  const state = new HooksState({ appendEntry() {} } as unknown as ExtensionAPI);
  state.load({
    global: join(cwd, ".global-hookit.json"),
    project: projectFilePath(cwd),
  });
  state.enabledEntries = enabledEntries;
  return state;
}

/** Build a panel backed by a real Hook Catalog and temporary files. */
function panelFromDir(cwd: string, enabledEntries: Set<string> = new Set()): HooksPanel {
  const panel = new HooksPanel(stateFromDir(cwd, enabledEntries));
  panel.setTheme(mockTheme());
  return panel;
}

function readConfig(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// ── Presets section: always present, ordered first ───────────────

describe("HooksPanel M3: Presets section", () => {
  it("always shows the Presets header, even with no presets", () => {
    const panel = makePanel([makeHook("alpha")]);
    const lines = panel.render(80);
    assert.ok(
      lines.some((l) => plain(l).includes("Presets")),
      "Presets header is shown even with no presets installed",
    );
  });

  it("orders sections Presets, local, then repos alpha", () => {
    const panel = makePanel([
      makeHook("zzz-1", "repo/zzz"),
      makeHook("aaa-1", "repo/aaa"),
      makeHook("local-1"),
      makePreset("bundle", ["local/local-1"]),
    ]);
    const lines = panel.render(80);
    const headers = lines
      .filter((l) => /^\s*(Presets|Local|repo\/)/.test(plain(l)))
      .map((l) => plain(l).trim());
    // First three section headers should be Presets, Local, repo/aaa.
    assert.ok(headers[0]!.startsWith("Presets"), "Presets is first");
    assert.ok(headers[1]!.startsWith("Local"), "Local is second");
    assert.ok(headers[2]!.startsWith("repo/aaa"), "repo/aaa before repo/zzz");
  });

  it("hoists presets out of their real source into the Presets section", () => {
    // A repo-sourced preset lands in Presets, not in its repo section.
    const panel = makePanel([
      makeHook("guard", "owner/repo"),
      makePreset("bundle", ["owner/repo/guard"], "owner/repo"),
    ]);
    const lines = panel.render(80);
    // The preset row is under Presets, not under owner/repo.
    const presetsHeaderIdx = lines.findIndex((l) => plain(l).includes("Presets"));
    const repoHeaderIdx = lines.findIndex((l) => plain(l).includes("owner/repo"));
    const bundleRowIdx = lines.findIndex((l) => plain(l).includes("bundle"));
    assert.ok(presetsHeaderIdx > -1 && repoHeaderIdx > -1 && bundleRowIdx > -1);
    assert.ok(
      bundleRowIdx > presetsHeaderIdx && bundleRowIdx < repoHeaderIdx,
      "preset row is between the Presets header and the repo header",
    );
  });
});

// ── p / n keys ────────────────────────────────────────────────────

describe("HooksPanel M3: p/n keys", () => {
  it("p jumps focus to the first Presets row", () => {
    const panel = makePanel([
      makeHook("alpha"),
      makePreset("bundle", ["local/alpha"]),
    ]);
    // Initial focus lands on the first non-empty section — Presets (has bundle).
    // Move away first to prove p returns.
    panel.nav.cycleSection("next"); // → local
    assert.equal(panel.nav.focusedSection, 1, "moved to local");
    panel.handleInput("p", makeCtx());
    assert.equal(panel.nav.focusedSection, 0, "p returns to the Presets section");
    assert.equal(panel.nav.focusedIndex, 0, "p lands on the first Presets row");
  });

  it("p lands on the Presets header (index 0) when Presets is empty", () => {
    const panel = makePanel([makeHook("alpha")]); // no presets
    panel.handleInput("p", makeCtx());
    assert.equal(panel.nav.focusedSection, 0, "p focuses the empty Presets section");
  });

  it("advertises P on the Presets header, not in the hint line", () => {
    // `p` jumps to Presets; the key is advertised on the Presets section
    // header (always, even when not focused) instead of as a hint-line item.
    const panel = makePanel([
      makeHook("alpha"),
      makePreset("bundle", ["local/alpha"]),
    ]);
    // Start focused on local (first non-empty section is Presets, but move away
    // so we can check the non-focused Presets header too).
    panel.nav.cycleSection("next"); // → local
    const lines = panel.render(80);
    const presetsHeader = lines.find((l) => plain(l).includes("Presets"))!;
    assert.ok(presetsHeader.includes("p"), "p is advertised on the Presets header");
    // No `p Presets` entry in the hint line.
    const hintLine = lines[lines.length - 1]!;
    assert.ok(!/\bp\b/.test(hintLine) || !hintLine.includes("Presets"),
      "no `p Presets` hint-line item");
  });

  it("n returns the create-preset action", () => {
    const panel = makePanel([makeHook("alpha")]);
    assert.equal(panel.handleInput("n", makeCtx()), "create-preset");
  });

  it("n cancels the remove confirm instead of creating (confirm first)", () => {
    const panel = makePanel([makeHook("alpha", "repo/owner")]);
    panel.handleInput("r", makeCtx()); // open remove confirm
    assert.ok(panel.render(80).some((l) => l.includes(`Remove "alpha"?`)));
    panel.handleInput("n", makeCtx()); // n → cancel confirm
    assert.ok(
      !panel.render(80).some((l) => l.includes(`Remove "alpha"?`)),
      "n cancelled the confirm (did not create a preset)",
    );
  });

  it("n feeds the search query (not an action) while searching", () => {
    const panel = makePanel([makeHook("alpha"), makeHook("no-env")]);
    panel.handleInput("/", makeCtx());
    panel.handleInput("n", makeCtx());
    assert.ok(panel.isSearchActive, "still in search after n");
    const qLine = panel.render(80).find((l) => l.endsWith("▏"));
    assert.ok(qLine && qLine.includes("n"), "n appended to the query");
  });
});

// ── e key: edit preset (local only) ──────────────────────────────

describe("HooksPanel M3: e key (edit preset, local only)", () => {
  it("e on a local preset returns the edit-preset action", () => {
    const panel = makePanel([makePreset("bundle", ["local/guard"], "local")]);
    panel.handleInput("p", makeCtx()); // focus Presets
    const result = panel.handleInput("e", makeCtx());
    assert.ok(result && typeof result === "object" && result.type === "edit-preset");
  });

  it("e on a non-local preset notifies (read-only) and does not edit", () => {
    const notified: string[] = [];
    const ctx = {
      ui: { notify: (msg: string) => notified.push(msg), theme: mockTheme(), setStatus() {} },
    } as unknown as ExtensionContext;
    const panel = makePanel([makePreset("bundle", [], "owner/repo")]);
    panel.handleInput("p", makeCtx()); // focus Presets
    const result = panel.handleInput("e", ctx);
    assert.strictEqual(result, undefined, "no edit-preset action for a non-local preset");
    assert.ok(notified.some((m) => /read-only/.test(m)), "notified read-only");
  });

  it("e on a shell hook notifies (presets only)", () => {
    const notified: string[] = [];
    const ctx = {
      ui: { notify: (msg: string) => notified.push(msg), theme: mockTheme(), setStatus() {} },
    } as unknown as ExtensionContext;
    const panel = makePanel([makeHook("guard")]);
    const result = panel.handleInput("e", ctx);
    assert.strictEqual(result, undefined, "no edit-preset action for a shell Hook");
    assert.ok(notified.some((m) => /presets only/.test(m)), "notified presets only");
  });
});

// ── e contextual action: local presets only ───────────────────────

describe("HooksPanel M3: e contextual action (local presets only)", () => {
  it("shows e edit preset for a focused local preset", () => {
    const theme = tagTheme();
    const panel = makePanel([makePreset("bundle", [], "local")]);
    panel.setTheme(theme);
    panel.handleInput("p", makeCtx());
    const actionLine = panel.render(160).find((l) => l.includes("edit preset"))!;
    assert.ok(actionLine, "e edit preset action is shown");
    assert.ok(
      panel.render(160).some((l) => l.includes("<accent>›</accent>")),
      "the contextual action run has an accent marker",
    );
    assert.ok(actionLine.includes("<accent>e</accent>"), "e key is accent");
  });

  it("omits e edit preset for a focused non-local preset", () => {
    const panel = makePanel([makePreset("bundle", [], "owner/repo")]);
    panel.handleInput("p", makeCtx());
    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("edit preset")),
      "read-only presets do not advertise an unavailable action",
    );
  });

  it("omits e edit preset when a shell hook is focused", () => {
    const panel = makePanel([makeHook("guard")]);
    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("edit preset")),
      "shell hooks do not advertise preset editing",
    );
  });
});

// ── Badges: ❄ (read-only/non-local), § (dangling), ⚠ (orphaned) ─────

describe("HooksPanel M3: badges", () => {
  it("renders a ❄ badge on non-local presets (read-only), none on local", () => {
    const theme = tagTheme();
    const panel = makePanel([
      makePreset("local-p", [], "local"),
      makePreset("repo-p", [], "owner/repo"),
    ]);
    panel.setTheme(theme);
    panel.handleInput("p", makeCtx()); // focus Presets
    const lines = panel.render(80);
    const localLine = lines.find((l) => l.includes("local-p"))!;
    const repoLine = lines.find((l) => l.includes("repo-p"))!;
    assert.ok(!localLine.includes("❄"), "local preset has no ❄ badge");
    assert.ok(repoLine.includes("<dim>❄ </dim>"), "non-local preset has a ❄ badge");
  });

  it("does not render a ❄ badge on shell hooks", () => {
    const panel = makePanel([makeHook("guard")]);
    const line = panel.render(80).find((l) => plain(l).includes("guard"))!;
    assert.ok(!line.includes("❄"), "no ❄ badge on a shell Hook");
  });

  it("renders a § badge on a preset with a dangling ref", () => {
    const panel = makePanel([makePreset("bundle", ["local/missing"])]);
    const line = panel.render(80).find((l) => plain(l).includes("bundle"))!;
    assert.ok(line.includes("§ "), "dangling preset gets a § badge");
  });

  it("does not render a § badge on a preset whose refs all resolve", () => {
    const panel = makePanel([
      makeHook("guard"),
      makePreset("bundle", ["local/guard"]),
    ]);
    const line = panel.render(80).find((l) => plain(l).includes("bundle"))!;
    assert.ok(!line.includes("§ "), "no § badge when every ref resolves");
  });

  it("treats a ref to a preset as dangling (no nested presets)", () => {
    const panel = makePanel([
      makePreset("outer", ["local/inner"]),
      makePreset("inner", []),
    ]);
    const outerLine = panel.render(80).find((l) => plain(l).includes("outer"))!;
    assert.ok(
      outerLine.includes("§ "),
      "a ref to a preset (not a shell hook) is dangling",
    );
  });

  it("aligns the status column across mixed no-badge / § badge sets within Presets", () => {
    // Two local presets in the Presets section: clean (no badge) and dangling
    // (§).  Their badge widths differ, but `maxLabelWidth` reserves the badge
    // width so the status column aligns within the section.
    const panel = makePanel([
      makeHook("guard"),
      makePreset("clean", ["local/guard"]),
      makePreset("dangling", ["local/missing"]),
    ]);
    panel.handleInput("p", makeCtx()); // focus Presets
    const lines = panel.render(80);
    const strip = (s: string) => s.replace(/[\[\]]/g, "").replace(/^[> ]{2}/, "");
    const cleanRow = strip(rowFor(lines, "clean")!);
    const danglingRow = strip(rowFor(lines, "dangling")!);
    assert.ok(cleanRow.includes("disabled") && danglingRow.includes("disabled"));
    assert.equal(
      cleanRow.indexOf("disabled"),
      danglingRow.indexOf("disabled"),
      "no-badge and § rows align their status column",
    );
  });

  it("co-renders ❄, § and ⚠ on a dangling non-local preset removed upstream", async () => {
    clearRepoEntriesCache();
    // The repo has no entry for "bundle" → it's orphaned (⚠).  Its ref
    // "local/missing" doesn't resolve → dangling (§).  It's non-local → ❄.
    // All three badges co-occur.
    mockRepoFetch(["hooks/defaults.json"], {
      other: { description: "O.", event: "tool_call", shell: "true" },
    });
    const panel = makePanel([
      makePreset("bundle", ["local/missing"], "owner/repo"),
    ]);
    panel.setRequestRender(() => {});
    panel.startOrphanCheck();
    await new Promise((r) => setImmediate(r));

    const line = panel.render(80).find((l) => plain(l).includes("bundle"))!;
    assert.ok(line.includes("❄ "), "❄ badge (non-local / read-only)");
    assert.ok(line.includes("§ "), "§ badge (dangling)");
    assert.ok(line.includes("⚠ "), "⚠ badge (orphaned)");
  });
});

// ── § dangling-ref detail line ────────────────────────────────────

describe("HooksPanel M3: § dangling-ref detail", () => {
  it("lists the dangling refs under a focused dangling preset", () => {
    const panel = makePanel([
      makePreset("bundle", ["local/missing", "owner/repo/gone"]),
    ]);
    // Presets is the focused section (first non-empty).
    const lines = panel.render(80);
    const idx = lines.findIndex((l) => plain(l).includes("bundle"));
    assert.ok(idx >= 0, "preset row renders");
    const detail = lines.slice(idx + 1).join("\n");
    assert.ok(
      detail.includes("§") && detail.includes("dangling"),
      "a § dangling warning line is shown under the preset",
    );
    assert.ok(
      detail.includes("local/missing") && detail.includes("owner/repo/gone"),
      "both dangling refs are listed",
    );
  });

  it("does not show the § detail under a preset whose refs resolve", () => {
    const panel = makePanel([
      makeHook("guard"),
      makePreset("bundle", ["local/guard"]),
    ]);
    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("dangling")),
      "no dangling detail when refs resolve",
    );
  });
});

// ── ❄ non-editable detail line ──────────────────────────────────────

describe("HooksPanel M3: ❄ non-editable detail", () => {
  it("shows a non-editable note under a focused non-local preset", () => {
    const panel = makePanel([makePreset("bundle", [], "owner/repo")]);
    const lines = panel.render(80);
    const idx = lines.findIndex((l) => plain(l).includes("bundle"));
    assert.ok(idx >= 0, "preset row renders");
    const detail = lines.slice(idx + 1).join("\n");
    assert.ok(
      detail.includes("❄") && detail.includes("non-editable"),
      "a ❄ non-editable note is shown under the preset",
    );
    assert.ok(
      detail.includes("copy via n"),
      "guides the user to the copy workaround",
    );
  });

  it("does not show the non-editable note under a local preset", () => {
    const panel = makePanel([makePreset("bundle", [], "local")]);
    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("non-editable")),
      "no non-editable note for a local preset",
    );
  });

  it("does not show the non-editable note under a shell hook", () => {
    const panel = makePanel([makeHook("guard")]);
    const lines = panel.render(80);
    assert.ok(
      !lines.some((l) => l.includes("non-editable")),
      "no non-editable note for a shell hook",
    );
  });
});

// ── Mutations use selected source/name identity ───────────────────
//
// The Presets group is synthetic, so `r`/`t` must use the entry's real
// Hook Source rather than the display group label.

describe("HooksPanel M3: source-qualified catalog mutations", () => {
  let tmpRoot: string;
  before(() => {
    tmpRoot = join(tmpdir(), `HooKit-m3-test-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
  });
  after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  function writeConfig(cwd: string, data: unknown): void {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectFilePath(cwd), JSON.stringify(data));
  }

  it("r removes a preset from its real source section (not a 'Presets' section)", () => {
    const cwd = join(tmpRoot, "remove-preset");
    writeConfig(cwd, {
      local: {
        guard: { description: "G", event: "tool_call", shell: "true" },
        bundle: { description: "B", preset: ["local/guard"] },
      },
    });
    const panel = panelFromDir(cwd);

    // Focus the preset (Presets section, first non-empty).
    assert.equal(panel.nav.focusedSection, 0, "Presets is focused");
    assert.equal(panel.nav.focusedItem?.name, "bundle");

    const ctx = {
      cwd,
      ui: { notify() {}, theme: mockTheme(), setStatus() {} },
    } as unknown as ExtensionContext;
    panel.handleInput("r", ctx);  // open confirm
    const result = panel.handleInput("y", ctx); // confirm → reload
    assert.equal(result, "reload");

    // The preset is gone from `local`, not a synthetic Presets source.
    const after = readConfig(projectFilePath(cwd));
    assert.ok(
      !(after.local as Record<string, unknown> | undefined)?.bundle,
      "preset removed from its real source section",
    );
    assert.ok(
      (after.local as Record<string, unknown> | undefined)?.guard,
      "the unrelated guard hook is untouched",
    );
    // No synthetic "Presets" section was ever written.
    assert.ok(after.Presets === undefined, "no Presets section on disk");
  });

  type DrivenComponent = {
    handleInput(data: string): void;
    render(width: number): string[];
  };

  function assertComponentFocus(
    component: DrivenComponent,
    name: string,
    detail = "",
  ): void {
    const focused = component.render(100).find((line) => line.includes("[> ]"));
    assert.ok(
      focused?.includes(`[${name}`) && focused.includes(detail),
      `expected ${name}${detail ? ` ${detail}` : ""} to be highlighted, got ${focused}`,
    );
  }

  async function driveCommand(
    cwd: string,
    steps: Array<(component: DrivenComponent) => void>,
  ): Promise<void> {
    const state = stateFromDir(cwd);
    let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    } as unknown as ExtensionAPI;
    registerHooksCommand(pi, state);

    let stepIndex = 0;
    const ctx = {
      cwd,
      isProjectTrusted: () => state.projectTrusted,
      ui: {
        theme: mockTheme(),
        notify() {},
        setStatus() {},
        custom<U>(
          factory: (
            tui: { terminal: { rows: number }; requestRender(): void },
            theme: Theme,
            keybindings: object,
            done: (value: U) => void,
          ) => DrivenComponent,
        ): Promise<U> {
          const step = steps[stepIndex++];
          assert.ok(step, `unexpected custom UI call ${stepIndex}`);
          return new Promise<U>((resolve) => {
            const component = factory(
              { terminal: { rows: 30 }, requestRender() {} },
              mockTheme(),
              {},
              resolve,
            );
            step(component);
          });
        },
      },
    } as unknown as ExtensionContext;

    await handler!("", ctx);
    assert.equal(stepIndex, steps.length, "all expected UI steps ran");
  }

  it("t keeps focus on the highlighted hook after setting it as default", async () => {
    const cwd = join(tmpRoot, "toggle-default-focus");
    writeConfig(cwd, {
      local: {
        alpha: { description: "A", event: "tool_call", shell: "true" },
        gamma: { description: "G", event: "tool_call", shell: "true" },
      },
    });

    await driveCommand(cwd, [
      (component) => {
        component.handleInput("\x1b[B");
        assertComponentFocus(component, "gamma");
        component.handleInput("t");
      },
      (component) => {
        assertComponentFocus(component, "gamma", "(default)");
        component.handleInput("\x1b");
      },
    ]);
  });

  it("i restores focus after the install picker is cancelled", async () => {
    const cwd = join(tmpRoot, "install-focus");
    writeConfig(cwd, {
      local: {
        alpha: { description: "A", event: "tool_call", shell: "true" },
        gamma: { description: "G", event: "tool_call", shell: "true" },
      },
    });

    await driveCommand(cwd, [
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("i");
      },
      (component) => component.handleInput("\x1b"),
      (component) => {
        assertComponentFocus(component, "gamma");
        component.handleInput("\x1b");
      },
    ]);
  });

  it("n restores focus after preset creation is cancelled", async () => {
    const cwd = join(tmpRoot, "cancel-create-focus");
    writeConfig(cwd, {
      local: {
        alpha: { description: "A", event: "tool_call", shell: "true" },
        gamma: { description: "G", event: "tool_call", shell: "true" },
      },
    });

    await driveCommand(cwd, [
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("n");
      },
      (component) => component.handleInput("\x1b"),
      (component) => {
        assertComponentFocus(component, "gamma");
        component.handleInput("\x1b");
      },
    ]);
  });

  it("n focuses the newly created preset", async () => {
    const cwd = join(tmpRoot, "created-preset-focus");
    writeConfig(cwd, {
      local: {
        existing: { description: "E", preset: [] },
        alpha: { description: "A", event: "tool_call", shell: "true" },
        gamma: { description: "G", event: "tool_call", shell: "true" },
      },
    });

    await driveCommand(cwd, [
      (component) => {
        component.handleInput("\t");
        component.handleInput("\x1b[B");
        component.handleInput("n");
      },
      (component) => {
        for (const char of "fresh") component.handleInput(char);
        component.handleInput("\r");
      },
      (component) => {
        assertComponentFocus(component, "fresh");
        component.handleInput("\x1b");
      },
    ]);
  });

  it("e returns focus to the edited preset", async () => {
    const cwd = join(tmpRoot, "edit-preset-focus");
    writeConfig(cwd, {
      local: {
        bundleA: { description: "A", preset: [] },
        bundleB: { description: "B", preset: [] },
      },
    });

    await driveCommand(cwd, [
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("e");
      },
      (component) => {
        component.handleInput("x");
        component.handleInput("\r");
      },
      (component) => component.handleInput("\x1b"),
      (component) => {
        assertComponentFocus(component, "bundleB");
        component.handleInput("\x1b");
      },
    ]);
  });

  it("r focuses the next hook after removing a middle row", async () => {
    const cwd = join(tmpRoot, "remove-middle-focus");
    writeConfig(cwd, {
      local: {
        alpha: { description: "A", event: "tool_call", shell: "true" },
        beta: { description: "B", event: "tool_call", shell: "true" },
        gamma: { description: "G", event: "tool_call", shell: "true" },
      },
    });

    await driveCommand(cwd, [
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("r");
        component.handleInput("y");
      },
      (component) => {
        assertComponentFocus(component, "gamma");
        component.handleInput("\x1b");
      },
    ]);
  });

  it("r focuses the previous hook after removing the last row", async () => {
    const cwd = join(tmpRoot, "remove-last-focus");
    writeConfig(cwd, {
      local: {
        alpha: { description: "A", event: "tool_call", shell: "true" },
        beta: { description: "B", event: "tool_call", shell: "true" },
      },
    });

    await driveCommand(cwd, [
      (component) => {
        component.handleInput("\x1b[B");
        component.handleInput("r");
        component.handleInput("y");
      },
      (component) => {
        assertComponentFocus(component, "alpha");
        component.handleInput("\x1b");
      },
    ]);
  });

  it("r moves to the next section after removing its only preset", async () => {
    const cwd = join(tmpRoot, "remove-only-preset-focus");
    writeConfig(cwd, {
      local: {
        bundle: { description: "B", preset: [] },
        alpha: { description: "A", event: "tool_call", shell: "true" },
      },
    });

    await driveCommand(cwd, [
      (component) => {
        component.handleInput("r");
        component.handleInput("y");
      },
      (component) => {
        assertComponentFocus(component, "alpha");
        component.handleInput("\x1b");
      },
    ]);
  });

  it("r moves to the previous section's last row when the final section disappears", async () => {
    const cwd = join(tmpRoot, "remove-final-section-focus");
    writeConfig(cwd, {
      repos: ["repo/z"],
      local: {
        alpha: { description: "A", event: "tool_call", shell: "true" },
        beta: { description: "B", event: "tool_call", shell: "true" },
      },
      "repo/z": {
        gamma: { description: "G", event: "tool_call", shell: "true" },
      },
    });

    await driveCommand(cwd, [
      (component) => {
        component.handleInput("\t");
        component.handleInput("r");
        component.handleInput("y");
      },
      (component) => {
        assertComponentFocus(component, "beta");
        component.handleInput("\x1b");
      },
    ]);
  });

  it("t toggles default through the preset's source/name identity", () => {
    const cwd = join(tmpRoot, "toggle-preset");
    writeConfig(cwd, {
      local: {
        guard: { description: "G", event: "tool_call", shell: "true" },
        bundle: { description: "B", preset: ["local/guard"] },
      },
    });
    const panel = panelFromDir(cwd);
    assert.equal(panel.nav.focusedItem?.name, "bundle");

    panel.handleInput("t", makeCtx());

    const after = readConfig(projectFilePath(cwd));
    const bundle = (after.local as Record<string, unknown>).bundle as Record<string, unknown>;
    assert.equal(bundle.default, true, "default toggled to true on the preset");
    assert.deepEqual(
      bundle.preset,
      ["local/guard"],
      "preset refs are preserved through the toggle",
    );
  });
});

// ── createLocalPreset (n flow) ────────────────────────────────────

describe("createLocalPreset", () => {
  let tmpRoot: string;
  before(() => {
    tmpRoot = join(tmpdir(), `HooKit-create-test-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
  });
  after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  /** A ctx whose `ui.custom` drives a single textInputDialog, capturing notify calls. */
  function makeCreateCtx(cwd: string): {
    ctx: ExtensionContext;
    notifications: string[];
    drive: (name: string) => void;
    driveCancel: () => void;
  } {
    let triple: { handleInput: (d: string) => void } | null = null;
    const notifications: string[] = [];
    const theme = mockTheme();

    const ctx = {
      ui: {
        // `textInputDialog` calls `ctx.ui.custom(factory, overlay)`; we run
        // the factory to grab its `{ handleInput }` triple, and resolve the
        // promise when the factory's `done` is called (Enter/Esc).
        custom<U>(
          fn: (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (v: U) => void,
          ) => { handleInput: (d: string) => void },
          _overlay: unknown,
        ): Promise<U> {
          return new Promise<U>((resolve) => {
            triple = fn(
              { requestRender() {} },
              theme,
              {},
              (v: U) => resolve(v),
            ) as { handleInput: (d: string) => void };
          });
        },
        theme,
        notify(msg: string) { notifications.push(msg); },
        setStatus() {},
      },
      cwd,
    } as unknown as ExtensionContext;

    const drive = (name: string): void => {
      const t = triple!;
      for (const ch of name) t.handleInput(ch);
      t.handleInput("\r"); // Enter → done(name)
    };
    const driveCancel = (): void => {
      triple!.handleInput("\x1b"); // Esc → done(null)
    };
    return { ctx, notifications, drive, driveCancel };
  }

  it("creates an empty local preset (description '', preset [], no default)", async () => {
    const cwd = join(tmpRoot, "create");
    mkdirSync(cwd, { recursive: true });
    const state = stateFromDir(cwd);

    const { ctx, notifications, drive } = makeCreateCtx(cwd);
    const p = createLocalPreset(ctx, state);
    drive("my-preset");
    await p;

    const after = readConfig(projectFilePath(cwd));
    const entry = (after.local as Record<string, unknown>)["my-preset"] as Record<string, unknown>;
    assert.deepEqual(entry, { description: "", preset: [] }, "empty preset written");
    assert.ok(
      notifications.some((n) => n.includes("created preset")),
      "created notification emitted",
    );
  });

  it("warns and does not overwrite when the name already exists locally", async () => {
    const cwd = join(tmpRoot, "exists");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectFilePath(cwd), JSON.stringify({
      local: { "my-preset": { description: "keep me", event: "tool_call", shell: "false" } },
    }));
    const state = stateFromDir(cwd);

    const { ctx, notifications, drive } = makeCreateCtx(cwd);
    const p = createLocalPreset(ctx, state);
    drive("my-preset");
    await p;

    // The existing hook is untouched (not overwritten with an empty preset).
    const after = readConfig(projectFilePath(cwd));
    const entry = (after.local as Record<string, unknown>)["my-preset"] as Record<string, unknown>;
    assert.equal(entry.description, "keep me", "existing entry not clobbered");
    assert.equal(entry.shell, "false", "existing shell preserved");
    assert.ok(
      notifications.some((n) => n.includes("already exists locally")),
      "a warning was emitted about the name clash",
    );
  });

  it("Esc (null name) creates nothing", async () => {
    const cwd = join(tmpRoot, "cancel");
    mkdirSync(cwd, { recursive: true });
    const state = stateFromDir(cwd);

    const { ctx, driveCancel } = makeCreateCtx(cwd);
    const p = createLocalPreset(ctx, state);
    driveCancel();
    await p;

    assert.ok(!existsSync(projectFilePath(cwd)), "no file written on cancel");
  });
});
