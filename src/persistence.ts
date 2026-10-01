/**
 * Session-scoped todo persistence.
 *
 * The pi extension replayed the session branch because pi had no plugin
 * storage. OpenCode v2 ships a KV store (`ctx.storage`), so the snapshot is a
 * single key per session: simpler, and it survives a branch the same way the
 * session does.
 */

import type { TodoPhase } from "./types.ts";
import { isValidTodoPhases } from "./validate.ts";
import { clonePhases } from "./state.ts";

/** Minimal storage surface the repository needs, so it is testable alone. */
export interface TodoStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function todoKey(sessionID: string): string {
  return `todo/session/${sessionID}`;
}

/**
 * Read the stored phases for a session.
 *
 * Returns `undefined` when nothing was ever stored, versus `[]` for an
 * explicitly cleared list. Callers must not conflate the two: an empty list is
 * authoritative and must not be mistaken for "no snapshot, fall back to
 * in-memory state".
 */
export async function loadPhases(
  store: TodoStore,
  sessionID: string,
): Promise<TodoPhase[] | undefined> {
  const raw = await store.get(todoKey(sessionID));
  if (raw === undefined || raw === null) return undefined;
  const phases = (raw as { phases?: unknown } | undefined)?.phases;
  if (!isValidTodoPhases(phases)) return undefined;
  return clonePhases(phases);
}

export async function savePhases(
  store: TodoStore,
  sessionID: string,
  phases: TodoPhase[],
): Promise<void> {
  await store.set(todoKey(sessionID), { phases: clonePhases(phases) });
}

export async function clearPhases(store: TodoStore, sessionID: string): Promise<void> {
  await savePhases(store, sessionID, []);
}
