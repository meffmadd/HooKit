import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type {
  CatalogEntry,
  CatalogInstallation,
} from "../assertion-catalog/index.js";
import {
  buildRepoPickerItems,
  classifyEntry,
  fetchRuleFile,
  fetchRuleFiles,
  fetchRepoEntries,
  REPO_ADD_ACTION,
  type EntryState,
  type RuleEntries,
  type RuleEntry,
  type RuleFile,
} from "../installer.js";
import { entryKey, parseEntryRef } from "../domain/entry.js";
import {
  HINT_ENTER_CONFIRM,
  HINT_ENTER_INSTALL,
  HINT_ENTER_OPEN,
  HINT_ENTER_SELECT,
  HINT_ENTER_UNINSTALL,
  HINT_ENTER_UPDATE,
  HINT_ESC_BACK,
  HINT_ESC_CANCEL,
  selectDialog,
  textInputDialog,
  type SelectDialogResult,
} from "./components.js";
import {
  formatCatalogFailure,
  type AssertsState,
} from "./state.js";

// ---------------------------------------------------------------------------
// Step 1: pick (or add) a repo
// ---------------------------------------------------------------------------

/** Show the repo picker. Returns the chosen value (a repo or REPO_ADD_ACTION), or null on Esc. */
async function promptRepoChoice(
  ctx: ExtensionContext,
  repos: string[],
): Promise<SelectDialogResult<string>> {
  return selectDialog<string>(ctx, {
    title: "Repos",
    items: buildRepoPickerItems(repos),
    hint: [HINT_ENTER_SELECT, HINT_ESC_CANCEL],
  });
}

/** Prompt for a new repo name. Returns the trimmed input or null. */
async function promptNewRepo(
  ctx: ExtensionContext,
): Promise<string | null> {
  return textInputDialog(ctx, {
    title: "Add repo",
    label: "Enter owner/repo:",
    hint: [HINT_ENTER_CONFIRM, HINT_ESC_BACK],
  });
}

/**
 * Resolve the user's repo choice.  If they picked "Add repo…", prompt for
 * a name and register it.  Returns the chosen repo, or null on cancel/error.
 */
async function resolveRepo(
  ctx: ExtensionContext,
  state: AssertsState,
  choice: string,
): Promise<string | null> {
  if (choice !== REPO_ADD_ACTION) return choice;

  const newRepo = await promptNewRepo(ctx);
  if (!newRepo) return null;

  const result = state.mutate({ type: "add-repository", source: newRepo });
  if (!result.ok) {
    ctx.ui.notify(`pi-assert: ${formatCatalogFailure(result)}`, "error");
    return null;
  }
  return newRepo;
}

// ---------------------------------------------------------------------------
// Step 2: pick a rule file from the repo
// ---------------------------------------------------------------------------

/** Show a picker over the fetched rule files. Returns the chosen file or null. */
async function promptRuleFile(
  ctx: ExtensionContext,
  repo: string,
  files: RuleFile[],
): Promise<RuleFile | null> {
  const items: SelectItem[] = files.map((f) => ({
    value: f.path,
    label: f.name,
  }));
  const result = await selectDialog<string>(ctx, {
    title: `Rule Files (${repo})`,
    items,
    hint: [HINT_ENTER_OPEN, HINT_ESC_CANCEL],
  });
  if (result.value === null) return null;
  return files.find((f) => f.path === result.value) ?? null;
}

/** Fetch the repo's rule files and prompt the user to pick one. */
async function fetchAndPromptFile(
  ctx: ExtensionContext,
  repo: string,
): Promise<RuleFile | null> {
  let files: RuleFile[];
  try {
    files = await fetchRuleFiles(repo);
  } catch (err) {
    ctx.ui.notify(
      `pi-assert: failed to fetch rule files — ${String(err)}`,
      "error",
    );
    return null;
  }

  if (files.length === 0) {
    ctx.ui.notify(`No rule files found in ${repo}.`, "info");
    return null;
  }

  return promptRuleFile(ctx, repo, files);
}

// ---------------------------------------------------------------------------
// Step 3: pick an assert entry from a rule file
// ---------------------------------------------------------------------------

/**
 * Entry picker for a single rule file.  Each entry is classified against the
 * installed entries for this repo, and both the badge and the hintline reflect
 * the focused entry's next action:
 *
 * - not installed → (no badge), `Enter install`
 * - outdated       → `↑` badge, `Enter update`
 * - installed      → `✓` badge, `Enter uninstall` (with a `y/n` confirm)
 *
 * Presets also show a `P` badge. `Enter` is a unified tri-state; the `r` Remove
 * binding is gone (Enter on an installed entry uninstalls, so `r` is redundant).
 * The installed map is caller-supplied from the latest catalog snapshot, so
 * marks and hints immediately reflect each successful mutation.
 */
async function promptAssertEntry(
  ctx: ExtensionContext,
  file: RuleFile,
  entries: RuleEntries,
  installedMap: Map<string, CatalogEntry>,
  initialIndex?: number,
): Promise<SelectDialogResult<string>> {
  const fileName = file.path.replace(/^rules\//, "").replace(/\.json$/, "");
  const theme = ctx.ui.theme;
  const names = Object.keys(entries);
  const items: SelectItem[] = names.map((name) => {
    const e = entries[name]!;
    return { value: name, label: name, description: e.description };
  });

  const stateFor = (name: string): EntryState =>
    classifyEntry(entries[name]!, installedMap.get(name));

  return selectDialog<string>(ctx, {
    title: fileName,
    items,
    initialIndex,
    mark: (item) => {
      const e = entries[item.value];
      const isPresetEntry = e && "preset" in e;
      const st = stateFor(item.value);
      let mark = "";
      if (isPresetEntry) mark += theme.fg("accent", "P ");
      if (st === "outdated") mark += theme.fg("warning", "↑ ");
      if (st === "installed") mark += theme.fg("success", "✓ ");
      return mark;
    },
    hintFor: (item) => {
      const st = stateFor(item.value);
      const enterHint =
        st === "not-installed"
          ? HINT_ENTER_INSTALL
          : st === "outdated"
            ? HINT_ENTER_UPDATE
            : HINT_ENTER_UNINSTALL;
      return [enterHint, HINT_ESC_BACK];
    },
    // `Enter` on an `"installed"` entry swaps to a y/n uninstall confirm
    // before the dialog resolves.  This `shouldConfirm` predicate MUST stay
    // in sync with the dispatch in `runInstallWizard` (the `"installed"`
    // branch calls `removeAndReload`): the confirm is purely a guard, and the
    // dispatch re-derives the state, so a mismatch would confirm-then-take-
    // the-wrong-action.  Both branch off the same `stateFor(...) ===
    // "installed"` test.
    confirmOnSelect: {
      shouldConfirm: (item) => stateFor(item.value) === "installed",
      title: "Remove rule",
      message: (item) => {
        const e = entries[item.value];
        const kind = e && "preset" in e ? "preset" : "assert";
        return `  Remove "${item.value}" ${kind}?`;
      },
    },
    detailFor: (value) => {
      const e = entries[value];
      if (!e) return undefined;
      if ("preset" in e) {
        return { preset: e.preset };
      }
      return { shell: e.shell, when: e.when };
    },
  });
}

/** Fetch a rule file's entries (null on error/empty). Split out so the wizard re-fetches only when the file changes. */
async function fetchEntries(
  ctx: ExtensionContext,
  repo: string,
  file: RuleFile,
): Promise<RuleEntries | null> {
  let entries: RuleEntries;
  try {
    entries = await fetchRuleFile(repo, file.path);
  } catch (err) {
    ctx.ui.notify(
      `pi-assert: failed to load rule file — ${String(err)}`,
      "error",
    );
    return null;
  }

  if (Object.keys(entries).length === 0) {
    ctx.ui.notify("No valid rules in this file.", "info");
    return null;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Catalog mutations
// ---------------------------------------------------------------------------

/** Fetch every available, not-yet-installed repository member of a preset. */
async function preparePresetMembers(
  ctx: ExtensionContext,
  state: AssertsState,
  refs: readonly string[],
  reserved: readonly string[] = [],
): Promise<CatalogInstallation[]> {
  const members = new Map<string, { source: string; name: string }>();
  for (const ref of refs) {
    const parsed = parseEntryRef(ref);
    if (parsed && parsed.source !== "local") {
      members.set(entryKey(parsed.source, parsed.name), parsed);
    }
  }
  const installed = new Set([
    ...state.entries.map((entry) => entryKey(entry.source, entry.name)),
    ...reserved,
  ]);
  const prepared: CatalogInstallation[] = [];
  for (const identity of members.values()) {
    const key = entryKey(identity.source, identity.name);
    if (installed.has(key)) continue;
    try {
      const entries = await fetchRepoEntries(identity.source);
      const entry = entries.get(identity.name);
      if (!entry) {
        ctx.ui.notify(
          `pi-assert: member "${identity.name}" not found in ${identity.source}.`,
          "warning",
        );
        continue;
      }
      prepared.push({ identity, entry });
      installed.add(key);
    } catch (error) {
      ctx.ui.notify(
        `pi-assert: failed to fetch member "${identity.name}" — ${String(error)}`,
        "error",
      );
    }
  }
  return prepared;
}

export async function installRepositoryEntry(
  ctx: ExtensionContext,
  state: AssertsState,
  repo: string,
  name: string,
  entry: RuleEntry,
): Promise<void> {
  const identity = { source: repo, name };
  const primary: CatalogInstallation = { identity, entry };
  const members = "preset" in entry
    ? await preparePresetMembers(
        ctx,
        state,
        entry.preset,
        [entryKey(repo, name)],
      )
    : [];
  const result = state.mutate({
    type: "install",
    entries: [primary, ...members],
  });
  if (!result.ok) {
    ctx.ui.notify(
      `pi-assert: failed to install "${name}" — ${formatCatalogFailure(result)}`,
      "error",
    );
    return;
  }
  state.updateStatus(ctx);
  for (const member of members) {
    ctx.ui.notify(
      `pi-assert: installed member "${member.identity.name}" (via preset).`,
      "info",
    );
  }
  ctx.ui.notify(
    `pi-assert: installed "${name}". Use /asserts to enable it.`,
    "info",
  );
}

function removeEntry(
  ctx: ExtensionContext,
  state: AssertsState,
  repo: string,
  name: string,
): void {
  const result = state.mutate({
    type: "remove",
    identity: { source: repo, name },
  });
  if (!result.ok) {
    ctx.ui.notify(
      `pi-assert: failed to remove "${name}" — ${formatCatalogFailure(result)}`,
      "error",
    );
    return;
  }
  state.persist();
  state.updateStatus(ctx);
  ctx.ui.notify(`pi-assert: removed "${name}".`, "info");
}

async function updateEntry(
  ctx: ExtensionContext,
  state: AssertsState,
  name: string,
  entry: RuleEntry,
  installed: CatalogEntry,
): Promise<void> {
  const members = "preset" in entry
    ? await preparePresetMembers(ctx, state, entry.preset)
    : [];
  const updated = state.mutate({
    type: "update",
    identity: { source: installed.source, name },
    entry,
  });
  if (!updated.ok) {
    ctx.ui.notify(
      `pi-assert: failed to update "${name}" — ${formatCatalogFailure(updated)}`,
      "error",
    );
    return;
  }
  state.updateStatus(ctx);
  if (members.length > 0) {
    const installedMembers = state.mutate({ type: "install", entries: members });
    if (!installedMembers.ok) {
      ctx.ui.notify(
        `pi-assert: updated "${name}" but failed to install preset members — ${formatCatalogFailure(installedMembers)}`,
        "error",
      );
      return;
    }
    for (const member of members) {
      ctx.ui.notify(
        `pi-assert: installed member "${member.identity.name}" (via preset).`,
        "info",
      );
    }
  }
  state.updateStatus(ctx);
  ctx.ui.notify(`pi-assert: updated "${name}".`, "info");
}

// ---------------------------------------------------------------------------
// runInstallWizard — pick repo → pick file → loop the entry picker for that
// file (install/remove stay in the same file; Esc → file picker; Esc → exit).
// Entries are fetched once per file; the installed set is re-read each prompt
// so `✓` marks refresh immediately.
// ---------------------------------------------------------------------------
export async function runInstallWizard(
  ctx: ExtensionContext,
  state: AssertsState,
): Promise<void> {
  const trustAware = ctx as ExtensionContext & {
    isProjectTrusted?: () => boolean;
  };
  if (trustAware.isProjectTrusted?.() === false) {
    ctx.ui.notify("pi-assert: trust this project before installing rules.", "error");
    return;
  }

  // Step 1: pick (or add) a repo
  const choice = await promptRepoChoice(ctx, Array.from(state.repositories));
  if (choice.value === null) return;

  const repo = await resolveRepo(ctx, state, choice.value);
  if (!repo) return;

  // Step 2: pick a rule file.  Loop over files until the user escapes.
  let file: RuleFile | null = await fetchAndPromptFile(ctx, repo);

  while (file) {
    const entries = await fetchEntries(ctx, repo, file);
    if (!entries) {
      // Fetch failed / empty — back to the file picker.
      file = await fetchAndPromptFile(ctx, repo);
      continue;
    }

    // Loop the entry picker for this file; Esc drops back to the file picker.
    let index: number | undefined;
    for (;;) {
      // Build the installed map from the fresh catalog returned by the last
      // mutation. Include both shell assertions and presets for classification.
      const installedMap = new Map<string, CatalogEntry>();
      for (const a of state.entries) {
        if (a.source === repo) installedMap.set(a.name, a);
      }

      const result = await promptAssertEntry(
        ctx,
        file,
        entries,
        installedMap,
        index,
      );
      if (result.value === null) break;

      // Tri-state Enter dispatch: classify the chosen name against the
      // installed map and act accordingly.  `confirmOnSelect` in
      // `promptAssertEntry` already gated the uninstall confirm for the
      // `"installed"` branch below — its `shouldConfirm` predicate MUST match
      // this dispatch's uninstall branch (both test `stateFor ===
      // "installed"`); see the comment there.
      const name = result.value;
      const repoEntry = entries[name]!;
      const installed = installedMap.get(name);
      const entryState = classifyEntry(repoEntry, installed);

      if (entryState === "not-installed") {
        await installRepositoryEntry(ctx, state, repo, name, repoEntry);
      } else if (entryState === "outdated") {
        await updateEntry(ctx, state, name, repoEntry, installed!);
      } else {
        // "installed" → uninstall
        removeEntry(ctx, state, repo, name);
      }

      index = result.index;
    }

    file = await fetchAndPromptFile(ctx, repo);
  }
}
