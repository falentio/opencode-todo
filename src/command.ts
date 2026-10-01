/**
 * `/todo` slash command.
 *
 * Ported from Oh My Pi's
 * `packages/controllers/todo-command-controller.ts` via the pi extension.
 *
 * v2 differences:
 * - `openEditor` (the pi TUI editor dialog) has no v2 equivalent, so `edit`
 *   goes straight to `$EDITOR`/`$VISUAL` on a private temp file.
 * - `copyToClipboard` (OSC 52) has no v2 equivalent; `copy` prints the
 *   Markdown and says so.
 * - Notifications are `console.error` lines in the server log; v2 exposes no
 *   plugin-facing toast on the server side.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyOpsToPhases, validateTodoIdentities } from "./state.ts";
import { markdownToPhases, phasesToMarkdown, resolveTodoMarkdownPath } from "./markdown.ts";
import type { TodoItem, TodoOperation, TodoParams, TodoPhase } from "./types.ts";

export const TODO_USAGE = [
  "Usage: /todo <verb> [args]",
  "  /todo                              Show current todos",
  "  /todo edit                         Open todos in $EDITOR",
  "  /todo copy                         Print todos as Markdown",
  "  /todo export [<path>]              Write todos to file (default: TODO.md)",
  "  /todo import [<path>]              Replace todos from file (default: TODO.md)",
  "  /todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
  "  /todo start  <task>                Mark task in_progress (fuzzy content match)",
  "  /todo done   [<task|phase>]        Mark task/phase/all completed",
  "  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
  "  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

export interface TodoCommandHost {
  phasesFor(sessionID: string): Promise<TodoPhase[]>;
  setPhases(sessionID: string, phases: TodoPhase[]): Promise<void>;
  cwd(): string;
  notify(message: string): void;
  /** Inject a hidden reminder telling the model the user edited the list. */
  sendReminder(sessionID: string, text: string): Promise<void>;
  /** Ask before overwriting an existing export target; default: refuse. */
  confirmOverwrite?(filePath: string): Promise<boolean>;
}

/** Tokenize on whitespace, keeping a double-quoted run as one token. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of input) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word[0]?.toUpperCase() ?? "") + word.slice(1))
    .join(" ");
}

/** Capitalize the first letter only — keeps acronyms and casing intact. */
function titleCaseSentence(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return trimmed;
  return (trimmed[0]?.toUpperCase() ?? "") + trimmed.slice(1);
}

export function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const byName = phases.find((phase) => phase.name.toLowerCase() === q);
  if (byName) return byName;
  // Substring, preferring an unambiguous prefix match.
  const prefixMatches = phases.filter((phase) => phase.name.toLowerCase().startsWith(q));
  if (prefixMatches.length === 1) return prefixMatches[0];
  const subMatches = phases.filter((phase) => phase.name.toLowerCase().includes(q));
  if (subMatches.length === 1) return subMatches[0];
  return undefined;
}

export function findTaskFuzzy(
  phases: TodoPhase[],
  query: string,
): { task: TodoItem; phase: TodoPhase } | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.content.toLowerCase() === q) return { task, phase };
    }
  }
  const matches: Array<{ task: TodoItem; phase: TodoPhase }> = [];
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.content.toLowerCase().includes(q)) {
        matches.push({ task, phase });
      }
    }
  }
  if (matches.length === 1) return matches[0];
  // Prefer a single open hit when several tasks contain the query.
  const active = matches.filter(
    (match) => match.task.status === "in_progress" || match.task.status === "pending",
  );
  if (active.length === 1) return active[0];
  return undefined;
}

export function buildSystemReminder(action: string, phases: TodoPhase[], removed = false): string {
  const md = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
  const lines = [`The user manually modified the todo list (${action}).`];
  if (removed) {
    lines.push(
      phases.length === 0
        ? "The user intentionally cleared the todo list. Do NOT recreate or re-populate it unless the user explicitly asks; continue the current request without a todo list."
        : "The user intentionally removed the entries no longer shown below. Do NOT re-add them unless the user explicitly asks.",
    );
  }
  lines.push("Current todo list:", "", md);
  return lines.join("\n");
}

export function getEditorCommand(): string | undefined {
  const configured = (process.env.VISUAL ?? process.env.EDITOR ?? "").trim();
  return configured === "" ? undefined : configured;
}

/**
 * Open `content` in the user's editor and return the edited text, or null
 * when the editor exits non-zero. The temp file is always cleaned up.
 *
 * `mkdtemp` (0700) plus a 0600 file instead of a predictable pid/timestamp
 * name: on a multi-user machine a guessed tmp name can be pre-created as a
 * symlink and the write would follow it. The prefill can hold session data.
 */
export async function openInExternalEditor(
  editorCmd: string,
  content: string,
): Promise<string | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "todos-edit-"));
  const tmpFile = path.join(tmpDir, "todos.md");
  try {
    await fs.writeFile(tmpFile, content, { encoding: "utf8", mode: 0o600 });
    const exitCode = await runEditorProcess(editorCmd, tmpFile);
    if (exitCode !== 0) return null;
    return await fs.readFile(tmpFile, "utf8");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runEditorProcess(editorCmd: string, filePath: string): Promise<number> {
  // Split the configured editor into [command, ...args] (e.g. "code --wait")
  // and spawn directly, with no shell indirection.
  const [editor, ...editorArgs] = editorCmd.split(/\s+/).filter(Boolean);
  if (!editor) return Promise.resolve(1);
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [...editorArgs, filePath], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
  });
}

/** How `/todo` resolves the phase list it edits. */
export interface TodoCommandDeps {
  phasesFor(sessionID: string): Promise<TodoPhase[]>;
  setPhases(sessionID: string, phases: TodoPhase[]): Promise<void>;
  cwd(): string;
  notify(message: string): void;
  sendReminder(sessionID: string, text: string): Promise<void>;
  confirmOverwrite?(filePath: string): Promise<boolean>;
}

/**
 * Run one `/todo` invocation.
 *
 * Every mutating verb commits through {@link commit}, which writes the phases
 * and injects the hidden manual-edit reminder. Removals set `removed: true`
 * so the model is told not to recreate what the user deleted.
 */
export async function runTodoCommand(
  deps: TodoCommandDeps,
  sessionID: string,
  args: string,
): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    await showCurrent(deps, sessionID);
    return;
  }

  const spaceIdx = trimmed.search(/\s/);
  const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (verb) {
    case "edit":
      await editInEditor(deps, sessionID);
      return;
    case "copy":
      await copyMarkdown(deps, sessionID);
      return;
    case "export":
      await exportToFile(deps, sessionID, rest);
      return;
    case "import":
      await importFromFile(deps, sessionID, rest);
      return;
    case "help":
    case "?":
      deps.notify(TODO_USAGE);
      return;
    case "append":
      await append(deps, sessionID, rest);
      return;
    case "start":
      await start(deps, sessionID, rest);
      return;
    case "done":
      await mutateStatus(deps, sessionID, rest, "completed");
      return;
    case "drop":
      await mutateStatus(deps, sessionID, rest, "abandoned");
      return;
    case "rm":
      await remove(deps, sessionID, rest);
      return;
    default:
      deps.notify(`Unknown /todo verb "${verb}".\n${TODO_USAGE}`);
  }
}

async function commit(
  deps: TodoCommandDeps,
  sessionID: string,
  phases: TodoPhase[],
  action: string,
  opts?: { removed?: boolean },
): Promise<void> {
  await deps.setPhases(sessionID, phases);
  await deps.sendReminder(sessionID, buildSystemReminder(action, phases, opts?.removed ?? false));
}

async function showCurrent(deps: TodoCommandDeps, sessionID: string): Promise<void> {
  const phases = await deps.phasesFor(sessionID);
  if (phases.length === 0) {
    deps.notify("No todos. Use /todo append <task> to start one.");
    return;
  }
  deps.notify(phasesToMarkdown(phases).trimEnd());
}

async function copyMarkdown(deps: TodoCommandDeps, sessionID: string): Promise<void> {
  const phases = await deps.phasesFor(sessionID);
  if (phases.length === 0) {
    deps.notify("No todos to copy.");
    return;
  }
  deps.notify(
    `Todos as Markdown (OpenCode v2 exposes no plugin clipboard; copy from here):\n${phasesToMarkdown(phases).trimEnd()}`,
  );
}

function resolveTodoPath(deps: TodoCommandDeps, rest: string): string {
  return resolveTodoMarkdownPath(rest, deps.cwd());
}

async function exportToFile(deps: TodoCommandDeps, sessionID: string, rest: string): Promise<void> {
  const phases = await deps.phasesFor(sessionID);
  if (phases.length === 0) {
    deps.notify("No todos to export.");
    return;
  }
  try {
    const target = resolveTodoPath(deps, rest);
    // Fail closed on a pre-existing target: a symlink would silently
    // redirect the write, and TODO.md may hold unrelated content — never
    // clobber without an explicit confirmation.
    const existing = await fs.lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) {
      deps.notify(`Refusing to write through symlink ${target}.`);
      return;
    }
    if (existing !== undefined) {
      const proceed = await (deps.confirmOverwrite?.(target) ?? Promise.resolve(false));
      if (!proceed) {
        deps.notify(
          `Export cancelled: ${target} already exists (pass a different path to keep it).`,
        );
        return;
      }
    }
    await fs.writeFile(target, phasesToMarkdown(phases), "utf8");
    deps.notify(`Wrote todos to ${target}`);
  } catch (error) {
    deps.notify(`Failed to write todos: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function importFromFile(
  deps: TodoCommandDeps,
  sessionID: string,
  rest: string,
): Promise<void> {
  let source = "";
  let content: string;
  try {
    source = resolveTodoPath(deps, rest);
    content = await fs.readFile(source, "utf8");
  } catch (error) {
    deps.notify(`Failed to read todos: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const { phases, errors } = markdownToPhases(content);
  if (errors.length > 0) {
    deps.notify(`Could not parse ${source}:\n  ${errors.join("\n  ")}`);
    return;
  }
  const issues = validateTodoIdentities(phases);
  if (issues.length > 0) {
    deps.notify(`Could not import ${source}:\n  ${issues.join("\n  ")}`);
    return;
  }
  await commit(deps, sessionID, phases, `/todo import ${source}`);
  const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  deps.notify(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${source}.`);
}

async function append(deps: TodoCommandDeps, sessionID: string, rest: string): Promise<void> {
  const tokens = tokenize(rest);
  if (tokens.length === 0) {
    deps.notify("Usage: /todo append [<phase>] <task...>");
    return;
  }

  const current = await deps.phasesFor(sessionID);
  let phaseName: string | undefined;
  let content: string;
  if (tokens.length === 1) {
    content = tokens[0] ?? "";
  } else {
    phaseName = tokens[0];
    content = tokens.slice(1).join(" ");
  }

  const next = current.map((phase) => ({
    ...phase,
    tasks: phase.tasks.slice(),
  }));
  let targetPhase: TodoPhase | undefined;
  if (phaseName) {
    targetPhase = findPhaseFuzzy(next, phaseName);
    if (!targetPhase) {
      targetPhase = { name: titleCase(phaseName), tasks: [] };
      next.push(targetPhase);
    }
  } else if (next.length > 0) {
    targetPhase = next[next.length - 1];
  } else {
    targetPhase = { name: "Todos", tasks: [] };
    next.push(targetPhase);
  }
  if (!targetPhase) return;

  const finalContent = titleCaseSentence(content);
  targetPhase.tasks.push({ content: finalContent, status: "pending" });

  const issues = validateTodoIdentities(next);
  if (issues.length > 0) {
    deps.notify(issues.join("; "));
    return;
  }
  await commit(deps, sessionID, next, `/todo append → ${targetPhase.name}`);
  deps.notify(`Appended to ${targetPhase.name}: ${finalContent}`);
}

async function start(deps: TodoCommandDeps, sessionID: string, rest: string): Promise<void> {
  if (!rest) {
    deps.notify("Usage: /todo start <task>");
    return;
  }
  const current = await deps.phasesFor(sessionID);
  const hit = findTaskFuzzy(current, rest);
  if (!hit) {
    deps.notify(`No task matched "${rest}". Use /todo to list current tasks.`);
    return;
  }
  const { phases, errors } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
  if (errors.length > 0) {
    deps.notify(errors.join("; "));
    return;
  }
  await commit(deps, sessionID, phases, `/todo start ${hit.task.content}`);
  deps.notify(`Started: ${hit.task.content}`);
}

async function mutateStatus(
  deps: TodoCommandDeps,
  sessionID: string,
  rest: string,
  target: "completed" | "abandoned",
): Promise<void> {
  const op: TodoOperation = target === "completed" ? "done" : "drop";
  const current = await deps.phasesFor(sessionID);
  const trimmed = rest.trim();

  if (!trimmed) {
    const { phases, errors } = applyOpsToPhases(current, [{ op } as TodoParams]);
    if (errors.length > 0) {
      deps.notify(errors.join("; "));
      return;
    }
    await commit(deps, sessionID, phases, `/todo ${op} (all)`);
    deps.notify(`Marked all tasks ${target}.`);
    return;
  }

  const taskHit = findTaskFuzzy(current, trimmed);
  if (taskHit) {
    const { phases, errors } = applyOpsToPhases(current, [{ op, task: taskHit.task.content }]);
    if (errors.length > 0) {
      deps.notify(errors.join("; "));
      return;
    }
    await commit(deps, sessionID, phases, `/todo ${op} ${taskHit.task.content}`);
    deps.notify(`Marked ${target}: ${taskHit.task.content}`);
    return;
  }

  const phaseHit = findPhaseFuzzy(current, trimmed);
  if (phaseHit) {
    const { phases, errors } = applyOpsToPhases(current, [{ op, phase: phaseHit.name }]);
    if (errors.length > 0) {
      deps.notify(errors.join("; "));
      return;
    }
    await commit(deps, sessionID, phases, `/todo ${op} ${phaseHit.name}`);
    deps.notify(`Marked phase ${phaseHit.name} ${target}.`);
    return;
  }

  deps.notify(`No task or phase matched "${trimmed}".`);
}

async function remove(deps: TodoCommandDeps, sessionID: string, rest: string): Promise<void> {
  const current = await deps.phasesFor(sessionID);
  const trimmed = rest.trim();
  if (!trimmed) {
    await commit(deps, sessionID, [], "/todo rm (all)", { removed: true });
    deps.notify("Cleared all todos.");
    return;
  }
  const taskHit = findTaskFuzzy(current, trimmed);
  if (taskHit) {
    const { phases, errors } = applyOpsToPhases(current, [
      { op: "rm", task: taskHit.task.content },
    ]);
    if (errors.length > 0) {
      deps.notify(errors.join("; "));
      return;
    }
    await commit(deps, sessionID, phases, `/todo rm ${taskHit.task.content}`, {
      removed: true,
    });
    deps.notify(`Removed: ${taskHit.task.content}`);
    return;
  }
  const phaseHit = findPhaseFuzzy(current, trimmed);
  if (phaseHit) {
    const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", phase: phaseHit.name }]);
    if (errors.length > 0) {
      deps.notify(errors.join("; "));
      return;
    }
    await commit(deps, sessionID, phases, `/todo rm ${phaseHit.name}`, {
      removed: true,
    });
    deps.notify(`Removed phase: ${phaseHit.name}`);
    return;
  }
  deps.notify(`No task or phase matched "${trimmed}".`);
}

async function editInEditor(deps: TodoCommandDeps, sessionID: string): Promise<void> {
  const editorCmd = getEditorCommand();
  if (!editorCmd) {
    deps.notify("No $EDITOR or $VISUAL set. Set one, or use /todo export to edit a file.");
    return;
  }
  const prefill = await deps.phasesFor(sessionID);
  const initialMarkdown =
    prefill.length > 0
      ? phasesToMarkdown(prefill)
      : "# Todos\n- [ ] (replace this with your tasks)\n";

  const edited = await openInExternalEditor(editorCmd, initialMarkdown);
  if (edited === null) {
    deps.notify("Editor exited without saving; todos unchanged.");
    return;
  }
  if (edited === initialMarkdown) {
    deps.notify("No changes; todos unchanged.");
    return;
  }
  // The prefill snapshot is only valid if nothing else touched the list
  // while the editor was open. Committing it otherwise silently reverts
  // whatever the todo tool or another /todo did in between.
  const latest = await deps.phasesFor(sessionID);
  if (JSON.stringify(latest) !== JSON.stringify(prefill)) {
    deps.notify(
      "Todos changed while the editor was open; aborting to avoid overwriting the newer state. Re-run /todo edit.",
    );
    return;
  }
  const { phases: parsed, errors } = markdownToPhases(edited);
  if (errors.length > 0) {
    deps.notify(`Could not parse Markdown:\n  ${errors.join("\n  ")}`);
    return;
  }
  const issues = validateTodoIdentities(parsed);
  if (issues.length > 0) {
    deps.notify(`Todos not saved:\n  ${issues.join("\n  ")}`);
    return;
  }
  await commit(deps, sessionID, parsed, "/todo edit");
  const taskCount = parsed.reduce((sum, phase) => sum + phase.tasks.length, 0);
  deps.notify(`Todos updated from editor: ${parsed.length} phase(s), ${taskCount} task(s).`);
}
