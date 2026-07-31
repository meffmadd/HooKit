import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import { LIFECYCLE_HOOKS, isLifecycleHook } from "../domain/entry.js";
import {
  findInvalidFilterRegex,
  validateRuleEntry,
} from "../domain/validation.js";

/** Private raw shape of one authorized asserts.json storage file. */
export interface SectionedFile {
  $schema?: string;
  repos?: string[];
  local?: Record<string, unknown>;
  [source: string]: unknown;
}

export interface SectionedSection {
  readonly source: string;
  readonly entries: Record<string, unknown>;
}

const META_KEYS = new Set(["$schema", "repos"]);

/** Missing storage is empty; malformed existing bytes throw. */
export function readSectionedFile(path: string): SectionedFile {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("asserts.json content is not a JSON object");
  }
  return parsed as SectionedFile;
}

/** Best-effort atomic replacement via a sibling temporary file and rename. */
export function writeSectionedFile(path: string, data: SectionedFile): void {
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(temporary, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return at most the first validation failure for one authorized storage. */
export function validateSectionedFile(file: SectionedFile): string | null {
  if (file.$schema !== undefined && typeof file.$schema !== "string") {
    return '"$schema" must be a string';
  }
  if (file.repos !== undefined &&
      (!Array.isArray(file.repos) ||
       !file.repos.every(
         (repo) => typeof repo === "string" && /^[^/]+\/[^/]+$/.test(repo),
       ) ||
       new Set(file.repos).size !== file.repos.length)) {
    return '"repos" must be a unique array of owner/repo strings';
  }

  for (const [source, entries] of Object.entries(file)) {
    if (META_KEYS.has(source)) continue;
    if (!isPlainObject(entries)) return `section "${source}" must be an object`;
    for (const [name, entry] of Object.entries(entries)) {
      if (validateRuleEntry(entry)) continue;
      if (isPlainObject(entry) && typeof entry.hook === "string" &&
          !isLifecycleHook(entry.hook)) {
        return `entry ${JSON.stringify(`${source}/${name}`)} has unknown lifecycle hook ` +
          `${JSON.stringify(entry.hook)}; supported hooks: ${LIFECYCLE_HOOKS.join(", ")}`;
      }
      const invalidRegex = findInvalidFilterRegex(entry);
      if (invalidRegex) {
        const location = `filter[${JSON.stringify(invalidRegex.key)}]` +
          (invalidRegex.index === undefined ? "" : `[${invalidRegex.index}]`);
        return `entry ${JSON.stringify(`${source}/${name}`)} ${location} has invalid regex ` +
          `${JSON.stringify(invalidRegex.pattern)}: ${invalidRegex.reason}`;
      }
      return `entry "${source}/${name}" does not match the shell assertion, Action Handler, or preset schema`;
    }
  }
  return null;
}

/**
 * Enumerate source partitions in insertion order. A supplied eligibility set
 * enforces project `repos` plus implicit `local`; omission preserves legacy
 * all-object-section behavior.
 */
export function iterSections(
  file: SectionedFile,
  eligibleSources?: ReadonlySet<string>,
): SectionedSection[] {
  const sections: SectionedSection[] = [];
  for (const [source, entries] of Object.entries(file)) {
    if (META_KEYS.has(source) || !isPlainObject(entries)) continue;
    if (eligibleSources && !eligibleSources.has(source)) continue;
    sections.push({ source, entries });
  }
  return sections;
}
