/**
 * Repository adapter and install-picker helper tests.
 */

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";

import {
  fetchHookFiles,
  fetchHookFile,
  fetchRepoEntries,
  clearRepoEntriesCache,
  buildRepoPickerItems,
  REPO_ADD_ACTION,
  DEFAULT_REPO,
  type HookEntries,
  type HookFile,
} from "../hookit/installer.js";

// ── Helpers ───────────────────────────────────────────────────────

/** Build a minimal mock fetch Response with given JSON body and status. */
function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : status === 403 ? "Forbidden" : "OK",
    json: async () => body,
  } as Response;
}

/**
 * Base64-encode a JSON-serialisable value, returning an object shaped
 * like the GitHub individual file endpoint response.
 */
function mockFileResponse(
  name: string,
  path: string,
  content: unknown,
): unknown {
  const json = JSON.stringify(content);
  const b64 = Buffer.from(json).toString("base64");
  return {
    name,
    path,
    sha: "abc123",
    size: json.length,
    type: "file",
    content: b64,
    encoding: "base64",
  };
}

/** Real API response shape for a Git Trees API blob entry. */
function mockTreeBlob(path: string, sha = "abc123"): unknown {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha,
    size: 100,
    url: `https://api.github.com/repos/meffmadd/HooKit/git/blobs/${sha}`,
  };
}

/** Real API response shape for a Git Trees API tree (directory) entry. */
function mockTreeDir(path: string, sha = "dir-sha"): unknown {
  return {
    path,
    mode: "040000",
    type: "tree",
    sha,
    url: `https://api.github.com/repos/meffmadd/HooKit/git/trees/${sha}`,
  };
}

/**
 * Mock `globalThis.fetch` to serve a single recursive-trees response.
 * `fetchHookFiles` now does one call (branch name passed directly as
 * the tree SHA), so routing is by URL substring.
 */
function mockTreesFetch(
  tree: unknown[],
  opts: {
    truncated?: boolean;
    status?: number;
  } = {},
): void {
  mock.method(globalThis, "fetch", (url: string) => {
    if (url.includes("/git/trees/")) {
      if (opts.status) return mockJsonResponse({}, opts.status);
      return mockJsonResponse({
        sha: "tree-sha",
        url,
        tree,
        truncated: opts.truncated ?? false,
      });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
}

// ═══════════════════════════════════════════════════════════════════
// fetchHookFiles
// ═══════════════════════════════════════════════════════════════════

describe("fetchHookFiles", () => {
  type PassCase = { label: string; tree: unknown[]; expected: HookFile[] };

  const passCases: PassCase[] = [
    {
      label: "returns only .json blobs under hooks/ and strips hooks/ prefix + .json",
      tree: [
        mockTreeBlob("hooks/defaults.json"),
        mockTreeBlob("hooks/security.json"),
      ],
      expected: [
        { name: "defaults", path: "hooks/defaults.json" },
        { name: "security", path: "hooks/security.json" },
      ],
    },
    {
      label: "filters out non-.json files under hooks/",
      tree: [
        mockTreeBlob("hooks/defaults.json"),
        mockTreeBlob("hooks/README.md"),
      ],
      expected: [{ name: "defaults", path: "hooks/defaults.json" }],
    },
    {
      label: "filters out tree (directory) entries",
      tree: [
        mockTreeBlob("hooks/defaults.json"),
        mockTreeDir("hooks/subdir"),
      ],
      expected: [{ name: "defaults", path: "hooks/defaults.json" }],
    },
    {
      label: "filters out files outside hooks/ (tree is repo-wide)",
      tree: [
        mockTreeBlob("hooks/defaults.json"),
        mockTreeBlob("README.md"),
        mockTreeBlob("src/index.ts"),
      ],
      expected: [{ name: "defaults", path: "hooks/defaults.json" }],
    },
    {
      label: "returns [] for empty tree",
      tree: [],
      expected: [],
    },
    {
      label: "nested subdirectories: strips hooks/ prefix, preserves intermediate dirs in name",
      tree: [
        mockTreeBlob("hooks/defaults.json"),
        mockTreeBlob("hooks/security/writes.json"),
        mockTreeBlob("hooks/security/reads.json"),
        mockTreeBlob("hooks/git/no-force-push.json"),
        mockTreeBlob("hooks/experimental/drafts/trial.json"),
        // Directory entries and non-Hook files are present too, confirming they are dropped.
        mockTreeDir("hooks/security"),
        mockTreeDir("hooks/git"),
        mockTreeBlob("package.json"),
      ],
      expected: [
        { name: "defaults", path: "hooks/defaults.json" },
        { name: "experimental/drafts/trial", path: "hooks/experimental/drafts/trial.json" },
        { name: "git/no-force-push", path: "hooks/git/no-force-push.json" },
        { name: "security/reads", path: "hooks/security/reads.json" },
        { name: "security/writes", path: "hooks/security/writes.json" },
      ],
    },
  ];

  for (const { label, tree, expected } of passCases) {
    it(label, async () => {
      mockTreesFetch(tree);
      assert.deepStrictEqual(
        await fetchHookFiles("meffmadd/HooKit"),
        expected,
      );
    });
  }

  // ── Throws cases ────────────────────────────────────────────────

  type ThrowsCase = {
    label: string;
    tree?: unknown[];
    status?: number;
    truncated?: boolean;
    errorPattern: RegExp;
  };

  const throwsCases: ThrowsCase[] = [
    {
      label: "throws on 404 from trees",
      tree: [],
      status: 404,
      errorPattern: /404/,
    },
    {
      label: "throws when tree is truncated (too many entries)",
      tree: [mockTreeBlob("hooks/a.json")],
      truncated: true,
      errorPattern: /truncated/i,
    },
  ];

  for (const { label, tree, status, truncated, errorPattern } of throwsCases) {
    it(label, async () => {
      mockTreesFetch(tree ?? [], { status, truncated });
      await assert.rejects(
        () => fetchHookFiles("meffmadd/HooKit"),
        errorPattern,
      );
    });
  }

  // ── Network error (mock throws instead of returning a response) ─

  it("throws on network error", async () => {
    mock.method(globalThis, "fetch", () => {
      throw new Error("connect ECONNREFUSED");
    });
    await assert.rejects(
      () => fetchHookFiles("meffmadd/HooKit"),
      /ECONNREFUSED/,
    );
  });

  // ── URL shape & ref normalisation ───────────────────────────────

  it("calls git/trees/{branch}?recursive=1 directly (no ref-resolve hop)", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse({ tree: [], truncated: false });
    });
    await fetchHookFiles("meffmadd/HooKit", "develop");
    assert.strictEqual(calls.length, 1, "exactly one fetch call");
    assert.match(calls[0]!, /\/git\/trees\/develop\?recursive=1$/, calls[0]!);
  });

  it("strips a refs/heads/ prefix from the ref before calling git/trees/", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse({ tree: [], truncated: false });
    });
    await fetchHookFiles("meffmadd/HooKit", "refs/heads/main");
    assert.match(calls[0]!, /\/git\/trees\/main\?recursive=1$/, calls[0]!);
    assert.doesNotMatch(calls[0]!, /refs\/heads\/refs\/heads/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// fetchHookFile
// ═══════════════════════════════════════════════════════════════════

describe("fetchHookFile", () => {
  type PassCase = { label: string; content: unknown; expected: HookEntries };

  const passCases: PassCase[] = [
    {
      label: "parses a valid Hook file with multiple entries",
      content: {
        "block-write": {
          description: "Blocks all write calls.",
          event: "tool_call",
          filter: { toolName: "write" },
          shell: "false",
        },
        "no-rm-rf": {
          description: "Blocks rm -rf in bash.",
          event: "tool_call",
          shell: "grep rm",
        },
        notify: {
          description: "Notify another extension.",
          event: "hook_result",
          action: {
            type: "emit-custom-event",
            outcome: "pass",
            name: "example:guard-result",
            data: { installed: true },
          },
        },
      },
      expected: {
        "block-write": {
          description: "Blocks all write calls.",
          event: "tool_call",
          filter: { toolName: "write" },
          shell: "false",
        },
        "no-rm-rf": {
          description: "Blocks rm -rf in bash.",
          event: "tool_call",
          shell: "grep rm",
        },
        notify: {
          description: "Notify another extension.",
          event: "hook_result",
          action: {
            type: "emit-custom-event",
            outcome: "pass",
            name: "example:guard-result",
            data: { installed: true },
          },
        },
      },
    },
    {
      label: "skips entries missing description",
      content: {
        valid: { description: "Valid entry.", event: "tool_call", shell: "true" },
        "no-desc": { event: "tool_call", shell: "false" },
      },
      expected: {
        valid: { description: "Valid entry.", event: "tool_call", shell: "true" },
      },
    },
    {
      label: "skips entries missing event",
      content: {
        "no-event": { description: "Missing event.", shell: "false" },
        valid: { description: "Valid.", event: "tool_call", shell: "true" },
      },
      expected: {
        valid: { description: "Valid.", event: "tool_call", shell: "true" },
      },
    },
    {
      label: "skips entries missing shell",
      content: {
        "no-shell": { description: "Missing shell.", event: "tool_call" },
        valid: { description: "Valid.", event: "tool_call", shell: "true" },
      },
      expected: {
        valid: { description: "Valid.", event: "tool_call", shell: "true" },
      },
    },
    {
      label: "skips non-object entries (null, string)",
      content: {
        nil: null,
        str: "just a string",
        valid: { description: "Valid.", event: "tool_call", shell: "true" },
      },
      expected: {
        valid: { description: "Valid.", event: "tool_call", shell: "true" },
      },
    },
    {
      label: "skips entries whose names cannot form Catalog identities",
      content: {
        "": { description: "Empty name.", event: "tool_call", shell: "true" },
        "nested/name": { description: "Slash name.", event: "tool_call", shell: "true" },
        "nul\x00name": { description: "NUL name.", event: "tool_call", shell: "true" },
        valid: { description: "Valid.", event: "tool_call", shell: "true" },
      },
      expected: {
        valid: { description: "Valid.", event: "tool_call", shell: "true" },
      },
    },
  ];

  for (const { label, content, expected } of passCases) {
    it(label, async () => {
      mock.method(globalThis, "fetch", () =>
        mockJsonResponse(
          mockFileResponse("defaults.json", "hooks/defaults.json", content),
        ),
      );
      assert.deepStrictEqual(
        await fetchHookFile("meffmadd/HooKit", "hooks/defaults.json"),
        expected,
      );
    });
  }

  // ── Nested-path & URL encoding (per-segment, slashes preserved) ─

  it("fetches a nested path with per-segment URL encoding (slashes preserved)", async () => {
    const calls: string[] = [];
    const content = { x: { description: "d", event: "tool_call", shell: "true" } };
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse(
        mockFileResponse("writes.json", "hooks/security/writes.json", content),
      );
    });
    const result = await fetchHookFile(
      "meffmadd/HooKit",
      "hooks/security/writes.json",
    );
    assert.ok(calls[0], "fetch was called");
    // Slashes must be preserved in the contents path.
    assert.match(calls[0]!, /\/contents\/hooks\/security\/writes\.json/, calls[0]!);
    assert.doesNotMatch(calls[0]!, /%2F/, `slash must not be encoded: ${calls[0]}`);
    assert.deepStrictEqual(result, content);
  });

  it("encodes special characters within a single path segment", async () => {
    const calls: string[] = [];
    const content = { x: { description: "d", event: "tool_call", shell: "true" } };
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse(
        mockFileResponse("my hooks.json", "hooks/my hooks/x.json", content),
      );
    });
    await fetchHookFile("meffmadd/HooKit", "hooks/my hooks/x.json");
    // Space within a segment is encoded, slashes between segments are not.
    assert.match(calls[0]!, /\/contents\/hooks\/my%20hooks\/x\.json/, calls[0]!);
  });

  // ── Throws cases ────────────────────────────────────────────────

  type ThrowsCase = { label: string; response: unknown; errorPattern: RegExp };

  const throwsCases: ThrowsCase[] = [
    {
      label: "throws when response has no content (not a file)",
      response: mockJsonResponse({ type: "dir", name: "hooks", path: "hooks" }),
      errorPattern: /Not a file/,
    },
    {
      label: "throws on non-JSON content",
      response: mockJsonResponse({
        type: "file",
        name: "defaults.json",
        path: "hooks/defaults.json",
        content: Buffer.from("not valid json!!!").toString("base64"),
        encoding: "base64",
      }),
      errorPattern: /JSON/,
    },
    {
      label: "throws when content is a JSON array",
      response: mockJsonResponse(
        mockFileResponse("defaults.json", "hooks/defaults.json", [1, 2, 3]),
      ),
      errorPattern: /not a JSON object/,
    },
    {
      label: "throws on HTTP error",
      response: mockJsonResponse({}, 500),
      errorPattern: /500/,
    },
  ];

  for (const { label, response, errorPattern } of throwsCases) {
    it(label, async () => {
      mock.method(globalThis, "fetch", () => response as Response);
      await assert.rejects(
        () => fetchHookFile("meffmadd/HooKit", "hooks/defaults.json"),
        errorPattern,
      );
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// fetchRepoEntries
// ═══════════════════════════════════════════════════════════════════

describe("fetchRepoEntries", () => {
  // Each test gets a fresh cache so cached results don't bleed across tests.
  before(() => clearRepoEntriesCache());
  after(() => clearRepoEntriesCache());

  /**
   * Mock `fetch` so the trees call returns the given blob paths, and each
   * contents call returns the given file contents (keyed by path).
   */
  function mockMultiFileFetch(
    treeBlobs: string[],
    fileContents: Record<string, unknown>,
  ): void {
    mock.method(globalThis, "fetch", (url: string) => {
      if (url.includes("/git/trees/")) {
        return mockJsonResponse({
          sha: "tree-sha",
          url,
          tree: treeBlobs.map((p) => mockTreeBlob(p)),
          truncated: false,
        });
      }
      // contents call — match by the encoded path in the URL.
      for (const [path, content] of Object.entries(fileContents)) {
        if (url.includes(path.split("/").map(encodeURIComponent).join("/"))) {
          return mockJsonResponse(
            mockFileResponse(path.split("/").pop()!, path, content),
          );
        }
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
  }

  it("flattens all entries from all files into a name→entry map", async () => {
    clearRepoEntriesCache();
    mockMultiFileFetch(
      ["hooks/defaults.json", "hooks/security/writes.json"],
      {
        "hooks/defaults.json": {
          "hook-a": { description: "A.", event: "tool_call", shell: "false" },
          "hook-b": { description: "B.", event: "tool_call", shell: "true" },
        },
        "hooks/security/writes.json": {
          "block-write": {
            description: "Blocks writes.",
            event: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
          },
        },
      },
    );

    const result = await fetchRepoEntries("some/repo");
    assert.strictEqual(result.size, 3);
    assert.deepStrictEqual(result.get("hook-a"), {
      description: "A.",
      event: "tool_call",
      shell: "false",
    });
    assert.deepStrictEqual(result.get("block-write"), {
      description: "Blocks writes.",
      event: "tool_call",
      filter: { toolName: "write" },
      shell: "false",
    });
  });

  it("rejects duplicate names across files deterministically", async () => {
    clearRepoEntriesCache();
    mockMultiFileFetch(
      ["hooks/b.json", "hooks/a.json"],
      {
        "hooks/a.json": {
          duplicate: { description: "A.", event: "tool_call", shell: "true" },
        },
        "hooks/b.json": {
          duplicate: { description: "B.", event: "tool_call", shell: "false" },
        },
      },
    );

    await assert.rejects(
      () => fetchRepoEntries("duplicate/repo"),
      /Duplicate hook name "duplicate".*hooks\/a\.json.*hooks\/b\.json/,
    );
  });

  it("returns an empty map for a repo with no hook files", async () => {
    clearRepoEntriesCache();
    mockTreesFetch([]);
    const result = await fetchRepoEntries("empty/repo");
    assert.strictEqual(result.size, 0);
  });

  it("caches the result across calls (one fetch round per repo@ref)", async () => {
    clearRepoEntriesCache();
    let callCount = 0;
    mock.method(globalThis, "fetch", (url: string) => {
      callCount++;
      if (url.includes("/git/trees/")) {
        return mockJsonResponse({ tree: [], truncated: false });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    await fetchRepoEntries("cached/repo");
    const firstRoundCalls = callCount;
    await fetchRepoEntries("cached/repo"); // should hit cache
    assert.strictEqual(callCount, firstRoundCalls, "second call makes no fetches");
  });

  it("does NOT cache failures (retryable on the next call)", async () => {
    clearRepoEntriesCache();
    let callCount = 0;
    mock.method(globalThis, "fetch", () => {
      callCount++;
      throw new Error("connect ECONNREFUSED");
    });

    await assert.rejects(() => fetchRepoEntries("fail/repo"), /ECONNREFUSED/);
    await assert.rejects(() => fetchRepoEntries("fail/repo"), /ECONNREFUSED/);
    assert.ok(callCount > 1, "second call re-fetched (failure was not cached)");
  });

  it("skips invalid entries (missing description/event/shell)", async () => {
    clearRepoEntriesCache();
    mockMultiFileFetch(["hooks/defaults.json"], {
      "hooks/defaults.json": {
        valid: { description: "V.", event: "tool_call", shell: "true" },
        "no-desc": { event: "tool_call", shell: "false" },
        "no-shell": { description: "D.", event: "tool_call" },
        nil: null,
      },
    });
    const result = await fetchRepoEntries("mixed/repo");
    assert.deepStrictEqual([...result.keys()], ["valid"]);
  });
});

// ── Wizard helpers (pure) ─────────────────────────────────────────

describe("REPO_ADD_ACTION", () => {
  it("is the sentinel string '__add__'", () => {
    assert.equal(REPO_ADD_ACTION, "__add__");
  });
});

describe("buildRepoPickerItems", () => {
  const defaultItem = {
    value: DEFAULT_REPO,
    label: `${DEFAULT_REPO} (default)`,
  };

  it("always shows the default repo first, even with no repos configured", () => {
    assert.deepEqual(buildRepoPickerItems([]), [
      defaultItem,
      { value: REPO_ADD_ACTION, label: "Add repo…" },
    ]);
  });

  it("shows the default repo first, then configured repos, then Add repo", () => {
    assert.deepEqual(buildRepoPickerItems(["a/b", "c/d"]), [
      defaultItem,
      { value: "a/b", label: "a/b" },
      { value: "c/d", label: "c/d" },
      { value: REPO_ADD_ACTION, label: "Add repo…" },
    ]);
  });

  it("marks the default repo with (default) and does not duplicate it", () => {
    const result = buildRepoPickerItems([DEFAULT_REPO, "a/b"]);
    assert.deepEqual(result, [
      defaultItem,
      { value: "a/b", label: "a/b" },
      { value: REPO_ADD_ACTION, label: "Add repo…" },
    ]);
  });

  it("preserves the order of non-default input repos", () => {
    const repos = ["z/y", "a/b", "m/n"];
    const result = buildRepoPickerItems(repos);
    // Strip the leading default item and trailing Add repo item.
    assert.deepEqual(
      result.slice(1, result.length - 1).map((r) => r.value),
      repos,
    );
  });

  it("always has exactly one default item and one Add repo item", () => {
    assert.equal(buildRepoPickerItems([]).length, 2);
    assert.equal(buildRepoPickerItems(["a/b"]).length, 3);
    assert.equal(buildRepoPickerItems(["a/b", "c/d", "e/f"]).length, 5);
    // Default repo is not duplicated when also configured.
    assert.equal(buildRepoPickerItems([DEFAULT_REPO, "a/b"]).length, 3);
  });

  it("places the Add repo item last in the list", () => {
    const result = buildRepoPickerItems(["a/b", "c/d"]);
    assert.equal(result[result.length - 1]!.value, REPO_ADD_ACTION);
  });
});

describe("DEFAULT_REPO", () => {
  it("defaults to the first-party Core Hook Source", () => {
    assert.equal(
      DEFAULT_REPO,
      process.env.PI_HOOK_DEFAULT_REPO ?? "meffmadd/HooKit",
    );
  });
});
