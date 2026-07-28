import type {
  ExtensionAPI,
  ExtensionContext as PiExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { clearRepoEntriesCache } from "./installer.js";
import type { NativeHook } from "./domain/entry.js";
import {
  HookEvaluation,
  type EvaluationEffect,
  type HookEvaluationResult,
  type HookEventMap,
  type HookExecutionContext,
  type RuntimeMetadataSnapshot,
} from "./hook-evaluation/index.js";
import { registerAssertsCommand } from "./ui/asserts.js";
import { AssertsState } from "./ui/state.js";

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
function assertionContext(
  pi: ExtensionAPI,
  ctx: PiExtensionContext,
): HookExecutionContext {
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

/** pi-assert extension entry point and thin Pi-specific adapter. */
export default function (pi: ExtensionAPI) {
  const state = new AssertsState(pi);
  const hookEvaluation = new HookEvaluation();

  pi.on("session_start", (_event, ctx) => {
    clearRepoEntriesCache();
    state.load(ctx.cwd, projectIsTrusted(ctx));

    if (state.broken) {
      const count = state.loadErrors.length;
      const details = state.loadErrors
        .map((error) => `  • ${error.path}: ${error.reason}`)
        .join("\n");
      ctx.ui.notify(
        `pi-assert: failed to parse ${count} config file${
          count === 1 ? "" : "s"
        }; no asserts are active.\n${details}`,
        "error",
      );
      state.updateStatus(ctx);
      return;
    }

    state.restore(ctx);
    state.updateStatus(ctx);
    if (state.asserts.length > 0) {
      ctx.ui.notify(
        `pi-assert: ${state.asserts.length} rule${
          state.asserts.length === 1 ? "" : "s"
        } loaded (${state.active.size} enabled)`,
        "info",
      );
    }
  });

  pi.on("agent_start", () => {
    hookEvaluation.beginPrompt();
  });

  pi.on("session_tree", (_event, ctx) => {
    state.restore(ctx);
    state.updateStatus(ctx);
  });

  registerAssertsCommand(pi, state);

  async function deliverEffects(
    effects: readonly EvaluationEffect[],
    ctx: PiExtensionContext,
  ): Promise<void> {
    for (const effect of effects) {
      try {
        if (effect.type === "present") {
          if (ctx.hasUI) ctx.ui.notify(effect.message, effect.severity);
        } else {
          pi.sendMessage(
            {
              customType: "pi-assert",
              content: effect.message,
              display: true,
            },
            { triggerTurn: true },
          );
        }
      } catch {
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

  async function runHook<H extends NativeHook>(
    hook: H,
    event: HookEventMap[H],
    ctx: PiExtensionContext,
  ): Promise<HookEvaluationResult<H>> {
    // Both values are captured synchronously at callback entry. Activation or
    // rich Pi-context changes during awaits apply only to the next evaluation.
    const activeSet = state.activeAssertionSet();
    const context = assertionContext(pi, ctx);
    const result = await hookEvaluation.evaluate(hook, event, context, activeSet);
    await deliverEffects(result.effects, ctx);
    await displayControlOutcome(result, ctx);
    return result;
  }

  pi.on("tool_call", async (event, ctx) => {
    const result = await runHook("tool_call", event, ctx);
    if (result.outcome === "block") {
      return { block: true, reason: result.reason };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const result = await runHook("tool_result", event, ctx);
    if (result.outcome === "patch") {
      return {
        content: result.patch.content?.map((block) => ({ ...block })),
        details: result.patch.details,
        isError: result.patch.isError,
      };
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    await runHook("turn_end", event, ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    await runHook("agent_end", event, ctx);
  });

  pi.on("agent_settled", async (event, ctx) => {
    await runHook("agent_settled", event, ctx);
  });

  pi.on("session_before_switch", async (event, ctx) => {
    const result = await runHook("session_before_switch", event, ctx);
    if (result.outcome === "cancel") return { cancel: true };
  });

  pi.on("session_before_fork", async (event, ctx) => {
    const result = await runHook("session_before_fork", event, ctx);
    if (result.outcome === "cancel") return { cancel: true };
  });
}
