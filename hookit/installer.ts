import { isDeepStrictEqual } from "node:util";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { Action, PersistedEntry } from "./domain/entry.js";
import {
  isValidEntryName,
  validateHookEntry,
} from "./domain/validation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A schema-valid entry from a hooks repository. */
export type HookEntry = PersistedEntry;

/** Top-level shape of a hooks/*.json file. */
export type HookEntries = Record<string, HookEntry>;

/** A `.json` hook file under `hooks/` in a HooKit-rules repo. */
export interface HookFile {
  /**
   * Relative path under `hooks/` without the `.json` extension.
   * Flat files keep a bare name ("defaults"); nested files keep the
   * intermediate directories ("security/writes", "git/no-force-push").
   * Used as the picker label and the hook-entry title.
   */
  name: string;
  /** Full path within the repo (e.g. "hooks/security/writes.json"). */
  path: string;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

const API_BASE = "https://api.github.com";

/**
 * List `.json` hook files under `hooks/` in a GitHub repo, recursively.
 *
 * Uses the Git Trees API with `recursive=1` so a single round trip
 * enumerates the whole tree regardless of nesting depth.  The Contents
 * API only lists immediate children, so it can't see subdirectories.
 *
 * GitHub accepts a branch name directly as the tree SHA (it resolves
 * the ref server-side), so no separate ref-resolve hop is needed.
 * A leading `refs/heads/` is stripped if present so callers can pass
 * either a bare branch ("main") or a full ref ("refs/heads/main").
 *
 * Returns blobs whose path starts with `hooks/` and ends in `.json`,
 * sorted by path.  The `name` field is the path relative to `hooks/`
 * with the `.json` extension stripped, so nested files keep their
 * intermediate directories (e.g. "security/writes").
 *
 * Throws loudly if the tree response is `truncated` (the repo has more
 * than ~1000 entries) rather than silently returning a partial list —
 * a hooks repo should never hit this, and a partial drop would be a
 * silent-failure bug of exactly the kind this function exists to avoid.
 */
export async function fetchHookFiles(
  repo: string,
  ref = "main",
): Promise<HookFile[]> {
  const branch = ref.replace(/^refs\/heads\//, "");
  const url = `${API_BASE}/repos/${repo}/git/trees/${branch}?recursive=1`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for ${url}`);
  }

  const body = (await res.json()) as {
    tree: Array<{ path: string; type: string; sha: string }>;
    truncated?: boolean;
  };

  if (body.truncated) {
    throw new Error(
      `Hook tree for ${repo} is too large for a single API response ` +
        `(truncated). Reorganise so hooks/ has fewer than ~1000 files.`,
    );
  }

  return body.tree
    .filter(
      (item) =>
        item.type === "blob" &&
        item.path.startsWith("hooks/") &&
        item.path.endsWith(".json"),
    )
    .map((item) => ({
      name: item.path.slice("hooks/".length).replace(/\.json$/, ""),
      path: item.path,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Fetch and parse a single hooks/*.json file from a GitHub repo.
 *
 * Returns only schema-valid Hooks and Presets.
 */
export async function fetchHookFile(
  repo: string,
  path: string,
  ref = "main",
): Promise<HookEntries> {
  // Encode each path segment separately so slashes are preserved —
  // `encodeURIComponent(path)` would turn "hooks/security/writes.json"
  // into "hooks%2Fsecurity%2Fwrites.json", which the Contents API does
  // not reliably accept for nested paths.
  const urlPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${API_BASE}/repos/${repo}/contents/${urlPath}?ref=${ref}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for ${url}`);
  }

  const item = (await res.json()) as GitHubFileItem;

  if (item.type !== "file" || !item.content) {
    throw new Error("Not a file or missing content");
  }

  const raw = Buffer.from(item.content, "base64").toString("utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse JSON from GitHub file");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("File content is not a JSON object");
  }

  const entries: HookEntries = {};
  for (const [name, def] of Object.entries(parsed as Record<string, unknown>)) {
    const kind = validateHookEntry(def);
    if (isValidEntryName(name) && kind) entries[name] = def as PersistedEntry;
  }

  return entries;
}

interface GitHubFileItem {
  type: string;
  content?: string;
}

// ---------------------------------------------------------------------------
// Repo-wide entry fetch (for orphaned detection)
// ---------------------------------------------------------------------------

/**
 * Session cache of `fetchRepoEntries` promises, keyed by `repo@ref`.
 *
 * Caching the *promise* (not the result) means concurrent callers share one
 * fetch round, and the `/hooks` panel never re-fetches the same repo in a
 * session.  Rejections are evicted so a transient network failure is
 * retryable on the next open.
 */
const repoEntriesCache = new Map<string, Promise<Map<string, HookEntry>>>();

/**
 * Fetch every entry from every `hooks/*.json` file in a repo and return a
 * flat `name → HookEntry` map.
 *
 * One `fetchHookFiles` round (the tree) plus one `fetchHookFile` per file,
 * all in parallel.  Used by the `/hooks` panel to detect orphaned hooks
 * (installed names missing from the repo).  Results are session-cached per
 * `repo@ref` so re-opening the panel doesn't re-fetch.
 *
 * On failure the cache entry is evicted (so the next call retries) and the
 * error propagates to the caller, which degrades to "no orphaned badges".
 */
export function fetchRepoEntries(
  repo: string,
  ref = "main",
): Promise<Map<string, HookEntry>> {
  const key = `${repo}@${ref}`;
  let cached = repoEntriesCache.get(key);
  if (cached) return cached;

  cached = (async () => {
    const files = await fetchHookFiles(repo, ref);
    // Fetch concurrently, then merge in sorted file order. Mutating one map
    // from racing requests made duplicate-name resolution nondeterministic.
    const results = await Promise.all(
      files.map(async (file) => ({
        file,
        entries: await fetchHookFile(repo, file.path, ref),
      })),
    );
    const entries = new Map<string, HookEntry>();
    const origins = new Map<string, string>();
    for (const result of results) {
      for (const [name, entry] of Object.entries(result.entries)) {
        const previous = origins.get(name);
        if (previous) {
          throw new Error(
            `Duplicate hook name "${name}" in ${repo}: ${previous} and ${result.file.path}`,
          );
        }
        origins.set(name, result.file.path);
        entries.set(name, entry);
      }
    }
    return entries;
  })().catch((err) => {
    // Evict on failure so the next open retries instead of caching the error.
    repoEntriesCache.delete(key);
    throw err;
  });

  repoEntriesCache.set(key, cached);
  return cached;
}

/** Clear the `fetchRepoEntries` session cache (test helper). */
export function clearRepoEntriesCache(): void {
  repoEntriesCache.clear();
}

// ---------------------------------------------------------------------------
// Outdated detection (pure: no I/O)
// ---------------------------------------------------------------------------

/**
 * Minimal shape needed to compute a normalized Hook content signature.
 * Repository entries may omit shell; catalog hooks always provide it.
 */
interface SignableHook {
  description: string;
  event: string;
  shell?: string;
  action?: Action;
  filter?: Record<string, unknown>;
  when?: string;
}

/** Minimal shape needed to compute a preset's content signature. */
interface SignablePreset {
  description: string;
  preset: readonly string[];
}

/** Union type for content signatures of every catalog entry kind. */
export type SignableEntry = SignableHook | SignablePreset;

/**
 * Canonical content signature of an entry, used for outdated detection.
 *
 * Excludes `default` (a local-only preference, never a repo-driven change)
 * and includes only repo-driven fields. Hooks include `description`,
 * `event`, canonical `shell`, optional owned `action`, `filter`, and `when`;
 * presets include `description` and `preset`.
 *
 * Omitted optional fields are dropped entirely (never emitted as `undefined`)
 * so a deep-equal of two signatures treats "absent" on both sides as equal.
 *
 * Keys are emitted in a stable order so callers that want byte-stable output
 * (e.g. `JSON.stringify`) get it, though the comparison itself uses
 * key-order-independent `isDeepStrictEqual`.
 *
 * **`preset` array order is significant** — a repo reordering refs (semantically
 * a no-op) flags "outdated"; matches on-disk order.
 */
export function entryContentSignature(
  entry: SignableEntry,
): Record<string, unknown> {
  if ("preset" in entry) {
    // Preset branch
    return {
      description: entry.description,
      preset: entry.preset,
    };
  }
  // Executable-entry branch
  const sig: Record<string, unknown> = {
    description: entry.description,
    event: entry.event,
    shell: entry.shell ?? "true",
  };
  if (entry.action !== undefined) sig.action = entry.action;
  if (entry.filter !== undefined) sig.filter = entry.filter;
  if (entry.when !== undefined) sig.when = entry.when;
  return sig;
}

/**
 * `true` when the installed entry's repo-driven content differs from the
 * repo entry (i.e. the installed entry is outdated).
 *
 * Compares content signatures (which exclude `default`), so a `default`-only
 * difference is never an update.  Uses `isDeepStrictEqual` so filter objects
 * match regardless of key order. For presets, compares the `preset` array
 * (order-sensitive).
 */
export function entryNeedsUpdate(
  installed: SignableEntry,
  repo: SignableEntry,
): boolean {
  return !isDeepStrictEqual(
    entryContentSignature(installed),
    entryContentSignature(repo),
  );
}

/** Tri-state classification of a repo entry against the local install. */
export type EntryState = "not-installed" | "outdated" | "installed";

/**
 * Classify a repo entry against the installed entry of the same name.
 *
 * - `undefined` installed → `"not-installed"` (name absent locally).
 * - installed, content differs → `"outdated"` (update available).
 * - installed, content equal → `"installed"` (up to date).
 *
 * `default` is excluded from the comparison (a local toggle is never an
 * update).  Pure: the caller resolves the installed entry by name and
 * passes it in, so this function knows nothing about files or maps.
 *
 * Works for both hooks and presets via the `SignableEntry` union.
 */
export function classifyEntry(
  repoEntry: SignableEntry,
  installed: SignableEntry | undefined,
): EntryState {
  if (installed === undefined) return "not-installed";
  return entryNeedsUpdate(installed, repoEntry) ? "outdated" : "installed";
}

// ---------------------------------------------------------------------------
// Wizard helpers (pure: no I/O, no UI calls)
// ---------------------------------------------------------------------------

/** Sentinel value for the "Add repo…" action item in the repo picker. */
export const REPO_ADD_ACTION = "__add__";

/**
 * Default repo always shown first in the repo picker (marked "(default)")
 * so it's a one-key pick and the initial selection. Overridable via the
 * `PI_HOOK_DEFAULT_REPO` env var.
 */
export const DEFAULT_REPO =
  process.env.PI_HOOK_DEFAULT_REPO ?? "meffmadd/HooKit-rules";

/**
 * Build the items list for the repo picker.
 *
 * The default repo is always shown first (marked "(default)"), so it's the
 * initial selection and a one-key pick; other configured repos follow in
 * their declared order, then a trailing "Add repo…" action item. If the
 * default repo is also in `repos`, it appears once (at the top).
 */
export function buildRepoPickerItems(repos: string[]): SelectItem[] {
  const items: SelectItem[] = [
    { value: DEFAULT_REPO, label: `${DEFAULT_REPO} (default)` },
  ];
  const seen = new Set([DEFAULT_REPO]);
  for (const r of repos) {
    if (seen.has(r)) continue;
    items.push({ value: r, label: r });
    seen.add(r);
  }
  items.push({ value: REPO_ADD_ACTION, label: "Add repo…" });
  return items;
}
