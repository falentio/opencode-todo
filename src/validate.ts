/**
 * Structural validation for raw `todo` tool arguments.
 *
 * The pi extension used TypeBox's `Value.Check`; OpenCode v2 hands plugins
 * untyped JSON, so the same checks are expressed directly. This is the one
 * place raw model output becomes a typed `TodoParams`.
 */

import {
  TODO_OPERATIONS,
  TODO_STATUSES,
  type TodoOperation,
  type TodoParams,
  type TodoPhase,
  type TodoStatus,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoOperation(value: unknown): value is TodoOperation {
  return typeof value === "string" && (TODO_OPERATIONS as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isInitListEntry(value: unknown): value is { phase: string; items: string[] } {
  if (!isRecord(value)) return false;
  return typeof value.phase === "string" && isStringArray(value.items);
}

/**
 * Validate the tool arguments. `op` is required here; a missing `op` is
 * repaired by {@link resolveTodoParams} before this runs.
 *
 * The schema is intentionally permissive about which fields are present for
 * which op: `items: []` on an op that ignores it must not be a hard rejection,
 * and every op-specific requirement is enforced with an op-specific error
 * message by the state layer instead.
 */
export function isValidTodoParams(value: unknown): value is TodoParams {
  if (!isRecord(value)) return false;
  if (!isTodoOperation(value.op)) return false;

  const { list, task, phase, items, reason } = value;
  if (list !== undefined) {
    if (!Array.isArray(list)) return false;
    if (!list.every(isInitListEntry)) return false;
  }
  if (task !== undefined && typeof task !== "string") return false;
  if (phase !== undefined && typeof phase !== "string") return false;
  if (items !== undefined && !isStringArray(items)) return false;
  if (reason !== undefined && typeof reason !== "string") return false;

  return true;
}

/** Human-readable reason a raw argument object failed validation. */
export function describeTodoParamsError(value: unknown): string {
  if (!isRecord(value)) return "(root): must be an object";
  if (!isTodoOperation(value.op)) {
    if (value.op === undefined) return "(root): missing required property op";
    return `(root): op must be one of ${TODO_OPERATIONS.join(", ")}`;
  }
  const { list, task, phase, items, reason } = value;
  if (list !== undefined && !Array.isArray(list)) {
    return "list: must be an array of {phase, items}";
  }
  if (Array.isArray(list) && !list.every(isInitListEntry)) {
    return "list: every entry must be {phase: string, items: string[]}";
  }
  if (task !== undefined && typeof task !== "string") {
    return "task: must be a string";
  }
  if (phase !== undefined && typeof phase !== "string") {
    return "phase: must be a string";
  }
  if (items !== undefined && !isStringArray(items)) {
    return "items: must be an array of strings";
  }
  if (reason !== undefined && typeof reason !== "string") {
    return "reason: must be a string";
  }
  return "(root): invalid todo arguments";
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

/**
 * Accept a persisted phases array only when every entry structurally
 * validates. Session storage is JSON a previous version or a hand edit could
 * have corrupted; a `phase.tasks` that is not an array would otherwise crash
 * every read.
 */
export function isTodoPhase(value: unknown): value is TodoPhase {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string" || !Array.isArray(value.tasks)) return false;
  return value.tasks.every((task) => {
    if (!isRecord(task)) return false;
    if (typeof task.content !== "string") return false;
    if (!isTodoStatus(task.status)) return false;
    return task.blocker === undefined || typeof task.blocker === "string";
  });
}

export function isValidTodoPhases(value: unknown): value is TodoPhase[] {
  return Array.isArray(value) && value.every(isTodoPhase);
}
