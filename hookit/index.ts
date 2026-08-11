import type {
  ExtensionAPI,
  ExtensionContext as PiExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { catalogStorageLocations } from "./config.js";
import { clearRepoEntriesCache } from "./installer.js";
import type { NativeEvent } from "./domain/entry.js";
import {
  HookEvaluation,
  type HookExecutionReport,
  type EvaluationEffect,
  type HookEvaluationResult,
  type EventMap,
  type EvaluationContext,
  type RuntimeMetadataSnapshot,
} from "./hook-evaluation/index.js";
import { registerHooksCommand } from "./ui/hooks.js";
import {
  EXECUTION_ENTRY_TYPE,
  ExecutionReporter,
  renderExecutionEntry,
  type ExecutionEventContext,
} from "./ui/execution-report.js";
import { HooksState } from "./ui/state.js";

type ThinkingAwareContext = PiExtensionContext & {
  readonly thinkingLevel?: string;
};

function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function projectIsTrusted(ctx: PiExtensionContext): boolean {
  return safeRead(() => ctx.isProjectTrusted?.() ?? false) ?? false;
}

function addString(
  metadata: Record<string, string>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) metadata[key] = value;
}

function addNumber(
  metadata: Record<string, string>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    metadata[key] = String(value);
  }
}

/** Snapshot Pi's rich callback context once onto the bounded module seam. */
function hookContext(
  pi: ExtensionAPI,
  ctx: PiExtensionContext,
): EvaluationContext {
  const metadata: Record<string, string> = {};
  const session = ctx.sessionManager;
  addString(metadata, "PI_SESSION_ID", safeRead(() => session.getSessionId()));
  addString(metadata, "PI_SESSION_FILE", safeRead(() => session.getSessionFile()));
  addString(metadata, "PI_SESSION_NAME", safeRead(() => session.getSessionName()));
  addString(metadata, "PI_SESSION_LEAF_ID", safeRead(() => session.getLeafId()));
  addString(metadata, "PI_PROVIDER", safeRead(() => ctx.model?.provider));
  addString(metadata, "PI_MODEL", safeRead(() => ctx.model?.id));

  const thinking = safeRead(() => (ctx as ThinkingAwareContext).thinkingLevel) ??
    safeRead(() => pi.getThinkingLevel());
  addString(metadata, "PI_REASONING_LEVEL", thinking);
  addString(metadata, "PI_MODE", safeRead(() => ctx.mode));

  const trusted = safeRead(() => ctx.isProjectTrusted?.());
  if (typeof trusted === "boolean") {
    metadata.PI_PROJECT_TRUSTED = trusted ? "true" : "false";
  }

  const usage = safeRead(() => ctx.getContextUsage?.());
  if (usage) {
    addNumber(metadata, "PI_CONTEXT_TOKENS", usage.tokens);
    addNumber(metadata, "PI_CONTEXT_WINDOW", usage.contextWindow);
    addNumber(metadata, "PI_CONTEXT_PERCENT", usage.percent);
  }

  return Object.freeze({
    cwd: ctx.cwd,
    signal: ctx.signal,
    metadata: Object.freeze(metadata) as RuntimeMetadataSnapshot,
  });
}

function executionEventContext(
  event: NativeEvent,
  payload: EventMap[NativeEvent],
): ExecutionEventContext {
  switch (event) {
    case "tool_call": {
      const toolEvent = payload as EventMap["tool_call"];
      return {
        event: "tool_call",
        toolName: toolEvent.toolName,
        toolCallId: toolEvent.toolCallId,
      };
    }
    case "tool_result": {
      const toolEvent = payload as EventMap["tool_result"];
      return {
        event: "tool_result",
        toolName: toolEvent.toolName,
        toolCallId: toolEvent.toolCallId,
      };
    }
    case "turn_end":
      return {
        event: "turn_end",
        turnIndex: (payload as EventMap["turn_end"]).turnIndex,
      };
    case "agent_end":
      return { event: "agent_end" };
    case "agent_settled":
      return { event: "agent_settled" };
    case "session_before_switch":
      return {
        event: "session_before_switch",
        reason: (payload as EventMap["session_before_switch"]).reason,
      };
    case "session_before_fork":
      return {
        event: "session_before_fork",
        position: (payload as EventMap["session_before_fork"]).position,
      };
  }
}

/** HooKit extension entry point and thin Pi-specific adapter. */
export default function (pi: ExtensionAPI) {
  const state = new HooksState(pi);
  const hookEvaluation = new HookEvaluation();
  const executionReporter = new ExecutionReporter({
    now: () => performance.now(),
    append: (entry) => {
      pi.appendEntry(EXECUTION_ENTRY_TYPE, entry);
    },
  });

  try {
    pi.registerEntryRenderer(EXECUTION_ENTRY_TYPE, renderExecutionEntry);
  } catch {
    // Guard behavior must not depend on transcript renderer registration.
  }

  pi.on("session_start", (_event, ctx) => {
    clearRepoEntriesCache();
    const trusted = projectIsTrusted(ctx);
    state.load(catalogStorageLocations(ctx.cwd, trusted), trusted);

    if (state.broken) {
      const count = state.loadErrors.length;
      const details = state.loadErrors
        .map((error) =>
          `  • ${error.storage ? `${error.storage} storage` : "catalog"}: ${error.reason}`
        )
        .join("\n");
      ctx.ui.notify(
        `hookit: failed to parse ${count} config file${
          count === 1 ? "" : "s"
        }; no hooks are active.\n${details}`,
        "error",
      );
      state.updateStatus(ctx);
      return;
    }

    state.restore(ctx);
    state.updateStatus(ctx);
    if (state.entries.length > 0) {
      ctx.ui.notify(
        `hookit: ${state.entries.length} hook${
          state.entries.length === 1 ? "" : "s"
        } loaded (${state.active.size} enabled)`,
        "info",
      );
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    state.restore(ctx);
    state.updateStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    executionReporter.flush();
  });

  // Passive tool lifecycle subscription: HooKit records the end-to-end
  // Execution Wave interval from the first `tool_execution_start` through the
  // final `tool_execution_end`. These are not configurable HooKit Events;
  // they only feed the reporter. Pi emits `tool_execution_end` after
  // `tool_result` handling, so the end timestamp includes Hooks handling that
  // Event and their Effect delivery (blocked tools still emit both lifecycle
  // events).
  pi.on("tool_execution_start", (event) => {
    const lifecycle = event as { toolName?: unknown; toolCallId?: unknown };
    if (
      typeof lifecycle.toolName === "string" &&
      typeof lifecycle.toolCallId === "string"
    ) {
      executionReporter.toolStarted(lifecycle.toolName, lifecycle.toolCallId);
    }
  });

  pi.on("tool_execution_end", (event) => {
    const lifecycle = event as { toolName?: unknown; toolCallId?: unknown };
    if (
      typeof lifecycle.toolName === "string" &&
      typeof lifecycle.toolCallId === "string"
    ) {
      executionReporter.toolEnded(lifecycle.toolName, lifecycle.toolCallId);
    }
  });

  registerHooksCommand(pi, state);

  function reportDeliveryFailure(
    ctx: PiExtensionContext,
    message: string,
  ): void {
    try {
      if (ctx.hasUI) ctx.ui.notify(message, "error");
    } catch {
      // Presentation cannot turn best-effort effect delivery into a failure.
    }
  }

  function deliverAction(
    effect: Extract<EvaluationEffect, { type: "request-action" }>,
    ctx: PiExtensionContext,
  ): void {
    const action = effect.action;
    switch (action.type) {
      case "interrupt":
        ctx.abort();
        return;
      case "shutdown":
        if (action.interrupt) ctx.abort();
        ctx.shutdown();
        return;
      case "compact":
        ctx.compact({
          ...(action.instructions === undefined
            ? {}
            : { customInstructions: action.instructions }),
          onError: (error) => {
            reportDeliveryFailure(
              ctx,
              `hookit: compact action from "${effect.hookRef}" failed — ${error.message}`,
            );
          },
        });
        return;
      case "message":
        pi.sendMessage(
          {
            customType: "hookit",
            content: action.message,
            display: true,
          },
          {
            deliverAs: action.delivery,
            triggerTurn: action.triggerTurn ?? false,
          },
        );
        return;
      case "emit-custom-event":
        pi.events.emit(action.name, action.data);
        return;
    }
  }

  async function deliverEffects(
    effects: readonly EvaluationEffect[],
    ctx: PiExtensionContext,
  ): Promise<void> {
    for (const effect of effects) {
      try {
        if (effect.type === "present") {
          if (ctx.hasUI) ctx.ui.notify(effect.message, effect.severity);
        } else if (effect.type === "request-corrective-turn") {
          pi.sendMessage(
            {
              customType: "hookit",
              content: effect.message,
              display: true,
            },
            { triggerTurn: true },
          );
        } else {
          deliverAction(effect, ctx);
        }
      } catch (error) {
        if (effect.type === "request-action") {
          const detail = error instanceof Error ? error.message : String(error);
          reportDeliveryFailure(
            ctx,
            `hookit: action from "${effect.hookRef}" delivery failed — ${detail}`,
          );
        }
        // Every delivery is best-effort; continue with later ordered effects.
      }
    }
  }

  async function displayControlOutcome(
    result: HookEvaluationResult,
    ctx: PiExtensionContext,
  ): Promise<void> {
    if (
      result.outcome !== "block" &&
      result.outcome !== "patch" &&
      result.outcome !== "cancel"
    ) {
      return;
    }
    try {
      if (ctx.hasUI) ctx.ui.notify(result.reason, "error");
    } catch {
      // Native control translation below must not depend on presentation.
    }
  }

  async function runEvent<H extends NativeEvent>(
    event: H,
    payload: EventMap[H],
    ctx: PiExtensionContext,
  ): Promise<HookEvaluationResult<H>> {
    // The observation opens at callback entry and covers every HooKit owned
    // blocking step: capture, Evaluation, effect delivery, and feedback.
    const observation = executionReporter.begin(
      event,
      executionEventContext(event, payload),
    );
    let result: HookEvaluationResult<H>;
    let accounting: HookExecutionReport | undefined;
    try {
      // Both values are captured synchronously at callback entry. Activation or
      // rich Pi-context changes during awaits apply only to the next evaluation.
      const activeSet = state.activeHookSet();
      const context = hookContext(pi, ctx);
      result = await hookEvaluation.evaluate(event, payload, context, activeSet);
      accounting = result.executionReport;
      await deliverEffects(result.effects, ctx);
      await displayControlOutcome(result, ctx);
    } finally {
      // Completion must also happen on an unexpected escape so an open
      // observation can never poison later reporting.
      executionReporter.complete(observation, accounting);
    }
    return result;
  }

  pi.on("tool_call", async (event, ctx) => {
    const result = await runEvent("tool_call", event, ctx);
    if (result.outcome === "block") {
      return { block: true, reason: result.reason };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const result = await runEvent("tool_result", event, ctx);
    if (result.outcome === "patch") {
      return {
        content: result.patch.content?.map((block) => ({ ...block })),
        details: result.patch.details,
        isError: result.patch.isError,
      };
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    await runEvent("turn_end", event, ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    await runEvent("agent_end", event, ctx);
  });

  pi.on("agent_settled", async (event, ctx) => {
    await runEvent("agent_settled", event, ctx);
  });

  pi.on("session_before_switch", async (event, ctx) => {
    const result = await runEvent("session_before_switch", event, ctx);
    if (result.outcome === "cancel") return { cancel: true };
  });

  pi.on("session_before_fork", async (event, ctx) => {
    const result = await runEvent("session_before_fork", event, ctx);
    if (result.outcome === "cancel") return { cancel: true };
  });
}
