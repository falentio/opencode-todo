/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import { buildTodoHud, phasesFromMessages, rowText } from "./hud.ts";
import type { TodoPhase } from "./types.ts";

// `@opencode/plugin/tui` is imported for types only: OpenCode does not resolve
// that specifier for installed plugins, so a value import would fail at load.
// `@opentui/solid` and `solid-js` are supplied by the host at runtime.

/** Backstop interval for a mutation that arrives without a tool event. */
const POLL_INTERVAL_MS = 2_000;

/** Fallback when the measured width is unavailable, matching the host's sidebar. */
const DEFAULT_WIDTH = 42;

const plugin: Plugin.Definition = {
  id: "opencode-todo.sidebar",
  setup(context) {
    try {
      const [phases, setPhases] = createSignal<TodoPhase[] | undefined>(undefined);
      let bound = "";

      const refresh = (sessionID: string): void => {
        try {
          setPhases(phasesFromMessages(context.data.session.message.list(sessionID)));
        } catch {
          // A read failure leaves the last good view on screen.
        }
      };

      context.data.on("session.tool.success", (event: unknown) => {
        const sessionID = (event as { data?: { sessionID?: unknown } } | undefined)?.data
          ?.sessionID;
        if (typeof sessionID !== "string" || sessionID !== bound) return;
        refresh(sessionID);
      });

      const timer = setInterval(() => {
        if (!bound) return;
        try {
          void Promise.resolve(context.data.session.message.sync(bound))
            .then(() => refresh(bound))
            .catch(() => {});
        } catch {
          // `sync` is a backstop; a failure just leaves the event path working.
        }
      }, POLL_INTERVAL_MS);
      try {
        context.lifecycle?.onDispose?.(() => clearInterval(timer));
      } catch {
        // No lifecycle hook available; the timer dies with the TUI process.
      }

      context.ui.slot({
        append: "sidebar.content",
        render: (input) => {
          const sessionID = input?.sessionID ?? "";
          if (sessionID && sessionID !== bound) {
            bound = sessionID;
            refresh(sessionID);
          }
          const view = phases();
          if (view === undefined) return null;
          return (
            <box flexDirection="column">
              {buildTodoHud(view).rows.map((row) => (
                <text>{rowText(row, DEFAULT_WIDTH)}</text>
              ))}
            </box>
          );
        },
      });
    } catch {
      // Never let a sidebar failure break the host TUI.
    }
  },
};

export default plugin;
