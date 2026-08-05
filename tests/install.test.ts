/**
 * Repository adapter and install-picker helper tests.
 */

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";

import {
  fetchRuleFiles,
  fetchRuleFile,
  fetchRepoEntries,
  clearRepoEntriesCache,
  buildRepoPickerItems,
  REPO_ADD_ACTION,
  DEFAULT_REPO,
  type RuleEntries,
  type RuleFile,
} from "../pi-assert/installer.js";

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
    url: `https://api.github.com/repos/meffmadd/pi-assert-rules/git/blobs/${sha}`,
  };
}

/** Real API response shape for a Git Trees API tree (directory) entry. */
function mockTreeDir(path: string, sha = "dir-sha"): unknown {
  return {
    path,
    mode: "040000",
    type: "tree",
    sha,
    url: `https://api.github.com/repos/meffmadd/pi-assert-rules/git/trees/${sha}`,
  };
}

/**
 * Mock `globalThis.fetch` to serve a single recursive-trees response.
 * `fetchRuleFiles` now does one call (branch name passed directly as
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
// fetchRuleFiles
// ═══════════════════════════════════════════════════════════════════

describe("fetchRuleFiles", () => {
  type PassCase = { label: string; tree: unknown[]; expected: RuleFile[] };

  const passCases: PassCase[] = [
    {
      label: "returns only .json blobs under rules/ and strips rules/ prefix + .json",
      tree: [
        mockTreeBlob("rules/defaults.json"),
        mockTreeBlob("rules/security.json"),
      ],
      expected: [
        { name: "defaults", path: "rules/defaults.json", sha: "abc123" },
        { name: "security", path: "rules/security.json", sha: "abc123" },
      ],
    },
    {
      label: "filters out non-.json files under rules/",
      tree: [
        mockTreeBlob("rules/defaults.json"),
        mockTreeBlob("rules/README.md"),
      ],
      expected: [{ name: "defaults", path: "rules/defaults.json", sha: "abc123" }],
    },
    {
      label: "filters out tree (directory) entries",
      tree: [
        mockTreeBlob("rules/defaults.json"),
        mockTreeDir("rules/subdir"),
      ],
      expected: [{ name: "defaults", path: "rules/defaults.json", sha: "abc123" }],
    },
    {
      label: "filters out files outside rules/ (tree is repo-wide)",
      tree: [
        mockTreeBlob("rules/defaults.json"),
        mockTreeBlob("README.md"),
        mockTreeBlob("src/index.ts"),
      ],
      expected: [{ name: "defaults", path: "rules/defaults.json", sha: "abc123" }],
    },
    {
      label: "returns [] for empty tree",
      tree: [],
      expected: [],
    },
    {
      label: "nested subdirectories: strips rules/ prefix, preserves intermediate dirs in name",
      tree: [
        mockTreeBlob("rules/defaults.json"),
        mockTreeBlob("rules/security/writes.json"),
        mockTreeBlob("rules/security/reads.json"),
        mockTreeBlob("rules/git/no-force-push.json"),
        mockTreeBlob("rules/experimental/drafts/trial.json"),
        // dir entries and non-rules files are present too, to confirm they're dropped
        mockTreeDir("rules/security"),
        mockTreeDir("rules/git"),
        mockTreeBlob("package.json"),
      ],
      expected: [
        { name: "defaults", path: "rules/defaults.json", sha: "abc123" },
        { name: "experimental/drafts/trial", path: "rules/experimental/drafts/trial.json", sha: "abc123" },
        { name: "git/no-force-push", path: "rules/git/no-force-push.json", sha: "abc123" },
        { name: "security/reads", path: "rules/security/reads.json", sha: "abc123" },
        { name: "security/writes", path: "rules/security/writes.json", sha: "abc123" },
      ],
    },
  ];

  for (const { label, tree, expected } of passCases) {
    it(label, async () => {
      mockTreesFetch(tree);
      assert.deepStrictEqual(
        await fetchRuleFiles("meffmadd/pi-assert-rules"),
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
      tree: [mockTreeBlob("rules/a.json")],
      truncated: true,
      errorPattern: /truncated/i,
    },
  ];

  for (const { label, tree, status, truncated, errorPattern } of throwsCases) {
    it(label, async () => {
      mockTreesFetch(tree ?? [], { status, truncated });
      await assert.rejects(
        () => fetchRuleFiles("meffmadd/pi-assert-rules"),
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
      () => fetchRuleFiles("meffmadd/pi-assert-rules"),
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
    await fetchRuleFiles("meffmadd/pi-assert-rules", "develop");
    assert.strictEqual(calls.length, 1, "exactly one fetch call");
    assert.match(calls[0]!, /\/git\/trees\/develop\?recursive=1$/, calls[0]!);
  });

  it("strips a refs/heads/ prefix from the ref before calling git/trees/", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse({ tree: [], truncated: false });
    });
    await fetchRuleFiles("meffmadd/pi-assert-rules", "refs/heads/main");
    assert.match(calls[0]!, /\/git\/trees\/main\?recursive=1$/, calls[0]!);
    assert.doesNotMatch(calls[0]!, /refs\/heads\/refs\/heads/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// fetchRuleFile
// ═══════════════════════════════════════════════════════════════════

describe("fetchRuleFile", () => {
  type PassCase = { label: string; content: unknown; expected: RuleEntries };

  const passCases: PassCase[] = [
    {
      label: "parses a valid rules file with multiple entries",
      content: {
        "block-write": {
          description: "Blocks all write calls.",
          hook: "tool_call",
          filter: { toolName: "write" },
          shell: "false",
        },
        "no-rm-rf": {
          description: "Blocks rm -rf in bash.",
          hook: "tool_call",
          shell: "grep rm",
        },
        notify: {
          description: "Notify another extension.",
          hook: "assert_result",
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
          hook: "tool_call",
          filter: { toolName: "write" },
          shell: "false",
        },
        "no-rm-rf": {
          description: "Blocks rm -rf in bash.",
          hook: "tool_call",
          shell: "grep rm",
        },
        notify: {
          description: "Notify another extension.",
          hook: "assert_result",
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
        valid: { description: "Valid entry.", hook: "tool_call", shell: "true" },
        "no-desc": { hook: "tool_call", shell: "false" },
      },
      expected: {
        valid: { description: "Valid entry.", hook: "tool_call", shell: "true" },
      },
    },
    {
      label: "skips entries missing hook",
      content: {
        "no-hook": { description: "Missing hook.", shell: "false" },
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
      expected: {
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
    },
    {
      label: "skips entries missing shell",
      content: {
        "no-shell": { description: "Missing shell.", hook: "tool_call" },
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
      expected: {
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
    },
    {
      label: "skips non-object entries (null, string)",
      content: {
        nil: null,
        str: "just a string",
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
      expected: {
        valid: { description: "Valid.", hook: "tool_call", shell: "true" },
      },
    },
  ];

  for (const { label, content, expected } of passCases) {
    it(label, async () => {
      mock.method(globalThis, "fetch", () =>
        mockJsonResponse(
          mockFileResponse("defaults.json", "rules/defaults.json", content),
        ),
      );
      assert.deepStrictEqual(
        await fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
        expected,
      );
    });
  }

  // ── Nested-path & URL encoding (per-segment, slashes preserved) ─

  it("fetches a nested path with per-segment URL encoding (slashes preserved)", async () => {
    const calls: string[] = [];
    const content = { x: { description: "d", hook: "tool_call", shell: "true" } };
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse(
        mockFileResponse("writes.json", "rules/security/writes.json", content),
      );
    });
    const result = await fetchRuleFile(
      "meffmadd/pi-assert-rules",
      "rules/security/writes.json",
    );
    assert.ok(calls[0], "fetch was called");
    // Slashes must be preserved in the contents path.
    assert.match(calls[0]!, /\/contents\/rules\/security\/writes\.json/, calls[0]!);
    assert.doesNotMatch(calls[0]!, /%2F/, `slash must not be encoded: ${calls[0]}`);
    assert.deepStrictEqual(result, content);
  });

  it("encodes special characters within a single path segment", async () => {
    const calls: string[] = [];
    const content = { x: { description: "d", hook: "tool_call", shell: "true" } };
    mock.method(globalThis, "fetch", (url: string) => {
      calls.push(url);
      return mockJsonResponse(
        mockFileResponse("my rules.json", "rules/my rules/x.json", content),
      );
    });
    await fetchRuleFile("meffmadd/pi-assert-rules", "rules/my rules/x.json");
    // Space within a segment is encoded, slashes between segments are not.
    assert.match(calls[0]!, /\/contents\/rules\/my%20rules\/x\.json/, calls[0]!);
  });

  // ── Throws cases ────────────────────────────────────────────────

  type ThrowsCase = { label: string; response: unknown; errorPattern: RegExp };

  const throwsCases: ThrowsCase[] = [
    {
      label: "throws when response has no content (not a file)",
      response: mockJsonResponse({ type: "dir", name: "rules", path: "rules" }),
      errorPattern: /Not a file/,
    },
    {
      label: "throws on non-JSON content",
      response: mockJsonResponse({
        type: "file",
        name: "defaults.json",
        path: "rules/defaults.json",
        content: Buffer.from("not valid json!!!").toString("base64"),
        encoding: "base64",
      }),
      errorPattern: /JSON/,
    },
    {
      label: "throws when content is a JSON array",
      response: mockJsonResponse(
        mockFileResponse("defaults.json", "rules/defaults.json", [1, 2, 3]),
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
        () => fetchRuleFile("meffmadd/pi-assert-rules", "rules/defaults.json"),
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
      ["rules/defaults.json", "rules/security/writes.json"],
      {
        "rules/defaults.json": {
          "rule-a": { description: "A.", hook: "tool_call", shell: "false" },
          "rule-b": { description: "B.", hook: "tool_call", shell: "true" },
        },
        "rules/security/writes.json": {
          "block-write": {
            description: "Blocks writes.",
            hook: "tool_call",
            filter: { toolName: "write" },
            shell: "false",
          },
        },
      },
    );

    const result = await fetchRepoEntries("some/repo");
    assert.strictEqual(result.size, 3);
    assert.deepStrictEqual(result.get("rule-a"), {
      description: "A.",
      hook: "tool_call",
      shell: "false",
    });
    assert.deepStrictEqual(result.get("block-write"), {
      description: "Blocks writes.",
      hook: "tool_call",
      filter: { toolName: "write" },
      shell: "false",
    });
  });

  it("rejects duplicate names across files deterministically", async () => {
    clearRepoEntriesCache();
    mockMultiFileFetch(
      ["rules/b.json", "rules/a.json"],
      {
        "rules/a.json": {
          duplicate: { description: "A.", hook: "tool_call", shell: "true" },
        },
        "rules/b.json": {
          duplicate: { description: "B.", hook: "tool_call", shell: "false" },
        },
      },
    );

    await assert.rejects(
      () => fetchRepoEntries("duplicate/repo"),
      /Duplicate rule name "duplicate".*rules\/a\.json.*rules\/b\.json/,
    );
  });

  it("returns an empty map for a repo with no rule files", async () => {
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

  it("skips invalid entries (missing description/hook/shell)", async () => {
    clearRepoEntriesCache();
    mockMultiFileFetch(["rules/defaults.json"], {
      "rules/defaults.json": {
        valid: { description: "V.", hook: "tool_call", shell: "true" },
        "no-desc": { hook: "tool_call", shell: "false" },
        "no-shell": { description: "D.", hook: "tool_call" },
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
  it("is a non-empty owner/repo string", () => {
    assert.equal(typeof DEFAULT_REPO, "string");
    assert.match(DEFAULT_REPO, /^[^/]+\/[^/]+$/);
  });
});
