/**
 * Build-level documentation smoke assertion.
 *
 * Runs the real static documentation build (the publication gate) and
 * asserts the expected Getting Started, Reference, and Concepts destinations are
 * published and the visible 🦉 HooKit brand identity is present. This is
 * intentionally one high-level check rather than one brittle assertion
 * per heading or sentence.
 *
 * Usage: npm test
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname!, "..");
const distDir = join(repoRoot, "site", "dist");
const astroCli = join(repoRoot, "node_modules", "astro", "bin", "astro.mjs");

/** Route path → expected built artifact (static site emits index.html). */
const EXPECTED_ROUTES: Record<string, string> = {
  "/": "index.html",
  // Getting Started
  "/getting-started/": "getting-started/index.html",
  "/getting-started/installation/": "getting-started/installation/index.html",
  "/getting-started/first-hook/": "getting-started/first-hook/index.html",
  "/getting-started/library/": "getting-started/library/index.html",
  // Reference
  "/reference/configuration/": "reference/configuration/index.html",
  "/reference/hooks-panel/": "reference/hooks-panel/index.html",
  "/reference/events/": "reference/events/index.html",
  "/reference/filter/": "reference/filter/index.html",
  "/reference/action/": "reference/action/index.html",
  "/reference/shell-environment/": "reference/shell-environment/index.html",
  "/reference/presets-sources/": "reference/presets-sources/index.html",
  "/reference/hook-result/": "reference/hook-result/index.html",
  "/reference/execution-report/": "reference/execution-report/index.html",
  // Concepts
  "/concepts/overview/": "concepts/overview/index.html",
  "/concepts/evaluation/": "concepts/evaluation/index.html",
  "/concepts/composition/": "concepts/composition/index.html",
  "/concepts/security/": "concepts/security/index.html",
};

describe("documentation site build", () => {
  before(() => {
    execFileSync(process.execPath, [astroCli, "build", "--root", join(repoRoot, "site")], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  });

  it("publishes every Getting Started, Reference, and Concepts destination", () => {
    for (const [route, artifact] of Object.entries(EXPECTED_ROUTES)) {
      const file = join(distDir, artifact);
      assert.ok(
        existsSync(file),
        `route ${route} should publish ${artifact}`,
      );
    }
  });

  it("shows the 🦉 HooKit brand identity on the landing page", () => {
    const landing = readFileSync(join(distDir, "index.html"), "utf-8");
    assert.match(landing, /🦉\s*HooKit/, "landing page should show the owl brand with the HooKit name");
  });

  it("links Getting Started, Reference, and Concepts from the landing page", () => {
    const landing = readFileSync(join(distDir, "index.html"), "utf-8");
    for (const link of ["/getting-started", "/reference", "/concepts"]) {
      assert.ok(
        landing.includes(`href="${link}`),
        `landing page should route to ${link}`,
      );
    }
  });
});
