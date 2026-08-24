/**
 * Build-level documentation smoke assertion.
 *
 * Runs the real static documentation build (the publication gate) and
 * asserts the expected Getting Started, Reference, and Concepts destinations
 * are published, moved Reference URLs redirect, and the visible HooKit
 * brand identity (the owl avatar) is present. This stays at the route/build
 * level rather than asserting individual headings or sentences.
 *
 * Usage: npm test
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname!, "..");
const distDir = join(repoRoot, "site", "dist");
const astroCli = join(repoRoot, "node_modules", "astro", "bin", "astro.mjs");
const PAGES_ORIGIN = "https://meffmadd.github.io";
const PAGES_BASE_PATH = "/HooKit";
const pagesPath = (path: string): string => `${PAGES_BASE_PATH}${path}`;

const LEGACY_REFERENCE_REDIRECTS = [
  {
    route: "/reference/action/",
    artifact: "reference/action/index.html",
    target: `${PAGES_ORIGIN}${pagesPath("/reference/configuration/action")}`,
  },
  {
    route: "/reference/filter/",
    artifact: "reference/filter/index.html",
    target: `${PAGES_ORIGIN}${pagesPath("/reference/configuration/filter")}`,
  },
  {
    route: "/reference/hook-result/",
    artifact: "reference/hook-result/index.html",
    target: `${PAGES_ORIGIN}${pagesPath("/reference/events")}`,
  },
  {
    route: "/reference/configuration/hook-result/",
    artifact: "reference/configuration/hook-result/index.html",
    target: `${PAGES_ORIGIN}${pagesPath("/reference/events")}`,
  },
  {
    route: "/reference/presets-sources/",
    artifact: "reference/presets-sources/index.html",
    target: `${PAGES_ORIGIN}${pagesPath("/reference/configuration/presets-sources")}`,
  },
] as const;

/** Route path → expected built artifact (static site emits index.html). */
const EXPECTED_ROUTES: Record<string, string> = {
  "/": "index.html",
  "/api/search": "api/search",
  // Getting Started
  "/getting-started/": "getting-started/index.html",
  "/getting-started/installation/": "getting-started/installation/index.html",
  "/getting-started/first-hook/": "getting-started/first-hook/index.html",
  "/getting-started/library/": "getting-started/library/index.html",
  // Reference
  "/reference/configuration/": "reference/configuration/index.html",
  "/reference/configuration/schema/": "reference/configuration/schema/index.html",
  "/reference/configuration/repos/": "reference/configuration/repos/index.html",
  "/reference/configuration/description/": "reference/configuration/description/index.html",
  "/reference/configuration/event/": "reference/configuration/event/index.html",
  "/reference/configuration/filter/": "reference/configuration/filter/index.html",
  "/reference/configuration/when/": "reference/configuration/when/index.html",
  "/reference/configuration/shell/": "reference/configuration/shell/index.html",
  "/reference/configuration/action/": "reference/configuration/action/index.html",
  "/reference/configuration/default/": "reference/configuration/default/index.html",
  "/reference/configuration/preset/": "reference/configuration/preset/index.html",
  "/reference/configuration/presets-sources/": "reference/configuration/presets-sources/index.html",
  "/reference/hooks-panel/": "reference/hooks-panel/index.html",
  "/reference/events/": "reference/events/index.html",
  "/reference/shell-environment/": "reference/shell-environment/index.html",
  "/reference/execution-report/": "reference/execution-report/index.html",
  "/reference/glossary/": "reference/glossary/index.html",
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

  it("preserves moved Reference URLs as redirects", () => {
    for (const { route, artifact, target } of LEGACY_REFERENCE_REDIRECTS) {
      const file = join(distDir, artifact);
      assert.ok(existsSync(file), `legacy route ${route} should publish ${artifact}`);
      assert.ok(
        readFileSync(file, "utf-8").includes(`rel="canonical" href="${target}"`),
        `legacy route ${route} should redirect to ${target}`,
      );
    }
  });

  it("stamps glossary tooltips on every published prose page", () => {
    const evaluation = readFileSync(join(distDir, "concepts", "evaluation", "index.html"), "utf-8");
    assert.match(
      evaluation,
      /data-glossary-term="/,
      "a concept page should stamp data-glossary-term for the tooltip CSS",
    );
    assert.match(
      evaluation,
      /href="\/HooKit\/reference\/glossary#[a-z-]+"[^>]*data-glossary-def="/,
      "auto-linked Terms should carry their definition for the tooltip",
    );
  });

  it("shows the HooKit owl-avatar brand identity on the landing page", () => {
    const landing = readFileSync(join(distDir, "index.html"), "utf-8");
    assert.match(
      landing,
      /owl_avatar\.[A-Za-z0-9_-]+\.png/,
      "landing page should show the owl avatar image",
    );
    assert.match(
      landing,
      /HooKit/,
      "landing page should carry the HooKit name next to the owl avatar",
    );
  });

  it("links Getting Started, Reference, and Concepts from the landing page", () => {
    const landing = readFileSync(join(distDir, "index.html"), "utf-8");
    for (const route of ["/getting-started", "/reference", "/concepts"]) {
      const link = pagesPath(route);
      assert.ok(
        landing.includes(`href="${link}`),
        `landing page should route to ${link}`,
      );
    }
  });

  it("publishes navigation, metadata, and search beneath the project Pages base", () => {
    const landing = readFileSync(join(distDir, "index.html"), "utf-8");
    const introduction = readFileSync(
      join(distDir, "getting-started", "index.html"),
      "utf-8",
    );
    const searchIndex = readFileSync(join(distDir, "api", "search"), "utf-8");
    const clientScripts = readdirSync(join(distDir, "_astro"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => readFileSync(join(distDir, "_astro", entry.name), "utf-8"))
      .join("\n");

    assert.match(landing, /(?:src|href)="\/HooKit\/_astro\//);
    assert.match(
      introduction,
      /href="\/HooKit\/reference\/glossary#[a-z-]+"/,
      "rendered MDX glossary links should include the Pages base",
    );
    assert.doesNotMatch(
      landing + introduction,
      /href="\/(?!HooKit(?:[\/#?"]|$))/,
      "site-root links must not escape to the github.io origin root",
    );
    assert.match(
      introduction,
      /property="og:image" content="https:\/\/meffmadd\.github\.io\/HooKit\/og\/docs\/getting-started\/image\.webp"/,
    );
    assert.ok(
      searchIndex.includes(`"url":"${pagesPath("/getting-started")}"`),
      "search result URLs should include the Pages base",
    );
    assert.ok(
      clientScripts.includes(PAGES_BASE_PATH) && clientScripts.includes("/api/search"),
      "the search client should combine the Pages base with its static endpoint",
    );
  });
});
