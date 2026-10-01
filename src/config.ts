/**
 * Todo plugin configuration.
 *
 * A plugin cannot extend OpenCode's config schema, so settings come from
 * three places, later wins:
 *
 * 1. built-in defaults;
 * 2. a JSON file, global (`<config dir>/todo.json`) then project
 *    (`<cwd>/.opencode/todo.json`);
 * 3. environment variables, then the plugin entry's `options` in
 *    `opencode.json`.
 *
 * ```json
 * { "enabled": true, "reminders": true, "remindersMax": 3, "eager": "default" }
 * ```
 *
 * All keys optional; invalid values warn and fall back to the previous value.
 * A global `enabled: false` is a floor: nothing can re-enable the tool.
 */

import * as fs from "node:fs";
import { dirname, join } from "node:path";

export type TodoEagerMode = "default" | "preferred" | "always";

export interface TodoConfig {
  /** Gates the todo tool's availability and every tracker behavior. */
  enabled: boolean;
  /** Stop-time incomplete-todo reminders. */
  reminders: boolean;
  /** Max reminder attempts per prompt cycle. */
  remindersMax: number;
  /** First-turn eager prelude mode. */
  eager: TodoEagerMode;
}

export const TODO_CONFIG_DEFAULTS: TodoConfig = {
  enabled: true,
  reminders: true,
  remindersMax: 3,
  eager: "default",
};

export const TODO_CONFIG_FILE_NAME = "todo.json";

export const TODO_ENV = {
  enabled: "OPENCODE_TODO_ENABLED",
  reminders: "OPENCODE_TODO_REMINDERS",
  remindersMax: "OPENCODE_TODO_REMINDERS_MAX",
  eager: "OPENCODE_TODO_EAGER",
} as const;

export interface TodoConfigSources {
  /** Global config directory, normally `~/.config/opencode`. */
  configDir: string;
  /** Project directory the session runs in. */
  cwd: string;
  /** The plugin entry's `options` from `opencode.json`. */
  options?: Readonly<Record<string, unknown>>;
  env?: Readonly<Record<string, string | undefined>>;
  warn?: (message: string) => void;
}

const KNOWN_KEYS = new Set(["enabled", "reminders", "remindersMax", "eager"]);

function parseConfigFile(filePath: string, warn: (message: string) => void): Partial<TodoConfig> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warn(
      `todos: invalid JSON in ${filePath}; using defaults (${error instanceof Error ? error.message : String(error)})`,
    );
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(`todos: config ${filePath} is not an object; using defaults`);
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const out: Partial<TodoConfig> = {};
  if (record.enabled !== undefined) {
    if (typeof record.enabled === "boolean") out.enabled = record.enabled;
    else warn(`todos: invalid enabled in ${filePath}; ignoring`);
  }
  if (record.reminders !== undefined) {
    if (typeof record.reminders === "boolean") out.reminders = record.reminders;
    else warn(`todos: invalid reminders in ${filePath}; ignoring`);
  }
  if (record.remindersMax !== undefined) {
    if (
      typeof record.remindersMax === "number" &&
      Number.isInteger(record.remindersMax) &&
      record.remindersMax >= 0
    ) {
      out.remindersMax = record.remindersMax;
    } else warn(`todos: invalid remindersMax in ${filePath}; ignoring`);
  }
  if (record.eager !== undefined) {
    if (isEagerMode(record.eager)) out.eager = record.eager;
    else warn(`todos: invalid eager in ${filePath}; ignoring`);
  }
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      warn(`todos: unknown config key "${key}" in ${filePath} ignored`);
    }
  }
  return out;
}

function isEagerMode(value: unknown): value is TodoEagerMode {
  return value === "default" || value === "preferred" || value === "always";
}

function parseBooleanOverride(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "off" || normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}

function parseRemindersMaxOverride(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Apply an override only when it parses, warning on a non-empty invalid value. */
function applyOverride<Value>(
  target: Value,
  raw: unknown,
  parse: (value: unknown) => Value | undefined,
  label: string,
  warn: (message: string) => void,
): Value {
  const parsed = parse(raw);
  if (parsed !== undefined) return parsed;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    warn(`todos: ignoring invalid ${label} value "${String(raw)}"`);
  }
  return target;
}

/**
 * Resolve the effective config.
 *
 * Precedence, lowest to highest: defaults, global file, project file,
 * environment, plugin options. A `false` written in the global file stays
 * `false` no matter what an override asks for.
 */
export function resolveTodoConfig(sources: TodoConfigSources): TodoConfig {
  const warn = sources.warn ?? (() => {});
  const env = sources.env ?? process.env;
  const options = sources.options ?? {};

  const globalPartial = parseConfigFile(join(sources.configDir, TODO_CONFIG_FILE_NAME), warn);
  const projectPartial = parseConfigFile(
    join(sources.cwd, ".opencode", TODO_CONFIG_FILE_NAME),
    warn,
  );

  const config: TodoConfig = {
    ...TODO_CONFIG_DEFAULTS,
    ...globalPartial,
    ...projectPartial,
  };
  config.enabled = config.enabled && (projectPartial.enabled ?? true);

  config.reminders = applyOverride(
    config.reminders,
    env[TODO_ENV.reminders],
    parseBooleanOverride,
    TODO_ENV.reminders,
    warn,
  );
  config.remindersMax = applyOverride(
    config.remindersMax,
    env[TODO_ENV.remindersMax],
    parseRemindersMaxOverride,
    TODO_ENV.remindersMax,
    warn,
  );
  config.eager = applyOverride(
    config.eager,
    env[TODO_ENV.eager],
    (value) => (isEagerMode(value) ? value : undefined),
    TODO_ENV.eager,
    warn,
  );

  config.reminders = applyOverride(
    config.reminders,
    options.reminders,
    parseBooleanOverride,
    "plugin option reminders",
    warn,
  );
  config.remindersMax = applyOverride(
    config.remindersMax,
    options.remindersMax,
    parseRemindersMaxOverride,
    "plugin option remindersMax",
    warn,
  );
  config.eager = applyOverride(
    config.eager,
    options.eager,
    (value) => (isEagerMode(value) ? value : undefined),
    "plugin option eager",
    warn,
  );

  const enabledOverride = applyOverride(
    config.enabled,
    options.enabled ?? env[TODO_ENV.enabled],
    parseBooleanOverride,
    TODO_ENV.enabled,
    warn,
  );
  config.enabled = globalPartial.enabled === false ? false : enabledOverride;

  return config;
}

/** Read the global config file alone, for tooling that reports stored settings. */
export function readTodoConfig(configDir: string): Partial<TodoConfig> {
  return parseConfigFile(join(configDir, TODO_CONFIG_FILE_NAME), () => {});
}

/** Persist the global config. Refuses symlinks and writes atomically. */
export function saveTodoConfig(configDir: string, config: TodoConfig): string {
  const path = join(configDir, TODO_CONFIG_FILE_NAME);
  fs.mkdirSync(dirname(path), { recursive: true });
  if (fs.existsSync(path) && fs.lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing to overwrite symlink ${path}`);
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, path);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return path;
}
