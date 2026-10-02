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
 * Usable sidebar content width in display columns.
 *
 * Measured against the host: a row wider than 37 columns wraps onto a second
 * screen row, which breaks the column layout. 36 keeps a column of margin.
 * The unit is display columns, not UTF-16 code units: a CJK or emoji
 * character occupies two columns, so counting code units would let a row wrap.
 */
export const SIDEBAR_WIDTH = 36;

/** Grapheme clusters, so a combining mark or an emoji ZWJ sequence stays whole. */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Two columns: East Asian Wide and Fullwidth forms, and emoji.
 *
 * Everything else counts one column. The segmenter has already merged
 * combining marks and variation selectors into their base cluster, so the only
 * thing this can misjudge is a cluster that renders zero columns on its own,
 * and counting that as one truncates a row a column early rather than letting
 * it wrap.
 */
const WIDE =
  /[\p{Extended_Pictographic}\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

function clusterWidth(cluster: string): number {
  return WIDE.test(cluster) ? 2 : 1;
}

/** Columns a string occupies in a terminal. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of SEGMENTER.segment(value)) width += clusterWidth(segment);
  return width;
}

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

/**
 * Truncate to `width` display columns, keeping a trailing ellipsis.
 *
 * Measured in columns, not code units, because the host wraps a row that
 * exceeds the sidebar's column budget: a CJK character is one code unit and
 * two columns, so a unit-based cap lets a row wrap. The cut is made on
 * grapheme clusters, so it cannot land inside an emoji's surrogate pair or
 * separate a combining mark from its base.
 */
function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  // Leave room for the ellipsis, except at width 1 where there is none to
  // spare: a bare glyph beats a lone surrogate.
  const budget = width <= 1 ? width : width - 1;
  const kept: string[] = [];
  let used = 0;
  for (const { segment } of SEGMENTER.segment(value)) {
    const size = clusterWidth(segment);
    if (used + size > budget) break;
    kept.push(segment);
    used += size;
  }
  return width <= 1 ? kept.join("") : `${kept.join("")}…`;
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
