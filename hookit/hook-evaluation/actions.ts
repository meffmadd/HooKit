import { actionRequest } from "../domain/entry.js";
import { matchResultSelector } from "./environment.js";
import type {
  HookResult,
  Effect,
  EvaluationReportRow,
} from "./types.js";

export interface OwnedActionRequest {
  readonly effects: Effect[];
  /** The ordered Action report row, when the owner's result selects it. */
  readonly row?: EvaluationReportRow;
}

/** Select one Hook-owned Action against its immutable local result. */
export function requestOwnedAction(
  result: HookResult,
): OwnedActionRequest {
  const action = result.action;
  if (!action || !matchResultSelector(action, result)) {
    return { effects: [] };
  }

  return {
    effects: [{
      type: "request-action",
      hookRef: result.hookRef,
      invocationId: result.invocationId,
      action: actionRequest(action),
    }],
    row: {
      type: "action",
      hookRef: result.hookRef,
      actionType: action.type,
      outcome: result.outcome,
      ...(result.originatingResult === undefined
        ? {}
        : {
            origin: {
              hookRef: result.originatingResult.hookRef,
              outcome: result.originatingResult.outcome,
            },
          }),
    },
  };
}
