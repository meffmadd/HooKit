import {
  keyText,
  type EntryRenderer,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
  isActionType,
  isAssertResultOutcome,
  isLifecycleHook,
} from "../domain/entry.js";
import type {
  ActionRequestExecution,
  AssertionExecution,
  AssertionExecutionReport,
  OriginatingAssertionResult,
} from "../hook-evaluation/index.js";

export const EXECUTION_ENTRY_TYPE = "pi-assert-execution";
const EXECUTION_ENTRY_VERSION = 3;
const MAX_LABEL_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export type ExecutionTrigger =
  | {
      readonly event: "tool_call" | "tool_result";
      readonly toolName: string;
      readonly toolCallId: string;
    }
  | {
      readonly event: "turn_end";
      readonly turnIndex: number;
    }
  | { readonly event: "agent_end" | "agent_settled" }
  | {
      readonly event: "session_before_switch";
      readonly reason: "new" | "resume";
    }
  | {
      readonly event: "session_before_fork";
      readonly position: "before" | "at";
    };

export interface ExecutionEntryData {
  readonly version: 3;
  readonly trigger: ExecutionTrigger;
  readonly executions: readonly AssertionExecution[];
  readonly actionRequests: readonly ActionRequestExecution[];
}

type ParsedActionRequest = Omit<ActionRequestExecution, "outcome"> & {
  readonly outcome?: ActionRequestExecution["outcome"];
};

interface ParsedExecutionEntryData {
  readonly version: 1 | 2 | 3;
  readonly trigger: ExecutionTrigger;
  readonly executions: readonly AssertionExecution[];
  readonly actionRequests: readonly ParsedActionRequest[];
}

function cleanText(value: string, maximum: number): string {
  return value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function requiredText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = cleanText(value, maximum);
  return cleaned.length === 0 ? undefined : cleaned;
}

function snapshotTrigger(trigger: ExecutionTrigger): ExecutionTrigger {
  switch (trigger.event) {
    case "tool_call":
    case "tool_result":
      return Object.freeze({
        event: trigger.event,
        toolName: cleanText(trigger.toolName, MAX_LABEL_LENGTH) || "unknown",
        toolCallId: cleanText(trigger.toolCallId, MAX_ID_LENGTH) || "unknown",
      });
    case "turn_end":
      return Object.freeze({
        event: "turn_end",
        turnIndex: Math.max(0, Math.floor(trigger.turnIndex)),
      });
    case "agent_end":
    case "agent_settled":
      return Object.freeze({ event: trigger.event });
    case "session_before_switch":
      return Object.freeze({
        event: "session_before_switch",
        reason: trigger.reason,
      });
    case "session_before_fork":
      return Object.freeze({
        event: "session_before_fork",
        position: trigger.position,
      });
  }
}

function snapshotOrigin(
  origin: OriginatingAssertionResult,
): OriginatingAssertionResult {
  return Object.freeze({
    assertionRef: cleanText(origin.assertionRef, MAX_LABEL_LENGTH) || "unknown",
    runId: cleanText(origin.runId, MAX_ID_LENGTH) || "unknown",
    outcome: origin.outcome,
  });
}

function snapshotExecution(execution: AssertionExecution): AssertionExecution {
  return Object.freeze({
    assertionRef: cleanText(execution.assertionRef, MAX_LABEL_LENGTH) || "unknown",
    runId: cleanText(execution.runId, MAX_ID_LENGTH) || "unknown",
    hook: execution.hook,
    durationMs: Math.max(0, Math.floor(execution.durationMs)),
    passed: execution.passed,
    ...(execution.originatingResult === undefined
      ? {}
      : { originatingResult: snapshotOrigin(execution.originatingResult) }),
  });
}

function snapshotActionRequest(
  request: ActionRequestExecution,
): ActionRequestExecution {
  return Object.freeze({
    assertionRef: cleanText(request.assertionRef, MAX_LABEL_LENGTH) || "unknown",
    runId: cleanText(request.runId, MAX_ID_LENGTH) || "unknown",
    hook: request.hook,
    actionType: request.actionType,
    outcome: request.outcome,
    ...(request.originatingResult === undefined
      ? {}
      : { originatingResult: snapshotOrigin(request.originatingResult) }),
  });
}

/** Copy one Hook Evaluation report onto a bounded, persistence-safe UI payload. */
export function executionEntryData(
  trigger: ExecutionTrigger,
  report: AssertionExecutionReport,
): ExecutionEntryData {
  return Object.freeze({
    version: EXECUTION_ENTRY_VERSION,
    trigger: snapshotTrigger(trigger),
    executions: Object.freeze(report.executions.map(snapshotExecution)),
    actionRequests: Object.freeze(
      (report.actionRequests ?? []).map(snapshotActionRequest),
    ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTrigger(value: unknown): ExecutionTrigger | undefined {
  if (!isRecord(value) || typeof value.event !== "string") return undefined;
  switch (value.event) {
    case "tool_call":
    case "tool_result": {
      const toolName = requiredText(value.toolName, MAX_LABEL_LENGTH);
      const toolCallId = requiredText(value.toolCallId, MAX_ID_LENGTH);
      return toolName === undefined || toolCallId === undefined
        ? undefined
        : { event: value.event, toolName, toolCallId };
    }
    case "turn_end":
      return typeof value.turnIndex === "number" &&
          Number.isFinite(value.turnIndex) && value.turnIndex >= 0
        ? { event: "turn_end", turnIndex: Math.floor(value.turnIndex) }
        : undefined;
    case "agent_end":
    case "agent_settled":
      return { event: value.event };
    case "session_before_switch":
      return value.reason === "new" || value.reason === "resume"
        ? { event: "session_before_switch", reason: value.reason }
        : undefined;
    case "session_before_fork":
      return value.position === "before" || value.position === "at"
        ? { event: "session_before_fork", position: value.position }
        : undefined;
    default:
      return undefined;
  }
}

function parseOrigin(value: unknown): OriginatingAssertionResult | undefined {
  if (!isRecord(value)) return undefined;
  const assertionRef = requiredText(value.assertionRef, MAX_LABEL_LENGTH);
  const runId = requiredText(value.runId, MAX_ID_LENGTH);
  if (
    assertionRef === undefined || runId === undefined ||
    !isAssertResultOutcome(value.outcome)
  ) {
    return undefined;
  }
  return { assertionRef, runId, outcome: value.outcome };
}

function parseExecution(value: unknown): AssertionExecution | undefined {
  if (!isRecord(value)) return undefined;
  const assertionRef = requiredText(value.assertionRef, MAX_LABEL_LENGTH);
  const runId = requiredText(value.runId, MAX_ID_LENGTH);
  if (
    assertionRef === undefined || runId === undefined ||
    !isLifecycleHook(value.hook) ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
    typeof value.passed !== "boolean"
  ) {
    return undefined;
  }

  let originatingResult: OriginatingAssertionResult | undefined;
  if (value.originatingResult !== undefined) {
    originatingResult = parseOrigin(value.originatingResult);
    if (originatingResult === undefined) return undefined;
  }

  return {
    assertionRef,
    runId,
    hook: value.hook,
    durationMs: Math.floor(value.durationMs),
    passed: value.passed,
    ...(originatingResult === undefined ? {} : { originatingResult }),
  };
}

function parseActionRequest(
  value: unknown,
  version: 2 | 3,
): ParsedActionRequest | undefined {
  if (!isRecord(value)) return undefined;
  const assertionRef = requiredText(value.assertionRef, MAX_LABEL_LENGTH);
  const runId = requiredText(value.runId, MAX_ID_LENGTH);
  if (
    assertionRef === undefined || runId === undefined ||
    !isLifecycleHook(value.hook) || !isActionType(value.actionType)
  ) {
    return undefined;
  }

  let originatingResult: OriginatingAssertionResult | undefined;
  if (value.originatingResult !== undefined) {
    originatingResult = parseOrigin(value.originatingResult);
    if (originatingResult === undefined) return undefined;
  }
  if (version === 3 && !isAssertResultOutcome(value.outcome)) return undefined;
  return {
    assertionRef,
    runId,
    hook: value.hook,
    actionType: value.actionType,
    ...(isAssertResultOutcome(value.outcome) ? { outcome: value.outcome } : {}),
    ...(originatingResult === undefined ? {} : { originatingResult }),
  };
}

function parseEntryData(value: unknown): ParsedExecutionEntryData | undefined {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    !Array.isArray(value.executions)
  ) {
    return undefined;
  }
  const actionValues = value.version === 1 ? [] : value.actionRequests;
  if (!Array.isArray(actionValues)) return undefined;
  if (value.executions.length === 0 && actionValues.length === 0) return undefined;

  const trigger = parseTrigger(value.trigger);
  if (trigger === undefined) return undefined;
  const executions: AssertionExecution[] = [];
  for (const execution of value.executions) {
    const parsed = parseExecution(execution);
    if (parsed === undefined) return undefined;
    executions.push(parsed);
  }
  const actionRequests: ParsedActionRequest[] = [];
  for (const action of actionValues) {
    const parsed = parseActionRequest(action, value.version as 2 | 3);
    if (parsed === undefined) return undefined;
    actionRequests.push(parsed);
  }
  return {
    version: value.version,
    trigger,
    executions,
    actionRequests,
  };
}

function triggerLabel(trigger: ExecutionTrigger): string {
  switch (trigger.event) {
    case "tool_call":
    case "tool_result":
      return `${trigger.event} ${trigger.toolName}`;
    case "turn_end":
      return `turn_end ${trigger.turnIndex}`;
    case "agent_end":
    case "agent_settled":
      return trigger.event;
    case "session_before_switch":
      return `session_before_switch ${trigger.reason}`;
    case "session_before_fork":
      return `session_before_fork ${trigger.position}`;
  }
}

function executionKey(assertionRef: string, runId: string): string {
  return `${assertionRef}\u0000${runId}`;
}

interface ExecutionRow {
  readonly execution: AssertionExecution;
  readonly depth: number;
}

interface ActionRow {
  readonly action: ParsedActionRequest;
  readonly depth: number;
}

interface ResultRow {
  readonly result: OriginatingAssertionResult;
  readonly depth: number;
}

type ExpandedRow = ExecutionRow | ActionRow | ResultRow;

function expandedRows(
  executions: readonly AssertionExecution[],
  actionRequests: readonly ParsedActionRequest[],
): ExpandedRow[] {
  const executionHandlers = new Map<string, AssertionExecution[]>();
  const actionHandlers = new Map<string, ParsedActionRequest[]>();
  const ownedActions = new Map<string, ParsedActionRequest[]>();
  for (const execution of executions) {
    const origin = execution.originatingResult;
    if (origin === undefined) continue;
    const key = executionKey(origin.assertionRef, origin.runId);
    const group = executionHandlers.get(key) ?? [];
    group.push(execution);
    executionHandlers.set(key, group);
  }
  for (const action of actionRequests) {
    const ownKey = executionKey(action.assertionRef, action.runId);
    const owned = ownedActions.get(ownKey) ?? [];
    owned.push(action);
    ownedActions.set(ownKey, owned);
    const origin = action.originatingResult;
    if (origin === undefined) continue;
    const originKey = executionKey(origin.assertionRef, origin.runId);
    const handlers = actionHandlers.get(originKey) ?? [];
    handlers.push(action);
    actionHandlers.set(originKey, handlers);
  }

  const rows: ExpandedRow[] = [];
  const consumedOrigins = new Set<string>();
  const consumedActions = new Set<ParsedActionRequest>();
  const appendOwnedActions = (key: string, depth: number): void => {
    for (const action of ownedActions.get(key) ?? []) {
      rows.push({ action, depth });
      consumedActions.add(action);
    }
  };
  const appendHandlers = (key: string): void => {
    for (const execution of executionHandlers.get(key) ?? []) {
      rows.push({ execution, depth: 1 });
      appendOwnedActions(
        executionKey(execution.assertionRef, execution.runId),
        2,
      );
    }
    for (const action of actionHandlers.get(key) ?? []) {
      if (consumedActions.has(action)) continue;
      if (action.outcome !== undefined) {
        rows.push({
          result: {
            assertionRef: action.assertionRef,
            runId: action.runId,
            outcome: action.outcome,
          },
          depth: 1,
        });
      }
      rows.push({ action, depth: action.outcome === undefined ? 1 : 2 });
      consumedActions.add(action);
    }
  };

  for (const execution of executions) {
    if (execution.originatingResult !== undefined) continue;
    rows.push({ execution, depth: 0 });
    const key = executionKey(execution.assertionRef, execution.runId);
    appendOwnedActions(key, 1);
    appendHandlers(key);
    consumedOrigins.add(key);
  }

  const origins = [
    ...executions.flatMap((item) => item.originatingResult ?? []),
    ...actionRequests.flatMap((item) => item.originatingResult ?? []),
  ];
  for (const origin of origins) {
    const key = executionKey(origin.assertionRef, origin.runId);
    if (consumedOrigins.has(key)) continue;
    rows.push({ result: origin, depth: 0 });
    appendHandlers(key);
    consumedOrigins.add(key);
  }

  // A precondition infrastructure result can request an Action without a
  // main command row. Preserve that causal result rather than inventing one.
  for (const action of actionRequests) {
    if (consumedActions.has(action)) continue;
    if (action.outcome !== undefined) {
      rows.push({
        result: {
          assertionRef: action.assertionRef,
          runId: action.runId,
          outcome: action.outcome,
        },
        depth: 0,
      });
      rows.push({ action, depth: 1 });
    } else {
      rows.push({ action, depth: 0 });
    }
    consumedActions.add(action);
  }
  return rows;
}

function isExecutionRow(row: ExpandedRow): row is ExecutionRow {
  return "execution" in row;
}

function renderExpandedRows(
  executions: readonly AssertionExecution[],
  actionRequests: readonly ParsedActionRequest[],
  theme: Theme,
): string[] {
  const rows = expandedRows(executions, actionRequests);
  const prefixFor = (depth: number): string =>
    depth === 0 ? "" : `${"  ".repeat(depth)}↳ `;
  const labels = rows.filter(isExecutionRow).map(({ execution, depth }) =>
    `${prefixFor(depth)}${execution.passed ? "✓" : "✗"} ${execution.assertionRef}`
  );
  const durationColumn = labels.reduce(
    (maximum, label) => Math.max(maximum, visibleWidth(label)),
    0,
  ) + 2;

  let labelIndex = 0;
  return rows.map((row) => {
    if ("result" in row) {
      const prefix = prefixFor(row.depth);
      return theme.fg(
        "dim",
        `${prefix}${row.result.assertionRef} · ${row.result.outcome} result`,
      );
    }
    if ("action" in row) {
      const prefix = prefixFor(row.depth);
      return `${prefix}${theme.fg("accent", "→")} ${
        theme.fg("text", row.action.assertionRef)
      }${theme.fg("dim", ` · ${row.action.actionType} requested`)}`;
    }

    const { execution, depth } = row;
    const plainLabel = labels[labelIndex++]!;
    const prefix = prefixFor(depth);
    const glyph = execution.passed
      ? theme.fg("success", "✓")
      : theme.fg("error", "✗");
    const label = `${prefix}${glyph} ${theme.fg("text", execution.assertionRef)}`;
    const padding = " ".repeat(
      Math.max(2, durationColumn - visibleWidth(plainLabel)),
    );
    return `${label}${padding}${theme.fg("dim", `${execution.durationMs}ms`)}`;
  });
}

function transcriptBox(theme: Theme, content: string): Box {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(content, 0, 0));
  return box;
}

function fallback(theme: Theme): Box {
  return transcriptBox(
    theme,
    theme.fg("error", "pi-assert execution summary unavailable"),
  );
}

/** One defensive renderer shared by every durable assertion execution entry. */
export const renderExecutionEntry: EntryRenderer<unknown> = (
  entry,
  { expanded },
  theme,
) => {
  try {
    const data = parseEntryData(entry.data);
    if (data === undefined) return fallback(theme);
    const totalMs = data.executions.reduce(
      (total, execution) => total + execution.durationMs,
      0,
    );
    const count = data.executions.length;
    const actionCount = data.actionRequests.length;
    const commandSummary = `ran ${count} command${
      count === 1 ? "" : "s"
    } in ${totalMs}ms`;
    const actionSummary = `requested ${actionCount} action${
      actionCount === 1 ? "" : "s"
    }`;
    const summary = `pi-assert ${
      count === 0
        ? actionSummary
        : actionCount === 0
        ? commandSummary
        : `${commandSummary} and ${actionSummary}`
    } · ${triggerLabel(data.trigger)}`;
    const expandKey = keyText("app.tools.expand") || "ctrl+o";
    const lines = [
      expanded
        ? theme.fg("customMessageText", summary)
        : theme.fg("customMessageText", `${summary} (`) +
          theme.fg("dim", expandKey) +
          theme.fg("customMessageText", " to expand)"),
    ];

    if (expanded) {
      if (
        data.trigger.event === "tool_call" ||
        data.trigger.event === "tool_result"
      ) {
        lines.push(theme.fg("dim", `  tool-call id: ${data.trigger.toolCallId}`));
      }
      lines.push(...renderExpandedRows(
        data.executions,
        data.actionRequests,
        theme,
      ));
    }
    return transcriptBox(theme, lines.join("\n"));
  } catch {
    return fallback(theme);
  }
};
