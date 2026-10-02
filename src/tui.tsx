/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import { buildTodoHud, phasesFromMessages, rowText, SIDEBAR_WIDTH } from "./hud.ts";
import type { TodoPhase } from "./types.ts";

// `@opencode/plugin/tui` is imported for types only: OpenCode does not resolve
// that specifier for installed plugins, so a value import would fail at load.
// `@opentui/solid` and `solid-js` are supplied by the host at runtime.

/** Backstop interval for a mutation that arrives without a tool event. */
const POLL_INTERVAL_MS = 2_000;

const plugin: Plugin.Definition = {
  id: "opencode-todo.sidebar",
  setup(context) {
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
      const sessionID = (event as { data?: { sessionID?: unknown } } | undefined)?.data?.sessionID;
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
        // This callback runs on a timer, outside the host's own guard around
        // `setup`, so a synchronous throw here would be unhandled and take the
        // user's TUI down. The poll is only a backstop, so swallowing it leaves
        // the event path working.
      }
    }, POLL_INTERVAL_MS);
    // The context exposes no dispose hook, so the timer lives as long as the
    // TUI process does. That is the plugin's own lifetime, so nothing leaks
    // beyond it.
    timer.unref?.();

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
              <text>{rowText(row, SIDEBAR_WIDTH)}</text>
            ))}
          </box>
        );
      },
    });
  },
};

export default plugin;
