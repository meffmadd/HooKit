/**
 * Validates every designated JSON configuration example in the
 * documentation (the fumadocs pages plus the README) against the same
 * JSON Schema users configure against.
 *
 * A "designated" example is any fenced ```json block preceded by a
 * `{/* docs-example:valid *\/}` (must pass schema validation) or
 * `{/* docs-example:invalid *\/}` (must be rejected) marker, or the
 * `<!-- docs-example:valid -->`/`<!-- docs-example:invalid -->` form
 * used in plain-Markdown files such as the README. The markers are
 * scanned from the raw source so they never leak into print.
 *
 * Usage: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./schema-helper.js";

// ── Discover documentation files ──────────────────────────────────

const repoRoot = join(import.meta.dirname!, "..");
const docsDir = join(repoRoot, "site", "content", "docs");

function collectMdx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...collectMdx(full));
    else if (name.endsWith(".mdx")) out.push(full);
  }
  return out;
}

// The fumadocs pages live under docsDir; the README is scanned too so
// its quick example stays inside the same schema seam as the site.
const docFiles: { file: string; rel: string }[] = collectMdx(docsDir).map(
  (file) => ({ file, rel: file.slice(docsDir.length + 1) }),
);
docFiles.push({ file: join(repoRoot, "README.md"), rel: "README.md" });

// Marker forms in MDX source and plain Markdown:
//   {/* docs-example:valid */},            {/* docs-example:invalid */}
//   <!-- docs-example:valid -->,           <!-- docs-example:invalid -->
const MARKER =
  /\{\/\*\s*docs-example:(valid|invalid)\s*\*\/\}|<!--\s*docs-example:(valid|invalid)\s*-->/;
const JSON_FENCE = "```json";
const CLOSE_FENCE = "```";

type Example = {
  rel: string;
  label: string;
  raw: string;
  expected: boolean;
};

function extractExamples(): Example[] {
  const examples: Example[] = [];
  for (const { file, rel } of docFiles) {
    const lines = readFileSync(file, "utf-8").split("\n");
    let i = 0;
    while (i < lines.length) {
      const match = MARKER.exec(lines[i].trim());
      if (match && match.index === 0) {
        const expected = (match[1] ?? match[2]) === "valid";
        // Find the first fenced ```json block after the marker.
        let fence = -1;
        for (let j = i + 1; j < lines.length; j++) {
          const trimmed = lines[j].trim();
          if (trimmed === JSON_FENCE) {
            fence = j;
            break;
          }
          // Stop at the next heading / marker / fence so the marker
          // never silently swallows an unrelated far-away block.
          if (
            trimmed.startsWith("#") ||
            trimmed.startsWith("```") ||
            MARKER.test(trimmed)
          ) break;
        }
        assert.notEqual(
          fence,
          -1,
          `${file}: docs-example marker at line ${i + 1} has no following fenced JSON block`,
        );
        let end = -1;
        for (let j = fence + 1; j < lines.length; j++) {
          if (lines[j].trim() === CLOSE_FENCE) {
            end = j;
            break;
          }
        }
        assert.notEqual(
          end,
          -1,
          `${file}: fenced JSON block at line ${fence + 1} is unterminated`,
        );
        examples.push({
          rel,
          label: lines[i].trim(),
          raw: lines.slice(fence + 1, end).join("\n"),
          expected,
        });
        i = end + 1;
        continue;
      }
      i += 1;
    }
  }
  return examples;
}

const examples = extractExamples();

describe("documentation configuration examples validate against the JSON Schema", () => {
  it("covers the first-Hook and representative Hook/Preset/Filter/Action examples", () => {
    function expectMarkedValid(rel: string): void {
      const hasValid = examples.some(
        (e) => e.rel === rel && e.expected === true,
      );
      assert.ok(
        hasValid,
        `${rel} should designate at least one valid example to be accepted`,
      );
    }

    expectMarkedValid("getting-started/first-hook.mdx"); // first-Hook tutorial config
    expectMarkedValid("reference/configuration.mdx"); // top-level + sections
    expectMarkedValid("reference/action.mdx"); // owned Action
    expectMarkedValid("reference/filter.mdx"); // tool + hook_result Filters
    expectMarkedValid("reference/hook-result.mdx");
    expectMarkedValid("reference/presets-sources.mdx"); // Preset
    expectMarkedValid("reference/shell-environment.mdx");

    // The seam must also prove rejection: at least one example explicitly
    // illustrates an invalid combination.
    assert.ok(
      examples.some((e) => e.expected === false),
      "at least one docs-example:invalid block should be designated",
    );
  });

  if (examples.length === 0) {
    it("no designated examples found (suite is misconfigured)", () => {
      assert.fail("docs-examples test found no marked examples");
    });
    return;
  }

  for (const example of examples) {
    it(`${example.rel}: ${example.expected ? "accepts" : "rejects"} ${example.label}`, () => {
      const config = JSON.parse(example.raw);
      const accepted = validate(config) === true;
      assert.equal(
        accepted,
        example.expected,
        JSON.stringify(
          {
            expected: example.expected,
            errors: validate.errors,
            source: example.raw,
          },
          null,
          2,
        ),
      );
    });
  }
});
