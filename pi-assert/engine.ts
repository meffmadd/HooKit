import { existsSync } from "node:fs";
import {
  iterSections,
  readSectionedFile,
  validateEntryShape,
  validatePresetShape,
  validateSectionedFile,
  entryKey,
  globalFilePath,
  projectFilePath,
  type SectionedFile,
} from "./config.js";
import type { EntryFilter, Hook } from "./domain/entry.js";

/** Fields shared by every loaded assertion or preset. */
interface AssertBase {
  name: string;
  source: string;
  description: string;
  default: boolean;
  /** Storage provenance retained until Stage 2 introduces Assertion Catalog. */
  path?: string;
}

/** A shell assertion eligible for Hook Evaluation after activation. */
export interface ShellAssert extends AssertBase {
  hook: Hook;
  filter?: EntryFilter;
  when?: string;
  shell: string;
}

/** A named one-level bundle expanded by session activation state. */
export interface PresetAssert extends AssertBase {
  preset: string[];
}

export type Assert = ShellAssert | PresetAssert;

export function isPreset(assertion: Assert): assertion is PresetAssert {
  return "preset" in assertion;
}

/** A single per-file parse failure. */
export interface LoadError {
  readonly path: string;
  readonly reason: string;
}

/** Hard failure for one or more authorized configuration files. */
export class AssertsParseError extends Error {
  readonly errors: LoadError[];

  constructor(errors: LoadError[]) {
    super(
      `Failed to parse ${errors.length} asserts.json file${
        errors.length === 1 ? "" : "s"
      }`,
    );
    this.name = "AssertsParseError";
    this.errors = errors;
  }
}

/**
 * Load global and optionally trusted project assertions. Project entries
 * replace global entries with the same source/name identity as whole records.
 */
export function loadAsserts(cwd: string, includeProject = true): Assert[] {
  const merged = new Map<string, Assert>();
  const errors: LoadError[] = [];
  const projectPath = projectFilePath(cwd);
  let knownRepos: Set<string> | undefined;

  if (includeProject && existsSync(projectPath)) {
    try {
      const file = readSectionedFile(projectPath);
      if (Array.isArray(file.repos)) {
        knownRepos = new Set(
          file.repos.filter(
            (repo) => typeof repo === "string" && repo.includes("/"),
          ),
        );
        knownRepos.add("local");
      }
    } catch (error) {
      errors.push({ path: projectPath, reason: formatParseError(error) });
    }
  }

  const globalPath = globalFilePath();
  if (existsSync(globalPath)) {
    try {
      for (const entry of readSections(globalPath, knownRepos)) {
        merged.set(keyOf(entry), entry);
      }
    } catch (error) {
      upsertError(errors, {
        path: globalPath,
        reason: formatParseError(error),
      });
    }
  }

  if (includeProject && existsSync(projectPath)) {
    try {
      for (const entry of readSections(projectPath, knownRepos)) {
        merged.set(keyOf(entry), entry);
      }
    } catch (error) {
      upsertError(errors, {
        path: projectPath,
        reason: formatParseError(error),
      });
    }
  }

  if (errors.length > 0) throw new AssertsParseError(errors);
  return Array.from(merged.values());
}

function formatParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function upsertError(errors: LoadError[], next: LoadError): void {
  for (let index = 0; index < errors.length; index++) {
    if (errors[index]?.path === next.path) {
      errors[index] = next;
      return;
    }
  }
  errors.push(next);
}

function keyOf(assertion: Assert): string {
  return entryKey(assertion.source, assertion.name);
}

/** Flatten validated source partitions into runtime entries. */
function readSections(path: string, knownRepos?: Set<string>): Assert[] {
  const file: SectionedFile = readSectionedFile(path);
  const validationError = validateSectionedFile(file);
  if (validationError) throw new Error(validationError);
  const results: Assert[] = [];

  for (const { source, entries } of iterSections(file, knownRepos)) {
    for (const [name, definition] of Object.entries(entries)) {
      if (validatePresetShape(definition)) {
        results.push({
          name,
          source,
          description: definition.description,
          preset: definition.preset,
          default: definition.default ?? false,
          path,
        });
      } else if (validateEntryShape(definition)) {
        results.push({
          name,
          source,
          description: definition.description,
          hook: definition.hook,
          filter: definition.filter,
          when: definition.when,
          shell: definition.shell,
          default: definition.default ?? false,
          path,
        });
      }
    }
  }

  return results;
}
