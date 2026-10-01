import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import matter from "gray-matter";
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import GithubSlugger from "github-slugger";
import { createValidator } from "./schema-helper.js";
import { extractExamples } from "./docs-example-helper.js";

const repositoryRoot = join(import.meta.dirname!, "..");

function run(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result.stdout;
}

function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? files(join(dir, entry.name), path) : [path];
  });
}

// Prepare from release sources without existing output; dev dependencies are
// shared only while preparing. The extracted consumer has no checkout or server.
function releaseSource(dir: string): void {
  for (const path of [
    "package.json", "package-lock.json", "README.md", "LICENSE", "AGENTS.md", ".gitignore",
    "schema.json", "hookit", "skills", "scripts", "site/content/docs",
  ]) {
    cpSync(join(repositoryRoot, path), join(dir, path), {
      recursive: true,
      filter: (source) => !source.includes("/skills/hookit/references"),
    });
  }
  for (const path of [
    "hooks/package-sentinel.json", "tests/package-sentinel.test.ts",
    "site/src/package-sentinel.ts", "site/dist/package-sentinel.html",
    "sandbox/package-sentinel.txt", ".agents/skills/package-sentinel.md",
  ]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), "Repository-only content must not ship.\n");
  }
  symlinkSync(join(repositoryRoot, "node_modules"), join(dir, "node_modules"), "dir");
}

function pack(source: string, destination: string, lifecycle = false): string {
  mkdirSync(destination, { recursive: true });
  const manifests = JSON.parse(run(source, "npm", [
    "pack", "--json", ...(!lifecycle ? ["--ignore-scripts"] : []), "--pack-destination", destination,
  ])) as Array<{ filename: string }>;
  assert.equal(manifests.length, 1);
  run(destination, "tar", ["-xzf", manifests[0]!.filename]);
  return join(destination, "package");
}

function verifyNavigation(installed: string): void {
  const parser = unified().use(remarkParse).use(remarkGfm);
  const documents = files(installed).filter((path) =>
    path === "README.md" || path === "skills/hookit/SKILL.md" ||
    (path.startsWith("skills/hookit/references/") && path.endsWith(".md")),
  );
  const trees = new Map(documents.map((path) => [path, parser.parse(readFileSync(join(installed, path), "utf8"))]));
  for (const [path, tree] of trees) {
    visit(tree, (node) => {
      if (node.type !== "link" && node.type !== "definition" && node.type !== "image") return;
      if (/^[a-z][a-z\d+.-]*:/i.test(node.url)) return;
      assert.ok(!node.url.startsWith("/"), `${path}: site-root link ${node.url}`);
      const [file, fragment] = node.url.split("#");
      const target = file ? relative(installed, resolve(installed, dirname(path), decodeURIComponent(file))) : path;
      assert.ok(!target.startsWith(".."), `${path}: reference escapes artifact: ${node.url}`);
      assert.ok(existsSync(join(installed, target)), `${path}: missing destination ${node.url}`);
      if (!fragment) return;
      const targetTree = trees.get(target);
      assert.ok(targetTree, `${path}: anchor target is not a packaged document: ${node.url}`);
      const anchors = new Set<string>();
      const slugger = new GithubSlugger();
      visit(targetTree, (candidate) => {
        if (candidate.type === "heading") anchors.add(slugger.slug(toString(candidate)));
        if (candidate.type === "html") {
          for (const match of candidate.value.matchAll(/\bid="([^"]+)"/g)) anchors.add(match[1]!);
        }
      });
      assert.ok(anchors.has(decodeURIComponent(fragment)), `${path}: missing anchor ${node.url}`);
    });
  }
}

function verifyExamplesAndFormatting(installed: string): void {
  const docs = join(repositoryRoot, "site/content/docs");
  const sourceParser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
  const markdownParser = unified().use(remarkParse).use(remarkGfm);
  const validate = createValidator(JSON.parse(readFileSync(join(installed, "schema.json"), "utf8")));
  let valid = 0;
  let invalid = 0;
  for (const path of [...files(docs).filter((path) => path.endsWith(".mdx")), "README.md"]) {
    const canonical = readFileSync(path === "README.md" ? join(repositoryRoot, path) : join(docs, path), "utf8");
    const output = path === "README.md" ? path : join("skills/hookit/references", path.replace(/\.mdx$/, ".md"));
    const portable = readFileSync(join(installed, output), "utf8");
    assert.doesNotMatch(portable, /<\/?Callout|\{\/\*|\[#[-a-z0-9]+\]/, `${output}: site-only markup`);
    if (path !== "README.md") {
      const { data } = matter(canonical);
      const tree = markdownParser.parse(portable);
      assert.equal(toString(tree.children.find((node) => node.type === "heading")!), data.title, `${output}: missing title`);
      assert.equal(toString(tree.children.find((node) => node.type === "paragraph")!), data.description, `${output}: missing description`);
    }
    const expected = extractExamples(path, canonical).map(({ raw, expected }) => ({ raw, expected }));
    const exported = extractExamples(output, portable).map(({ raw, expected }) => ({ raw, expected }));
    assert.deepEqual(exported, expected, `${output}: altered or lost designated examples`);
    for (const example of exported) {
      assert.equal(validate(JSON.parse(example.raw)), example.expected, `${output}: ${JSON.stringify(validate.errors)}`);
      if (example.expected) valid += 1;
      else invalid += 1;
    }
    // Check every code body and table against authored sources, independently
    // of designated JSON validation and Markdown formatting choices.
    function content(tree: ReturnType<typeof markdownParser.parse>): string[] {
      const blocks: string[] = [];
      visit(tree, (node) => {
        if (node.type === "code") blocks.push(JSON.stringify([node.lang, node.meta, node.value]));
        if (node.type === "table") blocks.push(toString(node));
      });
      return blocks;
    }
    assert.deepEqual(content(markdownParser.parse(portable)), content((path === "README.md" ? markdownParser : sourceParser).parse(matter(canonical).content)), `${output}: changed code or table content`);
  }
  assert.ok(valid > 0 && invalid > 0, "installed docs must demonstrate acceptance and rejection");
}

describe("npm package contents", () => {
  it("ships release-matched readable docs and schema without repository-only content", () => {
    const temp = mkdtempSync(join(tmpdir(), "hookit-package-"));
    try {
      const source = join(temp, "source");
      releaseSource(source);
      run(source, "npm", ["run", "package:prepare"]);
      const installed = pack(source, temp);
      const paths = files(installed);
      for (const required of [
        "AGENTS.md", "hookit/index.ts", "skills/hookit/SKILL.md", "schema.json",
        "skills/hookit/references/index.md",
        "skills/hookit/references/getting-started/installation.md",
        "skills/hookit/references/reference/configuration/index.md",
        "skills/hookit/references/reference/glossary.md",
        "skills/hookit/references/concepts/security.md",
      ]) {
        assert.ok(paths.includes(required), `missing ${required}\n${paths.join("\n")}`);
      }
      for (const excluded of ["hooks", "site", "tests", "scripts", "sandbox", ".agents", "node_modules"]) {
        assert.equal(paths.some((path) => path === excluded || path.startsWith(`${excluded}/`)), false, paths.join("\n"));
      }
      assert.equal(readFileSync(join(installed, "schema.json"), "utf8"), readFileSync(join(repositoryRoot, "schema.json"), "utf8"));
      const installation = readFileSync(join(installed, "skills/hookit/references/getting-started/installation.md"), "utf8");
      assert.match(installation, /# Installation/);
      assert.match(installation, /Security/);
      assert.match(installation, /full system access/);
      assert.match(installation, /```bash\n\s*pi install npm:@meffmadd\/hookit/);
      assert.doesNotMatch(installation, /<Callout|<\/Callout>/);
      assert.match(readFileSync(join(installed, "skills/hookit/references/reference/events.md"), "utf8"), /\| `tool_call`\s*\|/);
      const library = readFileSync(join(installed, "skills/hookit/references/getting-started/library.md"), "utf8");
      assert.match(library, /Opt-in by default/);
      assert.match(library, /Installing HooKit does not enable any policy!/);
      verifyNavigation(installed);
      verifyExamplesAndFormatting(installed);
      const skill = readFileSync(join(installed, "skills/hookit/SKILL.md"), "utf8");
      assert.ok(skill.split(/\s+/).length < 800, "skill should be a minimal navigator");
      assert.match(skill, /not a sandbox/);
      assert.match(skill, /Saved session enablement/);
      assert.match(skill, /Continuation can loop/);
      const metadata = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
      assert.equal(metadata.version, JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version);
      assert.deepEqual(Object.keys(metadata.dependencies ?? {}), []);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("packing prepares a clean release and repeated preparation removes renamed/deleted pages", () => {
    const temp = mkdtempSync(join(tmpdir(), "hookit-package-refresh-"));
    try {
      const source = join(temp, "source");
      releaseSource(source);
      const page = "---\ntitle: Release probe\ndescription: Release preparation fixture.\n---\n\nRelease-local content.\n";
      const old = join(source, "site/content/docs/getting-started/release-probe.mdx");
      const removed = join(source, "site/content/docs/getting-started/removed-probe.mdx");
      writeFileSync(old, page);
      writeFileSync(removed, page);
      const before = pack(source, join(temp, "before"), true);
      assert.ok(existsSync(join(before, "skills/hookit/references/getting-started/release-probe.md")));
      assert.ok(existsSync(join(before, "skills/hookit/references/getting-started/removed-probe.md")));
      renameSync(old, join(source, "site/content/docs/getting-started/renamed-probe.mdx"));
      rmSync(removed);
      run(source, "npm", ["run", "package:prepare"]);
      const after = pack(source, join(temp, "after"));
      const paths = files(after);
      assert.ok(paths.includes("skills/hookit/references/getting-started/renamed-probe.md"));
      assert.ok(!paths.includes("skills/hookit/references/getting-started/release-probe.md"));
      assert.ok(!paths.includes("skills/hookit/references/getting-started/removed-probe.md"));
      assert.match(readFileSync(join(after, "skills/hookit/references/getting-started/renamed-probe.md"), "utf8"), /Release-local content/);
      verifyNavigation(after);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
