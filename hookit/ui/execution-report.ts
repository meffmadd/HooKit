import {
  keyText,
  type EntryRenderer,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
  isActionType,
  isHookResultOutcome,
  type NativeEvent,
} from "../domain/entry.js";
import type {
  HookExecutionReport,
  EvaluationReportRow,
} from "../hook-evaluation/index.js";

export const EXECUTION_ENTRY_TYPE = "hookit-execution";
const MAX_LABEL_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_DURATION_MS = 2_147_483_647;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Bounded Event context for a non-tool Hook Evaluation. */
export type NonToolEventContext =
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

/** Bounded Event context for one Hook Evaluation observed by the reporter. */
export type ExecutionEventContext =
  | {
      readonly event: "tool_call" | "tool_result";
      readonly toolName: string;
      readonly toolCallId: string;
    }
  | NonToolEventContext;

/** One completed tool claimed by `tool_execution_start`/`_end` lifecycle. */
export interface ToolIdentity {
  readonly toolName: string;
  readonly toolCallId: string;
}

/** One tool Event segment in callback-entry order. */
export interface ToolEventSegment {
  readonly eventContext: {
    readonly event: "tool_call" | "tool_result";
    readonly toolName: string;
    readonly toolCallId: string;
  };
  readonly rows: readonly EvaluationReportRow[];
}

/** One non-tool Hook Evaluation's ordered rows. */
export interface NonToolEventSegment {
  readonly eventContext: NonToolEventContext;
  readonly rows: readonly EvaluationReportRow[];
}

/**
 * The one current persistence-safe shape for an Execution Report: a combined
 * Execution Wave (every tool Event segment under one
 * end-to-end duration) or an ordinary single Hook Evaluation.
 */
export type ExecutionReportEntryData =
  | {
      readonly type: "tool-wave";
      readonly durationMs: number;
      readonly tools: readonly ToolIdentity[];
      readonly segments: readonly ToolEventSegment[];
    }
  | {
      readonly type: "event";
      readonly durationMs: number;
      readonly segment: NonToolEventSegment;
    };

/**
 * Transient reporter handle for one native callback's observation. The
 * reporter owns timing and collection only; it never changes native outcomes
 * or effect selection/delivery.
 */
export interface ReporterObservation {
  readonly event: NativeEvent;
  readonly eventContext: ExecutionEventContext;
  readonly startMs: number;
  endMs?: number;
  completed: boolean;
  rows?: HookExecutionReport;
}

function isToolEvent(event: NativeEvent): boolean {
  return event === "tool_call" || event === "tool_result";
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

function boundedDurationMs(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  return Math.min(MAX_DURATION_MS, Math.floor(value));
}

function snapshotEventContext(
  eventContext: ExecutionEventContext,
): ExecutionEventContext {
  switch (eventContext.event) {
    case "tool_call":
    case "tool_result":
      return {
        event: eventContext.event,
        toolName: cleanText(eventContext.toolName, MAX_LABEL_LENGTH) || "unknown",
        toolCallId: cleanText(eventContext.toolCallId, MAX_ID_LENGTH) || "unknown",
      };
    case "turn_end":
      return {
        event: "turn_end",
        turnIndex: Math.max(0, Math.floor(eventContext.turnIndex)),
      };
    case "agent_end":
    case "agent_settled":
      return { event: eventContext.event };
    case "session_before_switch":
      return {
        event: "session_before_switch",
        reason: eventContext.reason,
      };
    case "session_before_fork":
      return {
        event: "session_before_fork",
        position: eventContext.position,
      };
  }
}

/** Clean, bound, and snapshot one immutable Hook Evaluation report row. */
function snapshotRow(row: EvaluationReportRow): EvaluationReportRow {
  if (row.type === "hook") {
    return {
      type: "hook",
      hookRef: cleanText(row.hookRef, MAX_LABEL_LENGTH) || "unknown",
      durationMs: boundedDurationMs(row.durationMs),
      passed: row.passed,
      ...(row.origin === undefined
        ? {}
        : {
            origin: {
              hookRef:
                cleanText(row.origin.hookRef, MAX_LABEL_LENGTH) || "unknown",
              outcome: row.origin.outcome,
            },
          }),
    };
  }
  return {
    type: "action",
    hookRef: cleanText(row.hookRef, MAX_LABEL_LENGTH) || "unknown",
    actionType: row.actionType,
    outcome: row.outcome,
    ...(row.origin === undefined
      ? {}
      : {
          origin: {
            hookRef:
              cleanText(row.origin.hookRef, MAX_LABEL_LENGTH) || "unknown",
            outcome: row.origin.outcome,
          },
        }),
  };
}

interface PendingTool {
  readonly toolName: string;
  readonly toolCallId: string;
  startMs?: number;
  endMs?: number;
}

interface PendingWave {
  readonly tools: Map<string, PendingTool>;
  readonly observations: ReporterObservation[];
}

/**
 * Session-scoped collector that turns every tool Hook Evaluation for one
 * Execution Wave into one combined report, and keeps non-tool Hook Evaluations
 * as
 * single immediate reports. It owns no native outcomes, effects, or Action
 * delivery, and never constructs causal Hook trees.
 */
export class ExecutionReporter {
  private readonly now: () => number;
  private readonly persist: (entry: ExecutionReportEntryData) => void;
  private pendingWave: PendingWave | undefined;

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
   * Open (or extend) the pending Execution Wave for a tool that started.
   * Tool identity is recorded in `tool_execution_start` order. Must be
   * paired with {@link toolEnded} so the wave can receive its duration.
   */
  toolStarted(toolName: string, toolCallId: string): void {
    let wave = this.pendingWave;
    if (wave === undefined) {
      wave = this.pendingWave = { tools: new Map(), observations: [] };
    }
    let tool = wave.tools.get(toolCallId);
    if (tool === undefined) {
      // Correlate lifecycle with Pi's exact identity. Labels are cleaned and
      // bounded only when the durable shape is built, so distinct raw ids can
      // never collapse onto one pending tool.
      tool = { toolName, toolCallId };
      wave.tools.set(toolCallId, tool);
    }
    if (tool.startMs === undefined) tool.startMs = this.now();
  }

  /**
   * Close the matching tool interval. Pi emits `tool_execution_end` after
   * `tool_result` handling, so the end timestamp includes Hooks handling that
   * Event and their Effect delivery. Unknown ids are ignored defensively.
   */
  toolEnded(toolName: string, toolCallId: string): void {
    const wave = this.pendingWave;
    if (wave === undefined) return;
    const tool = wave.tools.get(toolCallId);
    if (tool === undefined) return;
    void toolName;
    if (tool.endMs === undefined) tool.endMs = this.now();
  }

  /**
   * Open one observation at callback entry. A pending tool wave is flushed
   * before a non-tool interval starts; normal Pi order flushes the completed
   * wave at `turn_end`, with `agent_end` as the fallback boundary. Timing
   * starts before any capture.
   */
  begin(
    event: NativeEvent,
    eventContext: ExecutionEventContext,
  ): ReporterObservation {
    if (!isToolEvent(event)) this.flushWave();
    const observation: ReporterObservation = {
      event,
      eventContext,
      startMs: this.now(),
      completed: false,
    };
    if (isToolEvent(event)) {
      if (this.pendingWave === undefined) {
        this.pendingWave = { tools: new Map(), observations: [] };
      }
      // Segment order is assigned here, so overlapping completions cannot
      // reorder groups.
      this.pendingWave.observations.push(observation);
    }
    return observation;
  }

  /**
   * Close one observation with its optional Hook Evaluation report. Tool
   * observations join the pending Execution Wave; ordinary observations build
   * and append their one-segment report immediately when they carry data.
   * Must be called on every exit (including an unexpected escape) so an open
   * observation can never poison later reporting.
   */
  complete(
    observation: ReporterObservation,
    accounting?: HookExecutionReport,
  ): void {
    if (observation.completed) return; // never double-append a report
    observation.endMs = this.now();
    observation.rows = accounting;
    observation.completed = true;
    if (!isToolEvent(observation.event)) {
      this.appendSingle(observation);
    }
  }

  /**
   * Flush a completed pending wave and discard any still-open observation or
   * an incomplete tool lifecycle. Never invents a tool end. Safe to call from
   * `session_shutdown` and idempotent when nothing is pending.
   */
  flush(): void {
    this.flushWave();
  }

  private flushWave(): void {
    const wave = this.pendingWave;
    this.pendingWave = undefined;
    if (wave === undefined) return;

    const observations = wave.observations.filter((segment) => segment.completed);
    if (observations.length === 0) return;

    // A wave with an incomplete tool lifecycle is not given an invented end
    // time; shutdown and boundaries discard it. Tools without lifecycle
    // identity are likewise dropped defensively.
    const tools = Array.from(wave.tools.values());
    if (tools.length === 0) return;
    const complete = tools.every(
      (tool) => tool.startMs !== undefined && tool.endMs !== undefined,
    );
    if (!complete) return;

    const hasData = observations.some(
      (observation) =>
        (observation.rows?.rows.length ?? 0) > 0,
    );
    if (!hasData) return;

    this.persistOrDrop(this.buildWaveEntry(tools, observations));
  }

  private buildWaveEntry(
    tools: readonly PendingTool[],
    observations: readonly ReporterObservation[],
  ): ExecutionReportEntryData {
    const starts = tools.map((tool) => tool.startMs ?? 0);
    const ends = tools.map((tool) => tool.endMs ?? 0);
    const durationMs = boundedDurationMs(Math.max(...ends) - Math.min(...starts));

    const segments: ToolEventSegment[] = observations.map((observation) => {
      const eventContext = snapshotEventContext(observation.eventContext);
      return {
        eventContext: {
          event: eventContext.event as "tool_call" | "tool_result",
          toolName:
            eventContext.event === "tool_call" || eventContext.event === "tool_result"
              ? eventContext.toolName
              : "unknown",
          toolCallId:
            eventContext.event === "tool_call" || eventContext.event === "tool_result"
              ? eventContext.toolCallId
              : "unknown",
        },
        rows: snapshotRows(observation.rows),
      };
    });

    return {
      type: "tool-wave",
      durationMs,
      tools: tools.map((tool) => ({
        toolName: cleanText(tool.toolName, MAX_LABEL_LENGTH) || "unknown",
        toolCallId: cleanText(tool.toolCallId, MAX_ID_LENGTH) || "unknown",
      })),
      segments,
    };
  }

  private appendSingle(observation: ReporterObservation): void {
    const rows = observation.rows;
    if (rows === undefined || rows.rows.length === 0) return;
    const durationMs = boundedDurationMs(
      (observation.endMs ?? observation.startMs) - observation.startMs,
    );
    this.persistOrDrop({
      type: "event",
      durationMs,
      segment: {
        eventContext: snapshotEventContext(
          observation.eventContext,
        ) as NonToolEventContext,
        rows: snapshotRows(rows),
      },
    });
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

function snapshotRows(accounting: HookExecutionReport | undefined): EvaluationReportRow[] {
  return (accounting?.rows ?? []).map(snapshotRow);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEventContext(value: unknown): ExecutionEventContext | undefined {
  if (!isRecord(value) || typeof value.event !== "string") return undefined;
  if (
    value.event === "tool_call" || value.event === "tool_result"
  ) {
    const toolName = requiredText(value.toolName, MAX_LABEL_LENGTH);
    const toolCallId = requiredText(value.toolCallId, MAX_ID_LENGTH);
    return toolName === undefined || toolCallId === undefined
      ? undefined
      : { event: value.event, toolName, toolCallId };
  }
  if (value.event === "turn_end") {
    return typeof value.turnIndex === "number" &&
        Number.isFinite(value.turnIndex) && value.turnIndex >= 0
      ? { event: "turn_end", turnIndex: Math.floor(value.turnIndex) }
      : undefined;
  }
  if (value.event === "agent_end" || value.event === "agent_settled") {
    return { event: value.event };
  }
  if (value.event === "session_before_switch") {
    return value.reason === "new" || value.reason === "resume"
      ? { event: "session_before_switch", reason: value.reason }
      : undefined;
  }
  if (value.event === "session_before_fork") {
    return value.position === "before" || value.position === "at"
      ? { event: "session_before_fork", position: value.position }
      : undefined;
  }
  return undefined;
}

type ReportedOrigin = {
  readonly hookRef: string;
  readonly outcome: "pass" | "block" | "patch" | "cancel" | "report";
};

function parseOrigin(value: unknown): ReportedOrigin | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["hookRef", "outcome"])) {
    return undefined;
  }
  const hookRef = requiredText(value.hookRef, MAX_LABEL_LENGTH);
  if (hookRef === undefined || !isHookResultOutcome(value.outcome)) {
    return undefined;
  }
  return { hookRef, outcome: value.outcome };
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function parseRow(value: unknown): EvaluationReportRow | undefined {
  if (!isRecord(value) || value.type !== "hook" && value.type !== "action") {
    return undefined;
  }
  const rowKeys = value.type === "hook"
    ? ["type", "hookRef", "durationMs", "passed", "origin"]
    : ["type", "hookRef", "actionType", "outcome", "origin"];
  if (!hasOnlyKeys(value, rowKeys)) return undefined;

  const hookRef = requiredText(value.hookRef, MAX_LABEL_LENGTH);
  if (hookRef === undefined) return undefined;

  let origin: ReportedOrigin | undefined;
  if (value.origin !== undefined) {
    origin = parseOrigin(value.origin);
    if (origin === undefined) return undefined;
  }

  if (value.type === "hook") {
    if (
      typeof value.durationMs !== "number" ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
      typeof value.passed !== "boolean"
    ) {
      return undefined;
    }
    return {
      type: "hook",
      hookRef,
      durationMs: Math.floor(value.durationMs),
      passed: value.passed,
      ...(origin === undefined ? {} : { origin }),
    };
  }

  if (
    !isActionType(value.actionType) ||
    !isHookResultOutcome(value.outcome)
  ) {
    return undefined;
  }
  return {
    type: "action",
    hookRef,
    actionType: value.actionType,
    outcome: value.outcome,
    ...(origin === undefined ? {} : { origin }),
  };
}

function parseRows(value: unknown): EvaluationReportRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: EvaluationReportRow[] = [];
  for (const raw of value) {
    const row = parseRow(raw);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return rows;
}

type ParsedEntryData = ExecutionReportEntryData;

function parseEntryData(value: unknown): ParsedEntryData | undefined {
  if (
    !isRecord(value) ||
    (value.type !== "tool-wave" && value.type !== "event") ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    value.durationMs > MAX_DURATION_MS
  ) {
    return undefined;
  }
  const durationMs = Math.floor(value.durationMs);

  if (value.type === "tool-wave") {
    if (
      !Array.isArray(value.tools) ||
      !Array.isArray(value.segments) ||
      value.segments.length === 0
    ) {
      return undefined;
    }
    const tools: ToolIdentity[] = [];
    for (const raw of value.tools) {
      if (!isRecord(raw)) return undefined;
      const toolName = requiredText(raw.toolName, MAX_LABEL_LENGTH);
      const toolCallId = requiredText(raw.toolCallId, MAX_ID_LENGTH);
      if (toolName === undefined || toolCallId === undefined) return undefined;
      tools.push({ toolName, toolCallId });
    }
    if (tools.length === 0) return undefined;

    let hasRows = false;
    const segments: ToolEventSegment[] = [];
    for (const raw of value.segments) {
      if (!isRecord(raw)) return undefined;
      const eventContext = parseEventContext(raw.eventContext);
      if (
        eventContext === undefined ||
        eventContext.event !== "tool_call" && eventContext.event !== "tool_result"
      ) {
        return undefined;
      }
      const rows = parseRows(raw.rows);
      if (rows === undefined) return undefined;
      const toolSegment: ToolEventSegment = {
        eventContext: {
          event: eventContext.event,
          toolName: eventContext.toolName,
          toolCallId: eventContext.toolCallId,
        },
        rows,
      };
      if (rows.length > 0) hasRows = true;
      segments.push(toolSegment);
    }
    if (!hasRows) return undefined;
    return { type: "tool-wave", durationMs, tools, segments };
  }

  if (!isRecord(value.segment)) return undefined;
  const eventContext = parseEventContext(value.segment.eventContext);
  if (
    eventContext === undefined ||
    eventContext.event === "tool_call" || eventContext.event === "tool_result"
  ) {
    return undefined;
  }
  const rows = parseRows(value.segment.rows);
  if (rows === undefined || rows.length === 0) return undefined;
  return {
    type: "event",
    durationMs,
    segment: { eventContext: eventContext as NonToolEventContext, rows },
  };
}

function eventLabel(eventContext: NonToolEventContext): string {
  switch (eventContext.event) {
    case "turn_end":
      return `turn_end ${eventContext.turnIndex}`;
    case "agent_end":
    case "agent_settled":
      return eventContext.event;
    case "session_before_switch":
      return `session_before_switch ${eventContext.reason}`;
    case "session_before_fork":
      return `session_before_fork ${eventContext.position}`;
  }
}

/** `bash ×3, read ×1` — completed tools grouped by name, each unique lifecycle identity counted once. */
function toolBreakdown(data: Extract<ParsedEntryData, { type: "tool-wave" }>): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const tool of data.tools) {
    if (!counts.has(tool.toolName)) order.push(tool.toolName);
    counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
  }
  return order.map((name) => `${name} ×${counts.get(name)}`).join(", ");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function summaryCore(
  hookCount: number,
  actionCount: number,
  durationMs: number,
  guardWord: "guarded" | "ran",
  toolCount?: number,
): string {
  const milliseconds = `in ${durationMs}ms`;
  if (hookCount === 0) {
    // Action-only: never claim a Hook command ran.
    return `requested ${plural(actionCount, "Action")} ${milliseconds}`;
  }
  const hooks = toolCount === undefined
    ? `${guardWord} ${plural(hookCount, "Hook")}`
    : `${guardWord} ${plural(toolCount, "tool")} with ${plural(hookCount, "Hook")}`;
  if (actionCount === 0) return `${hooks} ${milliseconds}`;
  return `${hooks} and requested ${plural(actionCount, "Action")} ${milliseconds}`;
}

function summaryLine(data: ParsedEntryData): string {
  if (data.type === "tool-wave") {
    const hookCount = data.segments.reduce(
      (total, segment) =>
        total + segment.rows.filter((row) => row.type === "hook").length,
      0,
    );
    const actionCount = data.segments.reduce(
      (total, segment) =>
        total + segment.rows.filter((row) => row.type === "action").length,
      0,
    );
    const core = summaryCore(
      hookCount,
      actionCount,
      data.durationMs,
      "guarded",
      data.tools.length,
    );
    return `HooKit ${core} · ${toolBreakdown(data)}`;
  }
  const hookCount = data.segment.rows.filter(
    (row) => row.type === "hook",
  ).length;
  const actionCount = data.segment.rows.filter(
    (row) => row.type === "action",
  ).length;
  const core = summaryCore(hookCount, actionCount, data.durationMs, "ran");
  return `HooKit ${core} · ${eventLabel(data.segment.eventContext)}`;
}

/**
 * Render ordered report rows flat. Rows come from Hook Evaluation in
 * result-major order; the renderer adds no causal maps, depth, or synthetic
 * display-only result rows. Hook rows show their individual duration
 * and a `from` origin annotation for synthetic rows; Action rows show type
 * and owner outcome plus the same optional origin annotation.
 */
function renderFlatRows(rows: readonly EvaluationReportRow[], theme: Theme): string[] {
  const hookRows = rows.filter((row) => row.type === "hook");
  const maxLabel = hookRows.reduce(
    (maximum, row) => Math.max(maximum, visibleWidth(`✓ ${row.hookRef}`)),
    0,
  );

  return rows.map((row) => {
    if (row.type === "hook") {
      const glyph = row.passed
        ? theme.fg("success", "✓")
        : theme.fg("error", "✗");
      const label = `${glyph} ${theme.fg("text", row.hookRef)}`;
      const plain = `${glyph} ${row.hookRef}`;
      const padding = " ".repeat(Math.max(2, maxLabel - visibleWidth(plain)));
      const duration = theme.fg("dim", `${row.durationMs}ms`);
      const origin = row.origin === undefined
        ? ""
        : theme.fg(
            "dim",
            ` · from ${row.origin.hookRef} ${row.origin.outcome}`,
          );
      return `${label}${padding}${duration}${origin}`;
    }

    const detail = theme.fg(
      "dim",
      ` · ${row.actionType} requested · ${row.outcome}`,
    );
    const origin = row.origin === undefined
      ? ""
      : theme.fg(
          "dim",
          ` · from ${row.origin.hookRef} ${row.origin.outcome}`,
        );
    return (
      `${theme.fg("accent", "→")} ${theme.fg("text", row.hookRef)}` +
      detail + origin
    );
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
    theme.fg("error", "HooKit execution summary unavailable"),
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
      if (data.type === "tool-wave") {
        for (const segment of data.segments) {
          if (segment.rows.length === 0) continue;
          lines.push(
            theme.fg(
              "dim",
              `${segment.eventContext.event} ${segment.eventContext.toolName} · id ${segment.eventContext.toolCallId}`,
            ),
          );
          lines.push(...renderFlatRows(segment.rows, theme));
        }
      } else {
        lines.push(...renderFlatRows(data.segment.rows, theme));
      }
    }
    return transcriptBox(theme, lines.join("\n"));
  } catch {
    return fallback(theme);
  }
};
