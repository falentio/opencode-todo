/**
 * OpenCode v2 todo plugin.
 *
 * A port of `@gamaraan/todos-tool` (a pi coding-agent extension, itself a
 * port of Oh My Pi's todo tool) to OpenCode v2's plugin API.
 *
 * Wiring:
 * - `todo` tool       → `ctx.tool.transform`
 * - `/todo` command   → `ctx.command.transform`
 * - `todo-discipline` → `ctx.skill.transform`
 * - eager prelude, mid-run nudge, completion reminder → `ctx.session.hook`
 *   and `ctx.session.synthetic(..., resume: true)`
 * - state             → `ctx.storage`, one key per session
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { runTodoCommand } from "./command.ts";
import { resolveTodoConfig, type TodoConfig } from "./config.ts";
import { executeTodoOp } from "./execute.ts";
import { loadPhases, savePhases } from "./persistence.ts";
import { TODO_TOOL_DESCRIPTION } from "./prompts.ts";
import { loadSkill } from "./skill.ts";
import { clonePhases } from "./state.ts";
import { TodoTracker, type TrackerInput } from "./tracker.ts";
import { todoInputSchema, type TodoPhase } from "./types.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Everything the plugin knows about one session, besides the phases. */
interface SessionState {
  tracker: TodoTracker;
  phases: TodoPhase[] | undefined;
  lastAssistantText: string | undefined;
  seenUserMessage: boolean;
}

export default Plugin.define({
  id: "todo",
  async setup(ctx) {
    const config: TodoConfig = resolveTodoConfig({
      configDir: ctx.location.directory,
      cwd: ctx.location.directory,
      options: ctx.options,
      warn: (message) => console.error(`[opencode-todo] ${message}`),
    });

    if (!config.enabled) {
      console.error("[opencode-todo] disabled by configuration; the todo tool is not registered.");
      return () => {};
    }

    const sessions = new Map<string, SessionState>();

    function stateFor(sessionID: string): SessionState {
      let state = sessions.get(sessionID);
      if (!state) {
        state = {
          tracker: new TodoTracker(),
          phases: undefined,
          lastAssistantText: undefined,
          seenUserMessage: false,
        };
        sessions.set(sessionID, state);
      }
      return state;
    }

    /** Canonical phases for a session, loaded from storage on first use. */
    async function phasesFor(sessionID: string): Promise<TodoPhase[]> {
      const state = stateFor(sessionID);
      if (state.phases === undefined) {
        state.phases = (await loadPhases(ctx.storage, sessionID)) ?? [];
      }
      return state.phases;
    }

    async function setPhases(sessionID: string, phases: TodoPhase[]): Promise<void> {
      stateFor(sessionID).phases = clonePhases(phases);
      await savePhases(ctx.storage, sessionID, phases);
    }

    function trackerInput(sessionID: string): TrackerInput {
      const state = stateFor(sessionID);
      return {
        config,
        phases: state.phases ?? [],
        todoToolActive: true,
        hasUserMessage: state.seenUserMessage,
        hasPendingMessages: false,
      };
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "todo",
        description: TODO_TOOL_DESCRIPTION,
        options: { codemode: false },
        input: todoInputSchema,
        async execute(args: unknown, context) {
          const sessionID = context.sessionID;
          const previous = await phasesFor(sessionID);
          const outcome = executeTodoOp(previous, args, true);
          if (outcome.failed) throw new Error(outcome.summary);
          if (!outcome.readOnly) {
            await setPhases(sessionID, outcome.phases);
          }
          return {
            content: outcome.summary,
            metadata: {
              op: outcome.op,
              phases: outcome.phases,
            },
          };
        },
      });
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: "todo",
        description: "Show or edit the session todo list.",
        async execute(invocation) {
          const sessionID = invocation.sessionID;
          const args = (invocation.prompt?.text ?? "").trim();
          await runTodoCommand(
            {
              phasesFor,
              setPhases,
              cwd: () => ctx.location.directory,
              notify: (message) => {
                console.error(`[opencode-todo] ${message}`);
              },
              sendReminder: async (target, text) => {
                await ctx.session.synthetic({
                  sessionID: target,
                  text,
                  description: "todo edit",
                  resume: false,
                });
              },
            },
            sessionID,
            args,
          );
        },
      });
    });

    const skill = loadSkill(join(packageRoot, "skills"), "todo-discipline");
    if (!skill) {
      console.error(
        "[opencode-todo] skills/todo-discipline/SKILL.md missing or malformed; the skill is not registered.",
      );
    } else {
      const captured = skill;
      await ctx.skill.transform((editor) => {
        try {
          editor.add(captured as never);
        } catch (error) {
          console.error(
            `[opencode-todo] failed to register the todo-discipline skill: ${String(error)}`,
          );
        }
      });
    }

    await ctx.session.hook("context", (event) => {
      const state = stateFor(event.sessionID);
      state.seenUserMessage = true;
      for (const message of event.messages ?? []) {
        if (message.role === "user") state.seenUserMessage = true;
        if (message.role !== "assistant") continue;
        const text = messageText(message);
        if (text !== undefined) state.lastAssistantText = text;
      }
    });

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          if (event.type === "session.deleted") {
            const data = event.data as { sessionID?: string } | undefined;
            if (data?.sessionID) sessions.delete(data.sessionID);
            continue;
          }
          if (event.type === "session.tool.success") {
            const data = event.data as { sessionID?: string; name?: string } | undefined;
            if (!data?.sessionID) continue;
            stateFor(data.sessionID).tracker.onToolResult(data.name ?? "", false);
            continue;
          }
          if (event.type !== "session.execution.succeeded") continue;
          const data = event.data as { sessionID?: string } | undefined;
          const sessionID = data?.sessionID;
          if (!sessionID) continue;
          const state = stateFor(sessionID);
          if (state.phases === undefined) {
            state.phases = (await loadPhases(ctx.storage, sessionID)) ?? [];
          }
          const reminder = state.tracker.completionReminder(
            trackerInput(sessionID),
            state.lastAssistantText,
          );
          if (!reminder) continue;
          try {
            await ctx.session.synthetic({
              sessionID,
              text: reminder,
              description: "todo reminder",
              resume: true,
            });
          } catch (error) {
            console.error(`[opencode-todo] failed to send the todo reminder: ${String(error)}`);
          }
        }
      } catch {
        return;
      }
    })();

    return () => {
      controller.abort();
      sessions.clear();
    };
  },
});

function messageText(message: {
  content?: ReadonlyArray<{ type?: string; text?: unknown }>;
}): string | undefined {
  if (!Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const part of message.content) {
    if (part?.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  const text = parts.join("\n").trim();
  return text === "" ? undefined : text;
}
