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
  NATIVE_HOOKS,
  type NativeHook,
} from "../domain/entry.js";
import type {
  ActionRequestExecution,
  AssertionExecution,
  AssertionExecutionReport,
  OriginatingAssertionResult,
} from "../hook-evaluation/index.js";

export const EXECUTION_ENTRY_TYPE = "pi-assert-execution";
const MAX_LABEL_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_CRITICAL_PATH_MS = 2_147_483_647;
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

/** One bounded trigger plus its per-event execution/action accounting. */
export interface ExecutionReportSegment {
  readonly trigger: ExecutionTrigger;
  readonly executions: readonly AssertionExecution[];
  readonly actionRequests: readonly ActionRequestExecution[];
}

/**
 * The one unversioned persistence-safe shape appended for one Hook
 * Evaluation or one Execution Wave.
 */
export interface ExecutionReportEntryData {
  readonly hook: NativeHook;
  readonly criticalPathMs: number;
  readonly segments: readonly ExecutionReportSegment[];
}

/**
 * Transient reporter handle for one native callback's observation. The
 * reporter owns timing and collection only; it never changes native outcomes
 * or effect selection/delivery.
 */
export interface ReporterObservation {
  readonly hook: NativeHook;
  readonly trigger: ExecutionTrigger;
  readonly startMs: number;
  endMs?: number;
  completed: boolean;
  accounting?: AssertionExecutionReport;
}

function isToolHook(hook: NativeHook): boolean {
  return hook === "tool_call" || hook === "tool_result";
}

function isNativeHook(value: unknown): value is NativeHook {
  return typeof value === "string" &&
    (NATIVE_HOOKS as readonly string[]).includes(value);
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

function boundedCriticalPathMs(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  return Math.min(MAX_CRITICAL_PATH_MS, Math.floor(value));
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

/**
 * Darken one set of completed observations onto an immutable, bounded,
 * persistence-safe Execution Report. Returns undefined when no segment
 * carries any execution or Action Request, so callers append nothing.
 */
function buildEntryData(
  hook: NativeHook,
  criticalPath: number,
  observations: readonly ReporterObservation[],
): ExecutionReportEntryData | undefined {
  if (
    observations.length === 0 ||
    (!isToolHook(hook) && observations.length !== 1) ||
    observations.some((observation) =>
      observation.hook !== hook || observation.trigger.event !== hook
    )
  ) {
    return undefined;
  }

  let hasData = false;
  const segments = observations.map((observation) => {
    const accounting = observation.accounting;
    const executions = Object.freeze(
      (accounting?.executions ?? []).map(snapshotExecution),
    );
    const actionRequests = Object.freeze(
      (accounting?.actionRequests ?? []).map(snapshotActionRequest),
    );
    if (executions.length > 0 || actionRequests.length > 0) hasData = true;
    return Object.freeze({
      trigger: snapshotTrigger(observation.trigger),
      executions,
      actionRequests,
    });
  });
  if (!hasData) return undefined;
  return Object.freeze({
    hook,
    criticalPathMs: boundedCriticalPathMs(criticalPath),
    segments: Object.freeze(segments),
  });
}

/**
 * Non-negative critical-path delay pi-assert added to the reporting interval
 * only — native tool execution and report persistence are excluded.
 *
 * - One segment (including every ordinary hook): `end - start`.
 * - Multi-segment `tool_call`: length of the union of processing intervals
 *   (normally their serial sum without framework gaps).
 * - Multi-segment `tool_result`: `max(end) - max(start)` — the latest start
 *   approximates when the final underlying tool result was ready.
 */
function criticalPathMs(
  hook: NativeHook,
  observations: readonly ReporterObservation[],
): number {
  if (observations.length === 0) return 0;
  if (observations.length === 1) {
    const observation = observations[0]!;
    return Math.max(
      0,
      (observation.endMs ?? observation.startMs) - observation.startMs,
    );
  }
  if (hook === "tool_call") {
    const sorted = [...observations]
      .map((observation) =>
        [observation.startMs, observation.endMs ?? observation.startMs] as const
      )
      .sort((a, b) => a[0] - b[0]);
    let total = 0;
    let currentStart = sorted[0]![0];
    let currentEnd = sorted[0]![1];
    for (let index = 1; index < sorted.length; index++) {
      const [start, end] = sorted[index]!;
      if (start <= currentEnd) {
        currentEnd = Math.max(currentEnd, end);
      } else {
        total += currentEnd - currentStart;
        currentStart = start;
        currentEnd = end;
      }
    }
    total += currentEnd - currentStart;
    return Math.max(0, total);
  }
  const maxEnd = Math.max(
    ...observations.map((observation) => observation.endMs ?? observation.startMs),
  );
  const maxStart = Math.max(...observations.map((observation) => observation.startMs));
  return Math.max(0, maxEnd - maxStart);
}

/**
 * Session-scoped collector that turns consecutive Hook Evaluations for the
 * same tool hook into one Execution Report for an Execution Wave and keeps
 * ordinary hooks as single immediate reports. It owns no native outcomes,
 * effects, or Action delivery.
 */
export class ExecutionReporter {
  private readonly now: () => number;
  private readonly persist: (entry: ExecutionReportEntryData) => void;
  private pending:
    | { readonly hook: NativeHook; readonly segments: ReporterObservation[] }
    | undefined;

  constructor(options: {
    /** Monotonic clock, backed by `performance.now()`, for interval math. */
    readonly now: () => number;
    /** Best-effort durable write; failures are dropped, never retried. */
    readonly append: (entry: ExecutionReportEntryData) => void;
  }) {
    this.now = options.now;
    this.persist = options.append;
  }

  /**
   * Open one observation at callback entry. A prior completed pending tool
   * wave is flushed when this hook differs; timing starts before any capture.
   */
  begin(hook: NativeHook, trigger: ExecutionTrigger): ReporterObservation {
    if (this.pending !== undefined && this.pending.hook !== hook) {
      this.flushPending();
    }
    const observation: ReporterObservation = {
      hook,
      trigger,
      startMs: this.now(),
      completed: false,
    };
    if (isToolHook(hook)) {
      if (this.pending === undefined) {
        this.pending = { hook, segments: [] };
      }
      // Segment order is assigned here, so overlapping completions cannot
      // reorder groups.
      this.pending.segments.push(observation);
    }
    return observation;
  }

  /**
   * Close one observation with its optional Hook Evaluation report. Tool
   * observations join the pending same-hook wave; ordinary observations build
   * and append their one-segment report immediately when they carry data.
   * Must be called on every exit (including an unexpected escape) so an open
   * observation can never poison later reporting.
   */
  complete(
    observation: ReporterObservation,
    accounting?: AssertionExecutionReport,
  ): void {
    if (observation.completed) return; // never double-append a report
    observation.endMs = this.now();
    observation.accounting = accounting;
    observation.completed = true;
    if (!isToolHook(observation.hook)) {
      this.appendSingle(observation);
    }
  }

  /**
   * Flush a completed pending tool wave and discard any still-open
   * observation. Never invents partial report rows. Safe to call from
   * `session_shutdown` and idempotent when nothing is pending.
   */
  flush(): void {
    this.flushPending();
  }

  private flushPending(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) return;
    const segments = pending.segments.filter((segment) => segment.completed);
    if (segments.length === 0) return;
    const entry = buildEntryData(pending.hook, criticalPathMs(pending.hook, segments), segments);
    if (entry === undefined) return;
    this.persistOrDrop(entry);
  }

  private appendSingle(observation: ReporterObservation): void {
    const observations = [observation];
    const entry = buildEntryData(
      observation.hook,
      criticalPathMs(observation.hook, observations),
      observations,
    );
    if (entry !== undefined) this.persistOrDrop(entry);
  }

  private persistOrDrop(entry: ExecutionReportEntryData): void {
    try {
      this.persist(entry);
    } catch {
      // Observability is best-effort: drop this report, never retry, merge,
      // or duplicate it, and never affect native outcomes or effects.
    }
  }
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
): ActionRequestExecution | undefined {
  if (!isRecord(value)) return undefined;
  const assertionRef = requiredText(value.assertionRef, MAX_LABEL_LENGTH);
  const runId = requiredText(value.runId, MAX_ID_LENGTH);
  if (
    assertionRef === undefined || runId === undefined ||
    !isLifecycleHook(value.hook) || !isActionType(value.actionType) ||
    !isAssertResultOutcome(value.outcome)
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
    actionType: value.actionType,
    outcome: value.outcome,
    ...(originatingResult === undefined ? {} : { originatingResult }),
  };
}

interface ParsedSegmentData {
  readonly trigger: ExecutionTrigger;
  readonly executions: readonly AssertionExecution[];
  readonly actionRequests: readonly ActionRequestExecution[];
}

interface ParsedEntryData {
  readonly hook: NativeHook;
  readonly criticalPathMs: number;
  readonly segments: readonly ParsedSegmentData[];
}

function parseEntryData(value: unknown): ParsedEntryData | undefined {
  if (
    !isRecord(value) ||
    !isNativeHook(value.hook) ||
    typeof value.criticalPathMs !== "number" ||
    !Number.isFinite(value.criticalPathMs) ||
    value.criticalPathMs < 0 ||
    value.criticalPathMs > MAX_CRITICAL_PATH_MS ||
    !Array.isArray(value.segments) ||
    value.segments.length === 0
  ) {
    return undefined;
  }
  const hook = value.hook;
  if (!isToolHook(hook) && value.segments.length !== 1) return undefined;

  let hasData = false;
  const segments: ParsedSegmentData[] = [];
  for (const rawSegment of value.segments) {
    if (!isRecord(rawSegment)) return undefined;
    const trigger = parseTrigger(rawSegment.trigger);
    if (trigger === undefined || trigger.event !== hook) return undefined;
    if (!Array.isArray(rawSegment.executions) || !Array.isArray(rawSegment.actionRequests)) {
      return undefined;
    }
    const executions: AssertionExecution[] = [];
    for (const execution of rawSegment.executions) {
      const parsed = parseExecution(execution);
      if (parsed === undefined) return undefined;
      executions.push(parsed);
    }
    const actionRequests: ActionRequestExecution[] = [];
    for (const action of rawSegment.actionRequests) {
      const parsed = parseActionRequest(action);
      if (parsed === undefined) return undefined;
      actionRequests.push(parsed);
    }
    if (executions.length > 0 || actionRequests.length > 0) hasData = true;
    segments.push({ trigger, executions, actionRequests });
  }
  if (!hasData) return undefined;
  return {
    hook,
    criticalPathMs: Math.floor(value.criticalPathMs),
    segments,
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

/** `tool_call bash ×3, read ×5` — every segment, empty ones included. */
function toolBreakdown(data: ParsedEntryData): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const segment of data.segments) {
    if (
      segment.trigger.event !== "tool_call" &&
      segment.trigger.event !== "tool_result"
    ) {
      continue;
    }
    const toolName = segment.trigger.toolName;
    if (!counts.has(toolName)) order.push(toolName);
    counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
  }
  return `${data.hook} ${order
    .map((name) => `${name} ×${counts.get(name)}`)
    .join(", ")}`;
}

function summaryLine(data: ParsedEntryData): string {
  const count = data.segments.reduce((total, segment) => total + segment.executions.length, 0);
  const actionCount = data.segments.reduce(
    (total, segment) => total + segment.actionRequests.length,
    0,
  );
  const milliseconds = `in ${data.criticalPathMs}ms`;
  const commands = count === 0
    ? ""
    : `ran ${count} command${count === 1 ? "" : "s"} ${milliseconds}`;
  const actions = `requested ${actionCount} action${actionCount === 1 ? "" : "s"}`;
  const core = count === 0
    ? `${actions} ${milliseconds}`
    : actionCount === 0
    ? commands
    : `${commands} and ${actions}`;
  const context = isToolHook(data.hook)
    ? ` · ${toolBreakdown(data)}`
    : ` · ${triggerLabel(data.segments[0]!.trigger)}`;
  return `pi-assert ${core}${context}`;
}

function executionKey(assertionRef: string, runId: string): string {
  return `${assertionRef}\u0000${runId}`;
}

interface ExecutionRow {
  readonly execution: AssertionExecution;
  readonly depth: number;
}

interface ActionRow {
  readonly action: ActionRequestExecution;
  readonly depth: number;
}

interface ResultRow {
  readonly result: OriginatingAssertionResult;
  readonly depth: number;
}

type ExpandedRow = ExecutionRow | ActionRow | ResultRow;

function expandedRows(
  executions: readonly AssertionExecution[],
  actionRequests: readonly ActionRequestExecution[],
): ExpandedRow[] {
  const executionHandlers = new Map<string, AssertionExecution[]>();
  const actionHandlers = new Map<string, ActionRequestExecution[]>();
  const ownedActions = new Map<string, ActionRequestExecution[]>();
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
  const consumedActions = new Set<ActionRequestExecution>();
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
  actionRequests: readonly ActionRequestExecution[],
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

/** One defensive renderer shared by every durable Execution Report. */
export const renderExecutionEntry: EntryRenderer<unknown> = (
  entry,
  { expanded },
  theme,
) => {
  try {
    const data = parseEntryData(entry.data);
    if (data === undefined) return fallback(theme);
    const summary = summaryLine(data);
    const expandKey = keyText("app.tools.expand") || "ctrl+o";
    const lines = [
      expanded
        ? theme.fg("customMessageText", summary)
        : theme.fg("customMessageText", `${summary} (`) +
          theme.fg("dim", expandKey) +
          theme.fg("customMessageText", " to expand)"),
    ];

    if (expanded) {
      if (isToolHook(data.hook)) {
        for (const segment of data.segments) {
          if (
            segment.executions.length === 0 &&
            segment.actionRequests.length === 0
          ) {
            continue;
          }
          if (
            segment.trigger.event !== "tool_call" &&
            segment.trigger.event !== "tool_result"
          ) {
            continue;
          }
          lines.push(
            theme.fg(
              "dim",
              `${segment.trigger.event} ${segment.trigger.toolName} · id ${segment.trigger.toolCallId}`,
            ),
          );
          lines.push(...renderExpandedRows(
            segment.executions,
            segment.actionRequests,
            theme,
          ));
        }
      } else {
        const segment = data.segments[0]!;
        lines.push(...renderExpandedRows(
          segment.executions,
          segment.actionRequests,
          theme,
        ));
      }
    }
    return transcriptBox(theme, lines.join("\n"));
  } catch {
    return fallback(theme);
  }
};
