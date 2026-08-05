import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import { globalFilePath } from "../config.js";
import type { Hook, ReadonlyEntryFilter } from "../domain/entry.js";
import type {
  HookExecutionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "./types.js";

/** Resolve a dot-separated filter key through own candidate properties. */
function resolveFilterField(
  candidate: Record<string, unknown>,
  key: string,
): unknown {
  let current: unknown = candidate;
  for (const segment of key.split(".")) {
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function matchScalar(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string") {
    return typeof actual === "string" && new RegExp(expected).test(actual);
  }
  return actual === expected;
}

/** Exact, ANDed result-selector semantics shared by filters and Actions. */
export function matchResultSelector(
  selector: { readonly outcome?: unknown; readonly code?: unknown },
  result: { readonly outcome: unknown; readonly code: unknown },
): boolean {
  for (const field of ["outcome", "code"] as const) {
    const expected = selector[field];
    if (expected === undefined) continue;
    const actual = result[field];
    if (Array.isArray(expected)) {
      if (!expected.some((value) => value === actual)) return false;
    } else if (expected !== actual) {
      return false;
    }
  }
  return true;
}

/** Shared filter semantics for native and synthetic assertion candidates. */
export function matchFilter(
  filter: ReadonlyEntryFilter | undefined,
  candidate: Record<string, unknown>,
): boolean {
  if (!filter) return true;

  for (const [key, expected] of Object.entries(filter)) {
    const actual = resolveFilterField(candidate, key);
    if (Array.isArray(expected)) {
      if (!expected.some((value) => matchScalar(value, actual))) return false;
    } else if (!matchScalar(expected, actual)) {
      return false;
    }
  }
  return true;
}

function logEnvironment(env: Record<string, string>, hook: Hook): void {
  if (process.env.PIASSERT_LOG_ENV?.toLowerCase() !== "true") return;

  try {
    const directory = join(dirname(globalFilePath()), ".assert-env-log");
    const today = new Date().toISOString().slice(0, 10);
    const path = join(directory, `${today}.jsonl`);
    mkdirSync(directory, { recursive: true });
    appendFileSync(path, `${JSON.stringify({
      ts: new Date().toISOString(),
      hook,
      env,
    })}\n`);
  } catch {
    // Diagnostic logging must never change an assertion decision.
  }
}

export function buildToolCallEnvironment(
  event: ToolCallEvent,
  context: HookExecutionContext,
): Record<string, string> {
  const env = {
    ...context.metadata,
    PI_EVENT: "tool_call",
    PI_TOOL_NAME: event.toolName,
    PI_TOOL_CALL_ID: event.toolCallId,
    PI_TOOL_INPUT: JSON.stringify(event.input),
    PI_CWD: context.cwd,
  } satisfies Record<string, string>;
  logEnvironment(env, "tool_call");
  return env;
}

export function buildToolResultEnvironment(
  event: ToolResultEvent,
  context: HookExecutionContext,
): Record<string, string> {
  const resultText = event.content
    .filter((content): content is TextContent => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  const env = {
    ...context.metadata,
    PI_EVENT: "tool_result",
    PI_TOOL_NAME: event.toolName,
    PI_TOOL_CALL_ID: event.toolCallId,
    PI_TOOL_INPUT: JSON.stringify(event.input),
    PI_TOOL_RESULT: resultText,
    PI_TOOL_IS_ERROR: event.isError ? "true" : "false",
    PI_CWD: context.cwd,
  } satisfies Record<string, string>;
  logEnvironment(env, "tool_result");
  return env;
}

export function buildLifecycleEnvironment(
  hook: Hook,
  payload: Record<string, unknown>,
  context: HookExecutionContext,
): Record<string, string> {
  const env = {
    ...context.metadata,
    PI_EVENT: hook,
    PI_EVENT_PAYLOAD: JSON.stringify(payload),
    PI_CWD: context.cwd,
  } satisfies Record<string, string>;
  logEnvironment(env, hook);
  return env;
}
