import { randomUUID } from "node:crypto";
import { cloneAction, entryRef } from "../domain/entry.js";
import type { ActiveActionHandler } from "./assertions.js";
import { formatErrorDetail, type HookAdapter } from "./adapters.js";
import { matchFilter } from "./environment.js";
import { invocationEnvironment } from "./invocations.js";
import { evaluateShell } from "./shell.js";
import type {
  ActionRequestExecution,
  EvaluationEffect,
  HookExecutionContext,
  OriginatingAssertionResult,
} from "./types.js";

export interface ActionInvocationBatch {
  readonly effects: EvaluationEffect[];
  readonly actionRequests: ActionRequestExecution[];
}

interface ActionInvocationOptions {
  readonly originatingResult?: OriginatingAssertionResult;
}

function errorEffect(
  handler: ActiveActionHandler,
  detail: string,
): EvaluationEffect {
  return {
    type: "present",
    severity: "error",
    message: `pi-assert: Action Handler "${
      entryRef(handler.source, handler.name)
    }" failed to execute — ${detail}`,
  };
}

/** Match and gate Action Handlers in deterministic Active Assertion Set order. */
export async function invokeActionHandlers<E>(
  handlers: readonly ActiveActionHandler[],
  adapter: HookAdapter<E>,
  event: E,
  context: HookExecutionContext,
  options: ActionInvocationOptions = {},
): Promise<ActionInvocationBatch> {
  const effects: EvaluationEffect[] = [];
  const actionRequests: ActionRequestExecution[] = [];
  for (const handler of handlers) {
    if (handler.hook !== adapter.hook) continue;

    try {
      const matches = adapter.matchesFilter ?? matchFilter;
      if (!matches(handler.filter, adapter.candidate(event))) continue;

      const runId = randomUUID();
      const env = invocationEnvironment(handler, runId, adapter, event, context);
      if (handler.when) {
        const result = await evaluateShell(
          handler.when,
          env,
          context.signal,
          context.cwd,
        );
        if (result.code === null) {
          effects.push(errorEffect(
            handler,
            `precondition did not complete — \`${handler.when}\``,
          ));
          continue;
        }
        if (!result.passed) continue;
      }

      const assertionRef = entryRef(handler.source, handler.name);
      effects.push({
        type: "request-action",
        assertionRef,
        runId,
        action: cloneAction(handler.action),
      });
      actionRequests.push({
        assertionRef,
        runId,
        hook: handler.hook,
        actionType: handler.action.type,
        ...(options.originatingResult === undefined
          ? {}
          : { originatingResult: options.originatingResult }),
      });
    } catch (error) {
      effects.push(errorEffect(handler, formatErrorDetail(error)));
    }
  }
  return { effects, actionRequests };
}
