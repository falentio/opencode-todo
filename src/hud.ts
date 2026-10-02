/**
 * The sidebar's todo view model.
 *
 * Host-free by design: this module carries no OpenCode import so it can be
 * unit tested directly, matching `state.ts` and `format.ts`. `tui.tsx` is the
 * only adapter, and it stays a thin render shell.
 *
 * The data comes off the session's own assistant messages rather than a side
 * channel: the `todo` tool already returns `metadata.phases`, so the sidebar
 * reads back what the tool already wrote. No RPC, no second storage key.
 */

import { COLLAPSED_ITEMS_CAP, selectCollapsedTodos } from "./state.ts";
import type { TodoPhase, TodoStatus } from "./types.ts";
import { isValidTodoPhases } from "./validate.ts";

/** One line in the sidebar. */
export type HudRow =
  | { kind: "summary"; done: number; total: number; blocked: number }
  | { kind: "phase"; name: string; done: number; total: number }
  | { kind: "task"; content: string; status: TodoStatus; blocker?: string }
  | { kind: "more"; hidden: number }
  | { kind: "empty" };

export interface TodoHud {
  done: number;
  total: number;
  open: number;
  blocked: number;
  rows: HudRow[];
}

export interface TodoHudOptions {
  /** Per-phase task rows to show before collapsing. */
  cap?: number;
}

const TOOL_NAME = "todo";

/**
 * Usable sidebar content width in columns.
 *
 * Measured against the host: a row longer than 37 columns is cut by the host
 * rather than by `rowText`, which loses the ellipsis and can split a word. 36
 * keeps a column of margin under that limit.
 */
export const SIDEBAR_WIDTH = 36;

/** Marker per status. Exhaustive over `TodoStatus`, so a new status is a type error, not a silent fallback. */
export const TODO_STATUS_MARKERS: Record<TodoStatus, string> = {
  completed: "✓",
  abandoned: "✗",
  in_progress: "●",
  pending: "○",
  blocked: "⊘",
};

/** The single line the sidebar draws for a row, truncated to `width`. */
export function rowText(row: HudRow, width: number = SIDEBAR_WIDTH): string {
  // Truncate the ASSEMBLED line, not each field: a task and its blocker note
  // each fitting the width can still overflow once joined, and an overflowing
  // row wraps and breaks the column layout.
  return truncate(rawRowText(row), width);
}

function rawRowText(row: HudRow): string {
  switch (row.kind) {
    case "summary": {
      const blocked = row.blocked > 0 ? `, ${row.blocked} blocked` : "";
      return `${row.done}/${row.total} done${blocked}`;
    }
    case "phase":
      return `${row.name} ${row.done}/${row.total}`;
    case "task": {
      const note = row.status === "blocked" && row.blocker ? ` (${row.blocker})` : "";
      return `${TODO_STATUS_MARKERS[row.status]} ${row.content}${note}`;
    }
    case "more":
      return `… ${row.hidden} more`;
    case "empty":
      return "No todos";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The phases carried by the last completed `todo` tool result.
 *
 * `undefined` means no todo list exists in this session, so the sidebar draws
 * nothing. `[]` means the list exists and is empty — a cleared list is
 * authoritative and must not be mistaken for "no list", the same distinction
 * `loadPhases` makes for storage.
 */
export function phasesFromMessages(messages: unknown): TodoPhase[] | undefined {
  if (!Array.isArray(messages)) return undefined;

  let found: TodoPhase[] | undefined;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      if (part.type !== "tool" || part.name !== TOOL_NAME) continue;
      const state = part.state;
      if (!isRecord(state) || state.status !== "completed") continue;
      const metadata = state.metadata;
      if (!isRecord(metadata)) continue;
      const phases = metadata.phases;
      if (!isValidTodoPhases(phases)) continue;
      // Keep scanning: the LAST completed result wins, so a later init
      // supersedes an earlier one.
      found = phases;
    }
  }
  return found;
}

function isDone(status: TodoStatus): boolean {
  return status === "completed" || status === "abandoned";
}

function truncate(value: string, width: number): string {
  if (width <= 1) return value.slice(0, Math.max(0, width));
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

/** Build the sidebar view. Row text is truncated to the terminal width by `rowText`. */
export function buildTodoHud(phases: TodoPhase[], options: TodoHudOptions = {}): TodoHud {
  const cap = options.cap ?? COLLAPSED_ITEMS_CAP;

  let done = 0;
  let open = 0;
  let blocked = 0;
  let total = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      total++;
      if (isDone(task.status)) done++;
      else if (task.status === "blocked") blocked++;
      else open++;
    }
  }

  if (total === 0) {
    return { done: 0, total: 0, open: 0, blocked: 0, rows: [{ kind: "empty" }] };
  }

  const rows: HudRow[] = [{ kind: "summary", done, total, blocked }];
  for (const phase of phases) {
    const phaseDone = phase.tasks.filter((task) => isDone(task.status)).length;
    rows.push({
      kind: "phase",
      name: phase.name,
      done: phaseDone,
      total: phase.tasks.length,
    });
    if (phase.tasks.length === 0) continue;

    const selection = selectCollapsedTodos(phase.tasks, () => false, cap);
    for (const task of selection.items) {
      rows.push({
        kind: "task",
        content: task.content,
        status: task.status,
        ...(task.blocker === undefined ? {} : { blocker: task.blocker }),
      });
    }
    const hidden = phase.tasks.length - selection.items.length;
    if (hidden > 0) rows.push({ kind: "more", hidden });
  }

  return { done, total, open, blocked, rows };
}
