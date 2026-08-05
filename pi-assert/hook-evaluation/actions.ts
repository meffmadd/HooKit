import { actionRequest } from "../domain/entry.js";
import { matchResultSelector } from "./environment.js";
import type {
  ActionRequestExecution,
  AssertionResult,
  EvaluationEffect,
} from "./types.js";

export interface OwnedActionRequest {
  readonly effects: EvaluationEffect[];
  readonly actionRequests: ActionRequestExecution[];
}

/** Select one Assertion-owned Action against its immutable local result. */
export function requestOwnedAction(
  result: AssertionResult,
): OwnedActionRequest {
  const action = result.action;
  if (!action || !matchResultSelector(action, result)) {
    return { effects: [], actionRequests: [] };
  }

  return {
    effects: [{
      type: "request-action",
      assertionRef: result.assertionRef,
      runId: result.runId,
      action: actionRequest(action),
    }],
    actionRequests: [{
      assertionRef: result.assertionRef,
      runId: result.runId,
      hook: result.hook,
      actionType: action.type,
      outcome: result.outcome,
      ...(result.originatingResult === undefined
        ? {}
        : { originatingResult: result.originatingResult }),
    }],
  };
}
