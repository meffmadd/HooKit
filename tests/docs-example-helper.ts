import assert from "node:assert/strict";

export type Example = {
  rel: string;
  label: string;
  raw: string;
  expected: boolean;
};

// Shared extraction for canonical MDX and the installed Markdown surface.
// Preserve the raw example body so the artifact test can detect lost/changed
// examples as well as validate their explicit valid/invalid expectations.
const MARKER = /\{\/\*\s*docs-example:(valid|invalid)\s*\*\/\}|<!--\s*docs-example:(valid|invalid)\s*-->/;

export function extractExamples(rel: string, text: string): Example[] {
  const lines = text.split("\n");
  const examples: Example[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = MARKER.exec(lines[i]!.trim());
    if (!match || match.index !== 0) {
      i += 1;
      continue;
    }
    const expected = (match[1] ?? match[2]) === "valid";
    let fence = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j]!.trim();
      if (trimmed === "```json") {
        fence = j;
        break;
      }
      if (trimmed.startsWith("#") || trimmed.startsWith("```") || MARKER.test(trimmed)) break;
    }
    assert.notEqual(fence, -1, `${rel}: docs-example marker at line ${i + 1} has no following fenced JSON block`);
    let end = -1;
    for (let j = fence + 1; j < lines.length; j++) {
      if (lines[j]!.trim() === "```") {
        end = j;
        break;
      }
    }
    assert.notEqual(end, -1, `${rel}: fenced JSON block at line ${fence + 1} is unterminated`);
    examples.push({ rel, label: lines[i]!.trim(), raw: lines.slice(fence + 1, end).join("\n"), expected });
    i = end + 1;
  }
  return examples;
}
