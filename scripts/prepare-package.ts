import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";
import type { Root, RootContent } from "mdast";

const root = join(import.meta.dirname!, "..");
const source = join(root, "site/content/docs");
const destination = join(root, "skills/hookit/references");
const parser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
const writer = unified().use(remarkStringify, { fences: true, bullet: "-" }).use(remarkGfm);

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? pages(path) : entry.name.endsWith(".mdx") ? [path] : [];
  });
}

const documents = pages(source).map((file) => ({
  file,
  path: relative(source, file).replace(/\.mdx$/, ".md"),
}));
const routes = new Map(documents.map(({ path }) => [
  `/${path.replace(/(?:\/)?index\.md$|\.md$/g, "")}`,
  join(destination, path),
]));

function localLink(url: string, output: string): string {
  if (url === "https://raw.githubusercontent.com/meffmadd/HooKit/main/schema.json") {
    return relative(dirname(output), join(root, "schema.json"));
  }
  if (!url.startsWith("/")) return url;
  const [route, anchor] = url.split("#");
  const target = routes.get(route.replace(/\/$/, "") || "/");
  if (!target) throw new Error(`${output}: unknown documentation destination ${url}`);
  return relative(dirname(output), target) + (anchor ? `#${anchor}` : "");
}

// Translate the site's supported presentation into ordinary Markdown. Unknown
// MDX is an error, not silently dropped prose or a runtime requirement.
function portableMarkdown(file: string, output: string): string {
  const { data, content } = matter(readFileSync(file, "utf8"));
  if (typeof data.title !== "string") throw new Error(`${file}: missing title`);
  const tree = parser.parse(content) as Root;
  visit(tree, (node, index, parent) => {
    if (node.type === "link" || node.type === "definition") {
      node.url = localLink(node.url, output);
    }
    if (!parent || index === undefined) return;
    if (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression") {
      const marker = /^\/\*\s*docs-example:(valid|invalid)\s*\*\/$/.exec(node.value.trim());
      if (!marker) throw new Error(`${file}: unsupported MDX expression`);
      parent.children[index] = { type: "html", value: `<!-- docs-example:${marker[1]} -->` };
    } else if (node.type === "mdxJsxFlowElement" && node.name === "Callout") {
      const attributes = new Map(node.attributes.map((attribute) => {
        if (attribute.type !== "mdxJsxAttribute" || typeof attribute.value !== "string") {
          throw new Error(`${file}: unsupported Callout attribute`);
        }
        return [attribute.name, attribute.value];
      }));
      if ([...attributes.keys()].some((key) => key !== "type" && key !== "title")) {
        throw new Error(`${file}: unsupported Callout attribute`);
      }
      const label = [attributes.get("type"), attributes.get("title")].filter(Boolean).join(" — ");
      parent.children[index] = {
        type: "blockquote",
        children: [
          { type: "paragraph", children: [{ type: "strong", children: [{ type: "text", value: label }] }] },
          ...node.children as RootContent[],
        ],
      } as RootContent;
      // Visit the translated children as well, including links and examples.
      return index;
    } else if (node.type.startsWith("mdx")) {
      throw new Error(`${file}: unsupported ${node.type}`);
    }
    if (node.type === "heading") {
      const last = node.children.at(-1);
      if (last?.type === "text") {
        const anchor = /\s*\[#([a-z0-9-]+)\]$/.exec(last.value);
        if (anchor) {
          last.value = last.value.slice(0, anchor.index);
          parent.children.splice(index, 0, { type: "html", value: `<a id="${anchor[1]}"></a>` });
          return index + 1;
        }
      }
    }
  });
  if (typeof data.description === "string") {
    tree.children.unshift({ type: "paragraph", children: [{ type: "text", value: data.description }] });
  }
  tree.children.unshift({ type: "heading", depth: 1, children: [{ type: "text", value: data.title }] });
  return `<!-- Generated from release sources; edit site/content/docs, not this file. -->\n\n${writer.stringify(tree)}`;
}

// Generate in memory before replacing the complete output, so removed/renamed
// pages cannot survive repeated preparation and unsupported MDX fails the gate.
const rendered = documents.map(({ file, path }) => ({
  output: join(destination, path),
  text: portableMarkdown(file, join(destination, path)),
}));
rmSync(destination, { recursive: true, force: true });
for (const { output, text } of rendered) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, text);
}
console.error(`Prepared ${rendered.length} documentation pages and canonical schema.json for packaging.`);
