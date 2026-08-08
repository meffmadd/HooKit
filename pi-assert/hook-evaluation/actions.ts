import { actionRequest } from "../domain/entry.js";
import { matchResultSelector } from "./environment.js";
import type {
  AssertionResult,
  EvaluationEffect,
  EvaluationReportRow,
} from "./types.js";

export interface OwnedActionRequest {
  readonly effects: EvaluationEffect[];
  /** The ordered Action report row, when the owner's result selects it. */
  readonly row?: EvaluationReportRow;
}

/** Select one Assertion-owned Action against its immutable local result. */
export function requestOwnedAction(
  result: AssertionResult,
): OwnedActionRequest {
  const action = result.action;
  if (!action || !matchResultSelector(action, result)) {
    return { effects: [] };
  }

  return {
    effects: [{
      type: "request-action",
      assertionRef: result.assertionRef,
      runId: result.runId,
      action: actionRequest(action),
    }],
    row: {
      type: "action",
      assertionRef: result.assertionRef,
      actionType: action.type,
      outcome: result.outcome,
      ...(result.originatingResult === undefined
        ? {}
        : {
            origin: {
              assertionRef: result.originatingResult.assertionRef,
              outcome: result.originatingResult.outcome,
            },
          }),
    },
  };
}
