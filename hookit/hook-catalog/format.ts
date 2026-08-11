import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import { LIFECYCLE_EVENTS, isLifecycleEvent } from "../domain/entry.js";
import {
  findInvalidFilterRegex,
  validateHookEntry,
} from "../domain/validation.js";

/** Private raw shape of one authorized hookit.json storage file. */
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
    throw new Error("hookit.json content is not a JSON object");
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
      if (validateHookEntry(entry)) continue;
      if (isPlainObject(entry) && typeof entry.event === "string" &&
          !isLifecycleEvent(entry.event)) {
        return `entry ${JSON.stringify(`${source}/${name}`)} has unknown event ` +
          `${JSON.stringify(entry.event)}; supported events: ${LIFECYCLE_EVENTS.join(", ")}`;
      }
      const invalidRegex = findInvalidFilterRegex(entry);
      if (invalidRegex) {
        const location = `filter[${JSON.stringify(invalidRegex.key)}]` +
          (invalidRegex.index === undefined ? "" : `[${invalidRegex.index}]`);
        return `entry ${JSON.stringify(`${source}/${name}`)} ${location} has invalid regex ` +
          `${JSON.stringify(invalidRegex.pattern)}: ${invalidRegex.reason}`;
      }
      return `entry "${source}/${name}" does not match the Hook or Preset schema`;
    }
  }
  return null;
}

/**
 * Enumerate source partitions in insertion order. Source eligibility is a
 * separate Hook Catalog policy: this enumerates every section exactly
 * as stored, leaving canonical-syntax and storage-eligibility decisions to
 * the catalog.
 */
export function iterSections(file: SectionedFile): SectionedSection[] {
  const sections: SectionedSection[] = [];
  for (const [source, entries] of Object.entries(file)) {
    if (META_KEYS.has(source) || !isPlainObject(entries)) continue;
    sections.push({ source, entries });
  }
  return sections;
}
