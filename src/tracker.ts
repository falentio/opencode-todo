/**
 * TodoTracker — eager first-turn prelude, mid-run nudges, and stop-time
 * completion reminders.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/session/todo-tracker.ts`
 * via the pi extension. Host-facing differences:
 *
 * - omp's `scheduleAgentContinue` and pi's `sendMessage(triggerTurn)` both
 *   become `session.synthetic(..., resume: true)`, the v2 way to add a hidden
 *   message and re-enter the loop.
 * - The pre-prompt maintenance thunk becomes the `session.hook("context")`
 *   hook, which can append to `event.system`.
 * - Plan mode, async wake, subagents, and tool-choice forcing have no v2
 *   equivalent and stay out of scope, as they were for pi.
 *
 * The tracker owns only the per-session *budgets* (reminder count, mutations
 * since the last todo touch). Todo state is passed in on every call, so there
 * is exactly one canonical copy and no way for the tracker to hold a stale
 * one — the bug the pi port hit.
 */

import type { TodoConfig } from "./config.ts";
import { renderEagerTodoPrompt, renderMidRunNudgePrompt } from "./prompts.ts";
import type { TodoPhase } from "./types.ts";

const MID_RUN_NUDGE_MUTATION_THRESHOLD = 12;
const MID_RUN_NUDGE_MAX_PER_CYCLE = 2;

/**
 * Tool names that count as real progress for the mid-run nudge. v2 exposes
 * `shell` where pi had `bash`, and its patch tool is `patch` where pi had
 * `edit`; both spellings are kept so a rename does not silently disable the
 * nudge.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["shell", "bash", "patch", "edit", "write"]);

export const TODO_TOOL_NAME = "todo";

/** Whether a line reads as a question or a response cue the user must answer. */
export function isAwaitingUserAnswerText(text: string | undefined): boolean {
  if (!text) return false;
  // Model output commonly wraps the closing question in markdown emphasis
  // (bold/italic/backticks); strip decoration before the line heuristics
  // or "**Should I continue?**" fails to count as awaiting an answer.
  const lastLine = text
    .split(/\r?\n/)
    .at(-1)
    ?.replace(/[`*_~]+/g, "")
    .trim();
  return lastLine !== undefined && (isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine));
}

// ---------------------------------------------------------------------------
// Prompt-line heuristics (ported from omp todo-tracker.ts)
// ---------------------------------------------------------------------------

const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const QUESTION_PROMPT_RE =
  /^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const USER_RESPONSE_CUE_RE =
  /^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;
// A closing question in a non-Latin script still counts as awaiting an answer.
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;

interface PromptLine {
  text: string;
  hadPromptLabel: boolean;
}

function promptLine(line: string): PromptLine {
  const withoutMarkdownPrefix = line.trim().replace(MARKDOWN_PROMPT_PREFIX_RE, "").trim();
  const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
  return {
    text: withoutPromptLabel,
    hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
  };
}

function isQuestionPromptLine(line: string): boolean {
  const candidate = promptLine(line);
  if (!/[?？]\s*$/.test(candidate.text)) return false;
  return (
    candidate.hadPromptLabel ||
    QUESTION_PROMPT_RE.test(candidate.text) ||
    USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
    NON_ASCII_TEXT_RE.test(candidate.text)
  );
}

function isResponseCueLine(line: string): boolean {
  const candidate = promptLine(line)
    .text.replace(/[.!?。！？]+$/, "")
    .trim();
  return USER_RESPONSE_CUE_RE.test(candidate);
}

export interface OpenTask {
  phase: string;
  content: string;
  status: "pending" | "in_progress";
}

/** Open tasks in phase order, with their phase name. */
export function openTasks(phases: readonly TodoPhase[]): OpenTask[] {
  const out: OpenTask[] = [];
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status === "pending" || task.status === "in_progress") {
        out.push({
          phase: phase.name,
          content: task.content,
          status: task.status,
        });
      }
    }
  }
  return out;
}

export interface BlockedTask {
  phase: string;
  content: string;
  blocker?: string;
}

/** Blocked tasks, which the stop-time reminder reports separately. */
export function blockedTasks(phases: readonly TodoPhase[]): BlockedTask[] {
  const out: BlockedTask[] = [];
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status !== "blocked") continue;
      out.push({
        phase: phase.name,
        content: task.content,
        ...(task.blocker === undefined ? {} : { blocker: task.blocker }),
      });
    }
  }
  return out;
}

export interface TrackerInput {
  config: TodoConfig;
  phases: readonly TodoPhase[];
  /** The `todo` tool is registered and active in this session. */
  todoToolActive: boolean;
  /** A user message already exists in this session. */
  hasUserMessage: boolean;
  /** A user prompt is waiting to be delivered. */
  hasPendingMessages: boolean;
}

/**
 * Per-session nudge and reminder budgets.
 *
 * One instance per session. Every method takes the current phases, so the
 * tracker never caches state.
 */
export class TodoTracker {
  #reminderCount = 0;
  #reminderAwaitingProgress = false;
  #mutationsSinceLastTouch = 0;
  #midRunNudgeCount = 0;
  #eagerPreludeServed = false;

  /** Resets the per-prompt reminder and mutation budgets. */
  resetCycle(): void {
    this.#reminderCount = 0;
    this.#reminderAwaitingProgress = false;
    this.#mutationsSinceLastTouch = 0;
    this.#midRunNudgeCount = 0;
  }

  /** Records a completed tool result. */
  onToolResult(toolName: string, isError: boolean): void {
    if (toolName === TODO_TOOL_NAME) {
      this.#mutationsSinceLastTouch = 0;
    } else if (!isError && MUTATING_TOOLS.has(toolName)) {
      this.#mutationsSinceLastTouch++;
    }
    this.#reminderAwaitingProgress = false;
  }

  /**
   * Text for the first-turn eager todo prelude, or undefined.
   *
   * A resumed session never injects it, and neither does a prompt that is
   * plainly a question ("…?") or an exclamation — those read as a request
   * for an answer, not for a plan.
   */
  createEagerTodoPrelude(input: TrackerInput, promptText: string | undefined): string | undefined {
    const mode = input.config.eager;
    if (mode === "default" || !input.config.enabled) return undefined;
    if (this.#eagerPreludeServed) return undefined;
    if (input.phases.length > 0) return undefined;
    if (input.hasUserMessage) return undefined;
    if (!input.todoToolActive) return undefined;
    if (promptText !== undefined) {
      const trimmed = promptText.trimEnd();
      if (trimmed.endsWith("?") || trimmed.endsWith("!")) return undefined;
    }
    this.#eagerPreludeServed = true;
    return renderEagerTodoPrompt({
      toolRef: TODO_TOOL_NAME,
      forced: mode === "always",
    });
  }

  /** The next hidden mid-run reconciliation nudge, if its budget and guards allow. */
  takeMidRunNudge(input: TrackerInput): string | null {
    if (this.#mutationsSinceLastTouch < MID_RUN_NUDGE_MUTATION_THRESHOLD) {
      return null;
    }
    if (this.#midRunNudgeCount >= MID_RUN_NUDGE_MAX_PER_CYCLE) return null;
    if (!input.config.enabled || !input.config.reminders) return null;
    if (!input.todoToolActive) return null;
    const incomplete = openTasks(input.phases);
    if (incomplete.length === 0) return null;
    this.#mutationsSinceLastTouch = 0;
    this.#midRunNudgeCount++;
    return renderMidRunNudgePrompt({
      toolRef: TODO_TOOL_NAME,
      incompleteCount: incomplete.length,
    });
  }

  /**
   * The stop-time reminder text when a terminal turn left todos open, or
   * undefined when no reminder is due.
   */
  completionReminder(
    input: TrackerInput,
    lastAssistantText: string | undefined,
  ): string | undefined {
    if (!input.config.reminders || !input.config.enabled) {
      this.#reminderCount = 0;
      this.#reminderAwaitingProgress = false;
      return undefined;
    }
    if (this.#reminderAwaitingProgress) return undefined;
    if (this.#reminderCount >= input.config.remindersMax) return undefined;
    // Without the todo tool an incomplete list is deliberate (a tools
    // subset) — reminding the model to edit state it cannot touch is pure
    // noise. Mirrors the guards on the eager prelude and mid-run nudge.
    if (!input.todoToolActive) return undefined;
    if (input.phases.length === 0) {
      this.#reminderCount = 0;
      this.#reminderAwaitingProgress = false;
      return undefined;
    }
    const incomplete = openTasks(input.phases);
    if (incomplete.length === 0) {
      this.#reminderCount = 0;
      this.#reminderAwaitingProgress = false;
      return undefined;
    }
    // Never nag after the model asked something: the user owes an answer,
    // not more work.
    if (isAwaitingUserAnswerText(lastAssistantText)) return undefined;
    if (input.hasPendingMessages) return undefined;

    this.#reminderCount++;
    const todoList = incomplete.map((task) => `  - ${task.content} (${task.phase})`).join("\n");
    const blocked = blockedTasks(input.phases);
    const blockedNote =
      blocked.length > 0
        ? `\nBlocked, still waiting (not counted above): ${blocked
            .map((task) => task.content)
            .join(", ")}.`
        : "";
    this.#mutationsSinceLastTouch = 0;
    this.#reminderAwaitingProgress = true;
    return (
      `You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}${blockedNote}\n\n` +
      `Please continue working on these tasks or mark them complete if finished.\n` +
      `(Reminder ${this.#reminderCount}/${input.config.remindersMax})`
    );
  }
}
