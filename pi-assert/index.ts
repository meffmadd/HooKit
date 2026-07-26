import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AssertsState } from "./ui/state.js";
import { registerAssertsCommand } from "./ui/asserts.js";
import { clearRepoEntriesCache } from "./installer.js";
import {
  executeHookAsserts,
  formatRunReport,
  type RunRecord,
} from "./executor.js";
import {
  getHookAdapter,
  type HookAdapterOutcome,
  type HookEventMap,
} from "./adapters.js";
import type { Hook } from "./domain/entry.js";

function projectIsTrusted(ctx: ExtensionContext): boolean {
  const trustAware = ctx as ExtensionContext & { isProjectTrusted?: () => boolean };
  // Fail closed when running against a Pi build too old to expose trust.
  return trustAware.isProjectTrusted?.() ?? false;
}

// ---------------------------------------------------------------------------
// pi-assert extension entry point.
//
// This file is intentionally thin: it owns the lifecycle wiring (session
// start, session tree, hook events) and delegates everything else to the
// `ui/` modules.
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  const state = new AssertsState(pi);
  const correctiveFingerprints = new Map<string, string>();
  let promptRuns: RunRecord[] = [];

  // ── Load asserts on session start ─────────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    // The repo-entry cache is intentionally scoped to a Pi session.
    clearRepoEntriesCache();
    correctiveFingerprints.clear();
    state.load(ctx.cwd, projectIsTrusted(ctx));

    // Hard-fail: if either asserts.json file failed to parse, do NOT restore
    // any active set, do NOT install any asserts, and tell the user.
    if (state.broken) {
      const n = state.loadErrors.length;
      const details = state.loadErrors
        .map((e) => `  • ${e.path}: ${e.reason}`)
        .join("\n");
      ctx.ui.notify(
        `pi-assert: failed to parse ${n} config file${n === 1 ? "" : "s"}; no asserts are active.\n${details}`,
        "error",
      );
      state.updateStatus(ctx);
      return;
    }

    state.restore(ctx);
    state.updateStatus(ctx);

    if (state.asserts.length > 0) {
      ctx.ui.notify(
        `pi-assert: ${state.asserts.length} rule${state.asserts.length === 1 ? "" : "s"} loaded (${state.active.size} enabled)`,
        "info",
      );
    }
  });

  pi.on("agent_start", () => {
    promptRuns = [];
  });

  // ── Restore state when navigating the session tree ────────────────
  pi.on("session_tree", (_event, ctx) => {
    state.restore(ctx);
    state.updateStatus(ctx);
  });

  // ── /asserts command ──────────────────────────────────────────────
  registerAssertsCommand(pi, state);

  /** Run one registered adapter and dispatch its declared user feedback. */
  async function runHook<H extends Hook>(
    hook: H,
    event: HookEventMap[H],
    ctx: ExtensionContext,
  ): Promise<HookAdapterOutcome | undefined> {
    const adapter = getHookAdapter(hook);
    const outcome = await executeHookAsserts(
      state.activeList(),
      adapter,
      event,
      ctx,
      (record) => promptRuns.push(record),
    );

    // Preserve the existing quiet summary boundary at agent_end. turn_end runs
    // are included; agent_settled and session guards have their own feedback.
    if (hook === "agent_end" && promptRuns.length > 0 && ctx.hasUI) {
      ctx.ui.notify(formatRunReport(promptRuns), "info");
    }

    if (!outcome) {
      if (adapter.feedback === "corrective-turn") {
        correctiveFingerprints.delete(hook);
      }
      return undefined;
    }

    if (adapter.feedback === "notify-error") {
      if (ctx.hasUI) ctx.ui.notify(outcome.feedbackMessage, "error");
      return outcome;
    }

    // Corrective feedback is adapter-declared but dispatched centrally. This
    // keeps identical-failure retry suppression out of the execution core.
    if (outcome.action !== "report") return outcome;
    const fingerprint = outcome.fingerprint ?? outcome.messages.join("\n");
    if (correctiveFingerprints.get(hook) === fingerprint) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          outcome.repeatedFeedbackMessage ??
            "pi-assert: assertions still fail; automatic retry stopped.",
          "error",
        );
      }
      return outcome;
    }
    correctiveFingerprints.set(hook, fingerprint);
    pi.sendMessage(
      {
        customType: "pi-assert",
        content: outcome.feedbackMessage,
        display: true,
      },
      { triggerTurn: true },
    );
    return outcome;
  }

  /** Pi treats exceptions from session guards as no cancellation, so fail closed. */
  async function runSessionGuard<
    H extends "session_before_switch" | "session_before_fork",
  >(
    hook: H,
    event: HookEventMap[H],
    ctx: ExtensionContext,
  ): Promise<{ cancel: true } | undefined> {
    try {
      const outcome = await runHook(hook, event, ctx);
      return outcome?.action === "cancel" ? { cancel: true } : undefined;
    } catch (error) {
      const label = hook === "session_before_switch" ? "session switch" : "session fork";
      let detail = "unknown error";
      try {
        detail = error instanceof Error ? error.message : String(error);
      } catch {
        // Error formatting is best-effort; cancellation is not.
      }
      // Feedback must not be able to turn a guard failure into fail-open.
      try {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-assert: ${label} guard failed to execute; action cancelled — ${detail}`,
            "error",
          );
        }
      } catch {
        // The cancellation result below is the security boundary.
      }
      return { cancel: true };
    }
  }

  // Every supported Pi event is a thin binding to the same adapter executor.
  pi.on("tool_call", async (event, ctx) => {
    const outcome = await runHook("tool_call", event, ctx);
    if (outcome?.action === "block") {
      return { block: true, reason: outcome.reason };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const outcome = await runHook("tool_result", event, ctx);
    if (outcome?.action === "patch") return outcome.patch;
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

  pi.on("session_before_switch", (event, ctx) =>
    runSessionGuard("session_before_switch", event, ctx));

  pi.on("session_before_fork", (event, ctx) =>
    runSessionGuard("session_before_fork", event, ctx));
}
