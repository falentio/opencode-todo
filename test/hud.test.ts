/**
 * Sidebar view model tests.
 *
 * `src/hud.ts` is host-free, so it is exercised directly here like the other
 * pure modules. The TUI entry is a thin shell over these functions.
 */

import { describe, expect, it } from "vite-plus/test";
import { buildTodoHud, phasesFromMessages, rowText } from "../src/hud.ts";
import { COLLAPSED_ITEMS_CAP } from "../src/state.ts";
import type { TodoItem, TodoPhase, TodoStatus } from "../src/types.ts";

function task(content: string, status: TodoStatus, blocker?: string): TodoItem {
  return blocker === undefined ? { content, status } : { content, status, blocker };
}

function phase(name: string, tasks: TodoItem[]): TodoPhase {
  return { name, tasks };
}

/** A session message list carrying one completed todo tool result. */
function messagesWith(phases: unknown, status = "completed") {
  return [
    { type: "assistant", content: [{ type: "text", text: "working" }] },
    {
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "todo",
          state: { status, input: { op: "init" }, metadata: { op: "init", phases } },
        },
      ],
    },
  ];
}

describe("phasesFromMessages", () => {
  it("returns undefined when no todo tool result is present", () => {
    const messages = [{ type: "assistant", content: [{ type: "text", text: "hi" }] }];
    expect(phasesFromMessages(messages)).toBeUndefined();
  });

  it("returns undefined for an unrecognized message list", () => {
    expect(phasesFromMessages(undefined)).toBeUndefined();
    expect(phasesFromMessages("nope")).toBeUndefined();
    expect(phasesFromMessages([null, 42])).toBeUndefined();
  });

  it("ignores a todo tool result that is not completed", () => {
    const phases = [phase("P", [task("a", "pending")])];
    expect(phasesFromMessages(messagesWith(phases, "running"))).toBeUndefined();
  });

  it("returns the phases of the last completed result", () => {
    const first = [phase("Old", [task("stale", "pending")])];
    const second = [phase("New", [task("fresh", "pending")])];
    const messages = [...messagesWith(first), ...messagesWith(second)];
    const result = phasesFromMessages(messages);
    expect(result?.map((p) => p.name)).toEqual(["New"]);
  });

  it("returns an empty array for an explicitly cleared list", () => {
    expect(phasesFromMessages(messagesWith([]))).toEqual([]);
  });

  it("ignores a malformed phases payload without throwing", () => {
    expect(phasesFromMessages(messagesWith({ not: "an array" }))).toBeUndefined();
    expect(phasesFromMessages(messagesWith([{ name: "P" }]))).toBeUndefined();
    expect(
      phasesFromMessages(messagesWith([{ name: "P", tasks: [{ content: "a", status: "nope" }] }])),
    ).toBeUndefined();
  });

  it("ignores a result whose metadata is missing", () => {
    const messages = [
      {
        type: "assistant",
        content: [{ type: "tool", name: "todo", state: { status: "completed" } }],
      },
    ];
    expect(phasesFromMessages(messages)).toBeUndefined();
  });
});

describe("buildTodoHud", () => {
  it("counts done, open, and blocked, treating abandoned as done", () => {
    const phases = [
      phase("Foundation", [
        task("a", "completed"),
        task("b", "abandoned"),
        task("c", "in_progress"),
        task("d", "pending"),
      ]),
      phase("Auth", [task("e", "blocked", "waiting on review")]),
    ];
    const hud = buildTodoHud(phases);
    expect(hud.total).toBe(5);
    expect(hud.done).toBe(2);
    expect(hud.open).toBe(2);
    expect(hud.blocked).toBe(1);
  });

  it("yields a single empty row for no tasks", () => {
    expect(buildTodoHud([]).rows).toEqual([{ kind: "empty" }]);
    expect(buildTodoHud([phase("Empty", [])]).rows).toEqual([{ kind: "empty" }]);
  });

  it("emits a phase row, its task rows, then a more row", () => {
    const tasks = Array.from({ length: 4 }, (_, i) => task(`t${i}`, "pending"));
    const hud = buildTodoHud([phase("P", tasks)], { cap: 2 });
    expect(hud.rows.map((row) => row.kind)).toEqual(["summary", "phase", "task", "task", "more"]);
    expect(hud.rows.at(-1)).toEqual({ kind: "more", hidden: 2 });
  });

  it("does not emit a more row when everything fits", () => {
    const hud = buildTodoHud([phase("P", [task("a", "pending")])]);
    expect(hud.rows.map((row) => row.kind)).toEqual(["summary", "phase", "task"]);
  });

  it("leads with a summary row carrying the totals", () => {
    const phases = [phase("P", [task("a", "completed"), task("b", "blocked")])];
    expect(buildTodoHud(phases).rows[0]).toEqual({
      kind: "summary",
      done: 1,
      total: 2,
      blocked: 1,
    });
  });

  it("caps at the collapsed items default", () => {
    const tasks = Array.from({ length: COLLAPSED_ITEMS_CAP + 3 }, (_, i) =>
      task(`t${i}`, "pending"),
    );
    const hud = buildTodoHud([phase("P", tasks)]);
    const more = hud.rows.find((row) => row.kind === "more");
    expect(more).toEqual({ kind: "more", hidden: 3 });
  });

  it("carries the blocker note on a blocked task row", () => {
    const hud = buildTodoHud([phase("P", [task("e", "blocked", "waiting on review")])]);
    expect(hud.rows[2]).toEqual({
      kind: "task",
      content: "e",
      status: "blocked",
      blocker: "waiting on review",
    });
  });

  it("truncates a long row to the available width", () => {
    const long = "x".repeat(100);
    const hud = buildTodoHud([phase("P", [task(long, "pending")])]);
    const row = hud.rows[2];
    expect(row?.kind === "task" && rowText(row, 10).length).toBe(10);
  });

  it("truncates the joined line, so a task and its blocker cannot overflow", () => {
    const blockedTask = task("x".repeat(20), "blocked", "y".repeat(20));
    const hud = buildTodoHud([phase("P", [blockedTask])]);
    const row = hud.rows[2];
    if (row === undefined) throw new Error("expected a task row");
    expect(rowText(row, 24).length).toBe(24);
  });

  it("keeps the default row within the host's measured sidebar width", () => {
    // The host cuts a row past 37 columns, which loses the ellipsis, so the
    // default must stay under it.
    const long = task("w".repeat(200), "blocked", "b".repeat(200));
    const hud = buildTodoHud([phase("P".repeat(50), [long])]);
    for (const row of hud.rows) {
      expect(rowText(row).length).toBeLessThanOrEqual(37);
    }
  });

  it("never splits a surrogate pair when truncating", () => {
    // Slicing at a fixed code-unit index can land inside an emoji and leave a
    // lone surrogate, which renders as a replacement character.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const cases = [
      task("🎉".repeat(50), "pending"),
      task("日本語".repeat(50), "pending"),
      task("🎉".repeat(30), "blocked", "🎉".repeat(30)),
      task("👨‍👩‍👧‍👦".repeat(20), "pending"),
    ];
    for (const item of cases) {
      const row = buildTodoHud([phase("P", [item])]).rows[2];
      if (row === undefined) throw new Error("expected a task row");
      const text = rowText(row);
      expect(text.length).toBeLessThanOrEqual(37);
      expect(lone.test(text)).toBe(false);
    }
  });

  it("holds the width and the surrogate rule at every width", () => {
    // The narrow widths matter too: the first version sliced blindly below
    // width 2 and emitted a lone surrogate from an emoji phase name.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const rows = [
      { kind: "task", content: "🎉".repeat(30), status: "blocked", blocker: "🎉".repeat(30) },
      { kind: "phase", name: "🎉🎉🎉", done: 1, total: 2 },
      { kind: "phase", name: "日本語".repeat(20), done: 0, total: 1 },
      { kind: "summary", done: 1, total: 2, blocked: 1 },
      { kind: "more", hidden: 9 },
      { kind: "empty" },
    ] as const;
    for (let width = 0; width <= 40; width++) {
      for (const row of rows) {
        const text = rowText(row, width);
        expect(lone.test(text)).toBe(false);
        expect(text.length).toBeLessThanOrEqual(Math.max(width, 0));
      }
    }
  });
});

describe("rowText", () => {
  it("labels a phase with its done count", () => {
    expect(rowText({ kind: "phase", name: "Foundation", done: 1, total: 3 })).toBe(
      "Foundation 1/3",
    );
  });

  it("summarizes the list, naming blocked work only when there is some", () => {
    expect(rowText({ kind: "summary", done: 2, total: 5, blocked: 0 })).toBe("2/5 done");
    expect(rowText({ kind: "summary", done: 2, total: 5, blocked: 1 })).toBe("2/5 done, 1 blocked");
  });

  it("marks each status distinctly", () => {
    const seen = new Set(
      (["completed", "abandoned", "in_progress", "pending", "blocked"] as const).map((status) =>
        rowText({ kind: "task", content: "x", status }),
      ),
    );
    expect(seen.size).toBe(5);
  });

  it("appends a blocker note only for a blocked task", () => {
    expect(rowText({ kind: "task", content: "e", status: "blocked", blocker: "review" }, 80)).toBe(
      "⊘ e (review)",
    );
    expect(rowText({ kind: "task", content: "e", status: "pending", blocker: "review" }, 80)).toBe(
      "○ e",
    );
  });

  it("renders the more and empty rows", () => {
    expect(rowText({ kind: "more", hidden: 4 })).toBe("… 4 more");
    expect(rowText({ kind: "empty" })).toBe("No todos");
  });
});
