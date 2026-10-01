/**
 * Todo types and the tool's argument schema.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/tools/todo.ts` via the pi
 * extension `@gamaraan/todos-tool`. The TypeBox schema is replaced by a plain
 * JSON Schema (what OpenCode v2 tool definitions take) plus a hand-rolled
 * validator at the boundary.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export const TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "abandoned",
  "blocked",
];

/** Operation names accepted by the todo tool and echoed in successful result details. */
export type TodoOperation =
  | "init"
  | "start"
  | "done"
  | "rm"
  | "drop"
  | "block"
  | "unblock"
  | "append"
  | "view";

export const TODO_OPERATIONS: readonly TodoOperation[] = [
  "init",
  "start",
  "done",
  "rm",
  "drop",
  "block",
  "unblock",
  "append",
  "view",
];

export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** When `status === "blocked"`, an optional note on what the task is waiting for. */
  blocker?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

export interface TodoCompletionTransition {
  phase: string;
  content: string;
}

/** The snapshot the plugin persists per session. */
export interface TodoSnapshot {
  phases: TodoPhase[];
}

export interface TodoParams {
  op: TodoOperation;
  list?: Array<{ phase: string; items: string[] }>;
  task?: string;
  phase?: string;
  items?: string[];
  reason?: string;
}

/** JSON Schema for the `todo` tool's arguments, as OpenCode v2 expects. */
export const todoInputSchema = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: [...TODO_OPERATIONS],
      description: "operation to apply",
    },
    list: {
      type: "array",
      description: "phased task list (init)",
      items: {
        type: "object",
        properties: {
          phase: { type: "string", description: "phase name" },
          items: {
            type: "array",
            description: "tasks for this phase",
            items: { type: "string", description: "task content" },
          },
        },
        required: ["phase", "items"],
        additionalProperties: false,
      },
    },
    task: { type: "string", description: "task content" },
    phase: { type: "string", description: "phase name" },
    items: {
      type: "array",
      description: "tasks to append",
      items: { type: "string", description: "task content" },
    },
    reason: { type: "string", description: "blocker note (block op)" },
  },
  required: ["op"],
  additionalProperties: false,
} as const;
