import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type {
  PersistedEntry,
  PersistedHook,
  PersistedPreset,
} from "../../hookit/domain/entry.js";
import {
  isValidEntryName,
  validateHookEntry,
} from "../../hookit/domain/validation.js";
import {
  HookEvaluation,
  createEnabledHookSet,
  type EnabledHook,
  type EvaluationContext,
  type EventMap,
  type HookEvaluationOutcome,
} from "../../hookit/hook-evaluation/index.js";

export const CORE_SOURCE = "meffmadd/HooKit";
const HOOKS_ROOT = join(import.meta.dirname!, "..", "..", "hooks");

function hookFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return hookFiles(path);
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    })
    .sort();
}

export function loadCoreEntries(): ReadonlyMap<string, PersistedEntry> {
  const entries = new Map<string, PersistedEntry>();
  for (const path of hookFiles(HOOKS_ROOT)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(parsed)) {
      if (!isValidEntryName(name)) throw new Error(`Invalid Core entry name ${JSON.stringify(name)}`);
      if (!validateHookEntry(entry)) throw new Error(`Invalid Core entry ${JSON.stringify(name)}`);
      if (entries.has(name)) throw new Error(`Duplicate Core entry ${JSON.stringify(name)}`);
      entries.set(name, entry as PersistedEntry);
    }
  }
  return entries;
}

export function coreEntry(name: string): PersistedEntry {
  const entry = loadCoreEntries().get(name);
  if (!entry) throw new Error(`Unknown Core entry ${JSON.stringify(name)}`);
  return entry;
}

export function coreHook(name: string): EnabledHook {
  const entry = coreEntry(name);
  if ("preset" in entry) throw new Error(`${JSON.stringify(name)} is a Preset`);
  return enabledHook(name, entry);
}

function enabledHook(name: string, entry: PersistedHook): EnabledHook {
  return {
    source: CORE_SOURCE,
    name,
    description: entry.description,
    event: entry.event,
    ...(entry.filter === undefined ? {} : { filter: entry.filter }),
    ...(entry.when === undefined ? {} : { when: entry.when }),
    shell: entry.shell ?? "true",
    ...(entry.action === undefined ? {} : { action: entry.action }),
  };
}

export function corePreset(name: string): PersistedPreset {
  const entry = coreEntry(name);
  if (!("preset" in entry)) throw new Error(`${JSON.stringify(name)} is a Hook`);
  return entry;
}

export async function evaluateCore<H extends keyof EventMap>(
  name: string,
  event: H,
  payload: EventMap[H],
  cwd: string,
  metadata: EvaluationContext["metadata"] = {},
): Promise<HookEvaluationOutcome<H>> {
  return new HookEvaluation().evaluate(
    event,
    payload,
    { cwd, metadata },
    createEnabledHookSet([coreHook(name)]),
  );
}
