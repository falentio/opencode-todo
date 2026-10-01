/**
 * Tests for the plugin's v2-facing modules: argument validation, config
 * resolution, session persistence, the tracker's budgets and guards, and the
 * `/todo` verbs.
 */

import { describe, expect, it } from "vite-plus/test";
import { TODO_CONFIG_DEFAULTS, resolveTodoConfig } from "../src/config.ts";
import { executeTodoOp } from "../src/execute.ts";
import {
  findPhaseFuzzy,
  findTaskFuzzy,
  buildSystemReminder,
  runTodoCommand,
  tokenize,
} from "../src/command.ts";
import { loadPhases, savePhases, todoKey } from "../src/persistence.ts";
import { loadSkill, splitFrontmatter } from "../src/skill.ts";
import {
  blockedTasks,
  isAwaitingUserAnswerText,
  openTasks,
  TodoTracker,
  type TrackerInput,
} from "../src/tracker.ts";
import { describeTodoParamsError, isValidTodoParams, isValidTodoPhases } from "../src/validate.ts";
import type { TodoPhase } from "../src/types.ts";

function trackerInput(overrides: Partial<TrackerInput> = {}): TrackerInput {
  return {
    config: { ...TODO_CONFIG_DEFAULTS, reminders: true, remindersMax: 3 },
    phases: [],
    todoToolActive: true,
    hasUserMessage: true,
    hasPendingMessages: false,
    ...overrides,
  };
}

function phases(): TodoPhase[] {
  return [
    {
      name: "Alpha",
      tasks: [
        { content: "first", status: "in_progress" },
        { content: "second", status: "pending" },
      ],
    },
  ];
}

describe("validate: tool arguments", () => {
  it("accepts a well-formed init", () => {
    expect(
      isValidTodoParams({
        op: "init",
        list: [{ phase: "A", items: ["x"] }],
      }),
    ).toBe(true);
  });

  it("accepts a stray empty items array on an op that ignores it", () => {
    // `items: []` on `view` must not be a hard schema rejection.
    expect(isValidTodoParams({ op: "view", items: [] })).toBe(true);
  });

  it("rejects an unknown op and names it", () => {
    expect(isValidTodoParams({ op: "explode" })).toBe(false);
    expect(describeTodoParamsError({ op: "explode" })).toContain("op must be one of");
  });

  it("rejects a malformed list entry", () => {
    expect(isValidTodoParams({ op: "init", list: [{ phase: "A" }] })).toBe(false);
    expect(describeTodoParamsError({ op: "init", list: [{ phase: "A" }] })).toContain("list:");
  });

  it("reports a missing op distinctly", () => {
    expect(describeTodoParamsError({ list: [] })).toContain("missing required property op");
  });
});

describe("validate: persisted phases", () => {
  it("accepts a valid snapshot", () => {
    expect(isValidTodoPhases(phases())).toBe(true);
  });

  it("rejects a phase whose tasks is not an array", () => {
    expect(isValidTodoPhases([{ name: "A", tasks: "nope" }])).toBe(false);
  });

  it("rejects a wrongly-typed blocker", () => {
    expect(
      isValidTodoPhases([{ name: "A", tasks: [{ content: "x", status: "blocked", blocker: 7 }] }]),
    ).toBe(false);
  });
});

describe("config: precedence", () => {
  const base = { configDir: "/nonexistent-a", cwd: "/nonexistent-b" };

  it("falls back to the built-in defaults", () => {
    expect(resolveTodoConfig(base)).toEqual(TODO_CONFIG_DEFAULTS);
  });

  it("takes an environment override", () => {
    const config = resolveTodoConfig({
      ...base,
      env: { OPENCODE_TODO_EAGER: "always" },
    });
    expect(config.eager).toBe("always");
  });

  it("lets a plugin option beat the environment", () => {
    const config = resolveTodoConfig({
      ...base,
      env: { OPENCODE_TODO_EAGER: "preferred" },
      options: { eager: "always" },
    });
    expect(config.eager).toBe("always");
  });

  it("warns and keeps the previous value for an invalid override", () => {
    const warnings: string[] = [];
    const config = resolveTodoConfig({
      ...base,
      env: { OPENCODE_TODO_EAGER: "sometimes" },
      warn: (message) => warnings.push(message),
    });
    expect(config.eager).toBe("default");
    expect(warnings.join("\n")).toContain("ignoring invalid");
  });

  it("lets options disable the plugin", () => {
    expect(resolveTodoConfig({ ...base, options: { enabled: false } }).enabled).toBe(false);
  });
});

describe("persistence: session snapshots", () => {
  function memoryStore() {
    const data = new Map<string, unknown>();
    return {
      data,
      async get(key: string) {
        return data.get(key);
      },
      async set(key: string, value: unknown) {
        data.set(key, value);
      },
      async remove(key: string) {
        data.delete(key);
      },
    };
  }

  it("round-trips phases", async () => {
    const store = memoryStore();
    await savePhases(store, "ses_a", phases());
    expect(await loadPhases(store, "ses_a")).toEqual(phases());
  });

  it("returns undefined when nothing was stored", async () => {
    const store = memoryStore();
    expect(await loadPhases(store, "ses_a")).toBeUndefined();
  });

  it("returns [] for an explicitly cleared list, not undefined", async () => {
    const store = memoryStore();
    await savePhases(store, "ses_a", []);
    expect(await loadPhases(store, "ses_a")).toEqual([]);
  });

  it("ignores a corrupt snapshot instead of throwing", async () => {
    const store = memoryStore();
    store.data.set(todoKey("ses_a"), { phases: [{ name: "A", tasks: 5 }] });
    expect(await loadPhases(store, "ses_a")).toBeUndefined();
  });

  it("keeps sessions separate", async () => {
    const store = memoryStore();
    await savePhases(store, "ses_a", phases());
    await savePhases(store, "ses_b", []);
    expect(await loadPhases(store, "ses_b")).toEqual([]);
    expect(await loadPhases(store, "ses_a")).toEqual(phases());
  });
});

describe("tracker: open and blocked tasks", () => {
  it("collects open tasks in phase order", () => {
    expect(openTasks(phases()).map((task) => task.content)).toEqual(["first", "second"]);
  });

  it("excludes completed and abandoned tasks", () => {
    const closed = [
      {
        name: "A",
        tasks: [
          { content: "done", status: "completed" as const },
          { content: "dropped", status: "abandoned" as const },
        ],
      },
    ];
    expect(openTasks(closed)).toEqual([]);
  });

  it("reports blocked tasks separately, with their blocker", () => {
    const withBlocked = [
      {
        name: "A",
        tasks: [{ content: "waiting", status: "blocked" as const, blocker: "sign-off" }],
      },
    ];
    expect(openTasks(withBlocked)).toEqual([]);
    expect(blockedTasks(withBlocked)).toEqual([
      { phase: "A", content: "waiting", blocker: "sign-off" },
    ]);
  });
});

describe("tracker: awaiting-user heuristic", () => {
  it("detects a closing question", () => {
    expect(isAwaitingUserAnswerText("Which option do you prefer?")).toBe(true);
  });

  it("detects a question wrapped in markdown emphasis", () => {
    expect(isAwaitingUserAnswerText("Done with step one.\n**Should I continue?**")).toBe(true);
    expect(isAwaitingUserAnswerText("_What do you think?_")).toBe(true);
  });

  it("detects a response cue", () => {
    expect(isAwaitingUserAnswerText("Please confirm the target branch.")).toBe(true);
    expect(isAwaitingUserAnswerText("Answer yes or no.")).toBe(true);
  });

  it("only inspects the last line", () => {
    // The heuristics read one line, so a question buried mid-line is not a
    // cue. This matches the source's own behavior.
    expect(isAwaitingUserAnswerText("First question?\nThen I'll wait for your reply.")).toBe(false);
    expect(isAwaitingUserAnswerText("Let me check the code.\nWhich approach should I take?")).toBe(
      true,
    );
  });

  it("does not fire on a plain statement", () => {
    expect(isAwaitingUserAnswerText("I finished the first part.")).toBe(false);
  });

  it("does not fire on an empty or missing message", () => {
    expect(isAwaitingUserAnswerText(undefined)).toBe(false);
    expect(isAwaitingUserAnswerText("   ")).toBe(false);
  });
});

describe("tracker: eager prelude", () => {
  it("serves once for a fresh session in preferred mode", () => {
    const tracker = new TodoTracker();
    const input = trackerInput({
      config: { ...TODO_CONFIG_DEFAULTS, eager: "preferred" },
      hasUserMessage: false,
    });
    expect(tracker.createEagerTodoPrelude(input, "build a thing")).toContain("todo");
    expect(tracker.createEagerTodoPrelude(input, "build a thing")).toBeUndefined();
  });

  it("stays silent in default mode", () => {
    const tracker = new TodoTracker();
    expect(
      tracker.createEagerTodoPrelude(trackerInput({ hasUserMessage: false }), "build a thing"),
    ).toBeUndefined();
  });

  it("skips a question and an exclamation", () => {
    const input = trackerInput({
      config: { ...TODO_CONFIG_DEFAULTS, eager: "preferred" },
      hasUserMessage: false,
    });
    expect(new TodoTracker().createEagerTodoPrelude(input, "what is this?")).toBeUndefined();
    expect(new TodoTracker().createEagerTodoPrelude(input, "stop!")).toBeUndefined();
  });

  it("skips a resumed session that already has a user message", () => {
    const input = trackerInput({
      config: { ...TODO_CONFIG_DEFAULTS, eager: "preferred" },
      hasUserMessage: true,
    });
    expect(new TodoTracker().createEagerTodoPrelude(input, "continue")).toBeUndefined();
  });

  it("skips when a list already exists or the tool is inactive", () => {
    const withList = trackerInput({
      config: { ...TODO_CONFIG_DEFAULTS, eager: "preferred" },
      hasUserMessage: false,
      phases: phases(),
    });
    expect(new TodoTracker().createEagerTodoPrelude(withList, "go")).toBeUndefined();
    const inactive = trackerInput({
      config: { ...TODO_CONFIG_DEFAULTS, eager: "preferred" },
      hasUserMessage: false,
      todoToolActive: false,
    });
    expect(new TodoTracker().createEagerTodoPrelude(inactive, "go")).toBeUndefined();
  });
});

describe("tracker: mid-run nudge", () => {
  it("stays silent below the mutation threshold", () => {
    const tracker = new TodoTracker();
    for (let i = 0; i < 11; i++) tracker.onToolResult("shell", false);
    expect(tracker.takeMidRunNudge(trackerInput({ phases: phases() }))).toBeNull();
  });

  it("fires at the threshold and caps at two per cycle", () => {
    const tracker = new TodoTracker();
    const input = trackerInput({ phases: phases() });
    for (let i = 0; i < 12; i++) tracker.onToolResult("shell", false);
    expect(tracker.takeMidRunNudge(input)).toContain("2 todo items still open");
    for (let i = 0; i < 12; i++) tracker.onToolResult("shell", false);
    expect(tracker.takeMidRunNudge(input)).not.toBeNull();
    for (let i = 0; i < 12; i++) tracker.onToolResult("shell", false);
    expect(tracker.takeMidRunNudge(input)).toBeNull();
  });

  it("resets the mutation budget when the todo tool runs", () => {
    const tracker = new TodoTracker();
    for (let i = 0; i < 12; i++) tracker.onToolResult("shell", false);
    tracker.onToolResult("todo", false);
    expect(tracker.takeMidRunNudge(trackerInput({ phases: phases() }))).toBeNull();
  });

  it("does not count a failed tool result", () => {
    const tracker = new TodoTracker();
    for (let i = 0; i < 12; i++) tracker.onToolResult("shell", true);
    expect(tracker.takeMidRunNudge(trackerInput({ phases: phases() }))).toBeNull();
  });

  it("stays silent with no open tasks or with reminders off", () => {
    const tracker = new TodoTracker();
    for (let i = 0; i < 12; i++) tracker.onToolResult("shell", false);
    expect(tracker.takeMidRunNudge(trackerInput({ phases: [] }))).toBeNull();
    const off = trackerInput({
      config: { ...TODO_CONFIG_DEFAULTS, reminders: false },
      phases: phases(),
    });
    expect(tracker.takeMidRunNudge(off)).toBeNull();
  });
});

describe("tracker: completion reminder", () => {
  it("fires once, then pauses until progress, then respects the cap", () => {
    const tracker = new TodoTracker();
    const input = trackerInput({ phases: phases() });
    expect(tracker.completionReminder(input, "Done for now.")).toContain(
      "2 incomplete todo item(s)",
    );
    // Paused: the model has not produced progress since the reminder.
    expect(tracker.completionReminder(input, "Done for now.")).toBeUndefined();
    tracker.onToolResult("shell", false);
    expect(tracker.completionReminder(input, "Done for now.")).toContain("Reminder 2/3");
    tracker.onToolResult("shell", false);
    expect(tracker.completionReminder(input, "Done for now.")).toContain("Reminder 3/3");
    tracker.onToolResult("shell", false);
    expect(tracker.completionReminder(input, "Done for now.")).toBeUndefined();
  });

  it("never fires while the model awaits an answer", () => {
    const tracker = new TodoTracker();
    expect(
      tracker.completionReminder(
        trackerInput({ phases: phases() }),
        "Which approach should I take?",
      ),
    ).toBeUndefined();
  });

  it("never fires while a user prompt is pending", () => {
    const tracker = new TodoTracker();
    const input = trackerInput({ phases: phases(), hasPendingMessages: true });
    expect(tracker.completionReminder(input, "Done.")).toBeUndefined();
  });

  it("stays silent when everything is closed", () => {
    const tracker = new TodoTracker();
    const allDone = [
      {
        name: "A",
        tasks: [{ content: "x", status: "completed" as const }],
      },
    ];
    expect(tracker.completionReminder(trackerInput({ phases: allDone }), "Done.")).toBeUndefined();
  });

  it("lists blocked tasks separately without counting them as open", () => {
    const tracker = new TodoTracker();
    const mixed = [
      {
        name: "A",
        tasks: [
          { content: "open", status: "pending" as const },
          { content: "waiting", status: "blocked" as const, blocker: "review" },
        ],
      },
    ];
    const reminder = tracker.completionReminder(trackerInput({ phases: mixed }), "Done.");
    expect(reminder).toContain("1 incomplete todo item(s)");
    expect(reminder).toContain("Blocked, still waiting");
    expect(reminder).toContain("waiting");
  });

  it("resets its budget on a clean stop", () => {
    const tracker = new TodoTracker();
    const input = trackerInput({ phases: phases() });
    expect(tracker.completionReminder(input, "Done.")).toContain("Reminder 1/3");
    // Progress clears the awaiting-progress guard.
    tracker.onToolResult("shell", false);
    // A stop with nothing open resets the cycle budget.
    expect(tracker.completionReminder(trackerInput({ phases: [] }), "Done.")).toBeUndefined();
    expect(tracker.completionReminder(input, "Done.")).toContain("Reminder 1/3");
  });

  it("a reminder stays paused until the model makes progress", () => {
    const tracker = new TodoTracker();
    const input = trackerInput({ phases: phases() });
    expect(tracker.completionReminder(input, "Done.")).toContain("Reminder 1/3");
    // No tool result yet, so a second stop must not nag again.
    expect(tracker.completionReminder(input, "Done.")).toBeUndefined();
    expect(tracker.completionReminder(input, "Done.")).toBeUndefined();
  });
});

describe("command: tokenizer and fuzzy matching", () => {
  it("keeps a double-quoted phrase as one token", () => {
    expect(tokenize('Alpha "wire the store"')).toEqual(["Alpha", "wire the store"]);
  });

  it("matches a phase by exact, then prefix, then substring", () => {
    const list: TodoPhase[] = [
      { name: "Foundation", tasks: [] },
      { name: "Auth", tasks: [] },
    ];
    expect(findPhaseFuzzy(list, "auth")?.name).toBe("Auth");
    expect(findPhaseFuzzy(list, "foun")?.name).toBe("Foundation");
    expect(findPhaseFuzzy(list, "tion")?.name).toBe("Foundation");
    expect(findPhaseFuzzy(list, "zzz")).toBeUndefined();
  });

  it("prefers a single open task when several contain the query", () => {
    const list: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "wire store", status: "completed" },
          { content: "wire auth", status: "pending" },
        ],
      },
    ];
    expect(findTaskFuzzy(list, "wire")?.task.content).toBe("wire auth");
  });

  it("returns undefined when several open tasks match", () => {
    const list: TodoPhase[] = [
      {
        name: "A",
        tasks: [
          { content: "wire store", status: "pending" },
          { content: "wire auth", status: "pending" },
        ],
      },
    ];
    expect(findTaskFuzzy(list, "wire")).toBeUndefined();
  });
});

describe("command: manual-edit reminder", () => {
  it("renders the list", () => {
    expect(buildSystemReminder("/todo append", phases())).toContain("- [/] first");
  });

  it("tells the model not to recreate an intentionally cleared list", () => {
    const reminder = buildSystemReminder("/todo rm (all)", [], true);
    expect(reminder).toContain("Do NOT recreate");
  });

  it("tells the model not to re-add removed entries", () => {
    const reminder = buildSystemReminder("/todo rm first", phases(), true);
    expect(reminder).toContain("Do NOT re-add");
  });
});

describe("command: verbs against a fake host", () => {
  function host(initial: TodoPhase[] = []) {
    let phases = initial;
    const notes: string[] = [];
    const reminders: string[] = [];
    return {
      notes,
      reminders,
      get phases() {
        return phases;
      },
      deps: {
        async phasesFor() {
          return phases;
        },
        async setPhases(_sessionID: string, next: TodoPhase[]) {
          phases = next;
        },
        cwd: () => "/tmp",
        notify: (message: string) => notes.push(message),
        sendReminder: async (_sessionID: string, text: string) => {
          reminders.push(text);
        },
      },
    };
  }

  it("append auto-creates a phase and commits with a reminder", async () => {
    const h = host();
    await runTodoCommand(h.deps, "ses_a", "append Foundation scaffold the crate");
    expect(h.phases).toEqual([
      {
        name: "Foundation",
        // Manual appends land pending; only the tool's own normalization
        // auto-promotes, so `/todo` never starts work on the user's behalf.
        tasks: [{ content: "Scaffold the crate", status: "pending" }],
      },
    ]);
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]).toContain("manually modified");
  });

  it("append rejects a duplicate identity", async () => {
    const h = host([{ name: "Work", tasks: [{ content: "Ship it", status: "pending" }] }]);
    await runTodoCommand(h.deps, "ses_a", 'append "Ship it"');
    expect(h.notes.join("\n")).toContain("already exists");
    expect(h.phases).toEqual([
      { name: "Work", tasks: [{ content: "Ship it", status: "pending" }] },
    ]);
  });

  it("done marks a fuzzy-matched task", async () => {
    const h = host(phases());
    await runTodoCommand(h.deps, "ses_a", "done first");
    expect(h.phases[0]?.tasks[0]?.status).toBe("completed");
  });

  it("done with no argument closes everything", async () => {
    const h = host(phases());
    await runTodoCommand(h.deps, "ses_a", "done");
    expect(h.phases[0]?.tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
  });

  it("rm with no argument clears the list and says not to recreate it", async () => {
    const h = host(phases());
    await runTodoCommand(h.deps, "ses_a", "rm");
    expect(h.phases).toEqual([]);
    expect(h.reminders[0]).toContain("Do NOT recreate");
  });

  it("reports an unknown verb with the usage text", async () => {
    const h = host(phases());
    await runTodoCommand(h.deps, "ses_a", "frobnicate");
    expect(h.notes.join("\n")).toContain('Unknown /todo verb "frobnicate"');
  });

  it("reports when nothing matches a start query", async () => {
    const h = host(phases());
    await runTodoCommand(h.deps, "ses_a", "start nothing-like-this");
    expect(h.notes.join("\n")).toContain("No task matched");
  });
});

describe("skill loading", () => {
  it("splits frontmatter from the body", () => {
    const { data, body } = splitFrontmatter(
      '---\nname: demo\ndescription: "A demo."\n---\n# Body\n',
    );
    expect(data.name).toBe("demo");
    expect(data.description).toBe("A demo.");
    expect(body.trim()).toBe("# Body");
  });

  it("treats a file without frontmatter as all body", () => {
    const { data, body } = splitFrontmatter("# Just a body\n");
    expect(data).toEqual({});
    expect(body).toBe("# Just a body\n");
  });

  it("loads the bundled todo-discipline skill", () => {
    const skill = loadSkill(new URL("../skills", import.meta.url).pathname, "todo-discipline");
    expect(skill?.name).toBe("todo-discipline");
    expect(skill?.content).toContain("todo");
  });

  it("returns undefined for a missing skill", () => {
    expect(loadSkill("/nonexistent-skills", "todo-discipline")).toBeUndefined();
  });
});

describe("tool and command integration through the pure core", () => {
  it("an init followed by view leaves the list intact", () => {
    const init = executeTodoOp(
      [],
      {
        op: "init",
        list: [{ phase: "A", items: ["one", "two"] }],
      },
      true,
    );
    expect(init.failed).toBe(false);
    const view = executeTodoOp(init.phases, { op: "view" }, true);
    expect(view.readOnly).toBe(true);
    expect(view.phases).toEqual(init.phases);
  });

  it("repairs a missing op from a bare list", () => {
    const outcome = executeTodoOp([], { list: [{ phase: "A", items: ["x"] }] }, true);
    expect(outcome.failed).toBe(false);
    expect(outcome.op).toBe("init");
  });

  it("a failing batch leaves the previous state untouched", () => {
    const init = executeTodoOp(
      [],
      {
        op: "init",
        list: [{ phase: "A", items: ["one"] }],
      },
      true,
    );
    const failed = executeTodoOp(init.phases, { op: "done", task: "missing" }, true);
    expect(failed.failed).toBe(true);
    expect(failed.phases).toEqual(init.phases);
  });
});
