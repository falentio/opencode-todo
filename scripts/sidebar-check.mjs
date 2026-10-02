#!/usr/bin/env node
/**
 * Sidebar verification: prove the real OpenCode TUI paints the todo list in the
 * session sidebar and updates it on a live write.
 *
 * One `opencode serve` is the single server; the CLI and the TUI both attach to
 * it. Two processes with `--standalone` would each get a private server, and no
 * event could cross between them.
 *
 * The assertion reads the painted terminal log, because the sidebar is drawn by
 * the TUI and never appears in the session transcript.
 *
 * Usage:
 *   node scripts/sidebar-check.mjs          full run (needs a working model)
 *   node scripts/sidebar-check.mjs --boot   boot-only (no model call, CI-safe)
 *
 * Environment:
 *   OPENCODE_TODO_SMOKE_MODEL   provider/model for the drive (default 9router/glm)
 *   OPENCODE_BIN                opencode binary (default `opencode` on PATH)
 *   OPENCODE_TODO_SIDEBAR_KEEP=1  keep the sandbox for inspection
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { screenLines } from "./screen.mjs";
import { buildTodoHud, rowText, SIDEBAR_WIDTH } from "../src/hud.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.OPENCODE_BIN ?? "opencode";
const model = process.env.OPENCODE_TODO_SMOKE_MODEL ?? "9router/glm";
const bootOnly = process.argv.includes("--boot");
const keep = process.env.OPENCODE_TODO_SIDEBAR_KEEP === "1";

const failures = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok && detail) {
    for (const line of String(detail).split("\n").slice(0, 6)) console.log(`         ${line}`);
  }
  if (!ok) failures.push(name);
}

const root = mkdtempSync(join(tmpdir(), "todo-sidebar-"));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key === "OPENCODE" || key.startsWith("OPENCODE_")) delete env[key];
}
env.HOME = join(root, "home");
env.XDG_CONFIG_HOME = join(root, "config");
env.XDG_DATA_HOME = join(root, "data");
env.XDG_CACHE_HOME = join(root, "cache");
env.XDG_STATE_HOME = join(root, "state");
env.TMPDIR = join(root, "tmp");
for (const dir of [
  env.HOME,
  env.XDG_CONFIG_HOME,
  env.XDG_DATA_HOME,
  env.XDG_CACHE_HOME,
  env.XDG_STATE_HOME,
  env.TMPDIR,
]) {
  mkdirSync(dir, { recursive: true });
}
mkdirSync(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
const work = join(root, "work");
mkdirSync(work, { recursive: true });

// The model drive needs the caller's credentials and provider definitions,
// because the sandbox has its own data and config homes.
try {
  mkdirSync(join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
  writeFileSync(
    join(env.XDG_DATA_HOME, "opencode", "auth.json"),
    readFileSync(join(process.env.HOME, ".local", "share", "opencode", "auth.json")),
  );
} catch {
  if (!bootOnly) console.log("sidebar: no auth.json to copy; the model drive may fail");
}
try {
  const providers = JSON.parse(
    readFileSync(join(process.env.HOME, ".config", "opencode", "opencode.json"), "utf8"),
  );
  delete providers.$schema;
  for (const key of ["mcp", "plugin", "plugins", "instructions"]) delete providers[key];
  writeFileSync(
    join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", ...providers }, null, 2)}\n`,
  );
} catch {
  writeFileSync(
    join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`,
  );
}

// The server plugin comes from the project's `.opencode/plugins`; the TUI plugin
// from `cli.json`, which resolves the package's `./tui` export.
mkdirSync(join(work, ".opencode", "plugins"), { recursive: true });
symlinkSync(packageRoot, join(work, ".opencode", "plugins", "opencode-todo"));
writeFileSync(
  join(work, "opencode.json"),
  `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`,
);
writeFileSync(
  join(env.XDG_CONFIG_HOME, "opencode", "cli.json"),
  `${JSON.stringify(
    {
      $schema: "https://opencode.ai/v2/cli.json",
      session: { sidebar: "auto" },
      plugins: [`file:${packageRoot}`],
    },
    null,
    2,
  )}\n`,
);

const runEnv = { ...env, PWD: work };
const port = 49500 + Math.floor(Math.random() * 400);
const url = `http://127.0.0.1:${port}`;
console.log(`sidebar: sandbox ${root}`);
console.log(`sidebar: server  ${url}`);

const server = spawn(
  binary,
  ["serve", "--port", String(port), "--print-logs", "--log-level", "info"],
  {
    cwd: work,
    env: runEnv,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverOut = "";
server.stdout.on("data", (chunk) => (serverOut += chunk));
server.stderr.on("data", (chunk) => (serverOut += chunk));

let password = "";
for (let i = 0; i < 120 && !password; i++) {
  const match = /server password (\S+)/.exec(serverOut);
  if (match) password = match[1];
  else await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!password) {
  check("the server started and printed a password", false, serverOut.slice(0, 800));
  server.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
check("the server started and printed a password", true);

function shutdown() {
  server.kill("SIGTERM");
  setTimeout(() => server.kill("SIGKILL"), 2_000).unref?.();
}

function run(prompt, sessionID) {
  return spawnSync(
    binary,
    ["run", "--server", url, "--session", sessionID, "--model", model, prompt],
    {
      cwd: work,
      env: { ...runEnv, OPENCODE_PASSWORD: password },
      encoding: "utf8",
      timeout: 300_000,
    },
  );
}

const sessionID = `ses_sidebar${Date.now().toString(36)}`;
console.log(`sidebar: session ${sessionID}`);

/**
 * The phases carried by the last completed `todo` tool result, read from the
 * exported session transcript.
 *
 * A model may satisfy "call the todo tool" by CLEARING the list (`rm`) or by
 * refusing outright, so the drive asserts on the transcript rather than on the
 * model's reply. That is the same reason `smoke.mjs` reads the transcript.
 */
function phasesIn(target) {
  const exported = spawnSync(binary, ["session", "export", "--server", url, target], {
    cwd: work,
    env: { ...runEnv, OPENCODE_PASSWORD: password },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (exported.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(exported.stdout);
    let phases;
    for (const message of parsed.messages ?? []) {
      if (message.type !== "assistant") continue;
      for (const part of message.content ?? []) {
        if (part.type !== "tool" || part.name !== "todo") continue;
        if (part.state?.status !== "completed") continue;
        const candidate = part.state?.metadata?.phases;
        if (Array.isArray(candidate)) phases = candidate;
      }
    }
    return phases;
  } catch {
    return undefined;
  }
}

/** Drive a prompt until the transcript shows the expected phases. */
function driveUntil(prompt, predicate, attempts = 3) {
  let phases;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    run(prompt, sessionID);
    phases = phasesIn(sessionID);
    if (phases !== undefined && predicate(phases)) return { ok: true, attempt, phases };
  }
  return { ok: false, phases };
}

if (!bootOnly) {
  const warm = run("Reply with exactly: WARM", sessionID);
  check("the model drive reached the server", warm.status === 0, warm.stderr?.slice(0, 400));

  const init = driveUntil(
    "Call the todo tool exactly once with op=init and list=" +
      "[{phase:'Foundation',items:['scaffold crate','wire workspace']}," +
      "{phase:'Auth',items:['port credential store']}]. Then stop.",
    (phases) =>
      phases.length === 2 &&
      phases.some((phase) => phase.name === "Foundation") &&
      phases.some((phase) => phase.name === "Auth"),
  );
  check(
    "the todo tool persisted a two-phase list",
    init.ok,
    `last seen: ${JSON.stringify(init.phases)?.slice(0, 300)}`,
  );
}

// The TUI needs a controlling terminal, and the sidebar only opens above 120
// columns because `session.sidebar` is "auto".
const logPath = join(root, "tui.log");
const pairs = Object.entries(env)
  .filter(([key]) => key.startsWith("XDG_") || key === "HOME" || key === "TMPDIR")
  .map(([key, value]) => `${key}=${value}`)
  .join(" ");
const tui = spawn(
  "script",
  [
    "-qec",
    `stty cols 200 rows 50 2>/dev/null; env ${pairs} OPENCODE_PASSWORD=${password} ` +
      `${binary} --server ${url} --session ${sessionID} --print-logs --log-level info`,
    logPath,
  ],
  { cwd: work, env: { ...runEnv, OPENCODE_PASSWORD: password }, stdio: "ignore" },
);
console.log("sidebar: TUI up, waiting for the first paint");
await new Promise((resolve) => setTimeout(resolve, 30_000));

if (!bootOnly) {
  console.log("sidebar: appending a second phase with the TUI live");
  const append = driveUntil(
    "Call the todo tool exactly once with op=append, phase='Verification', items=['run the suite']. Then stop.",
    (phases) => phases.some((phase) => phase.name === "Verification"),
  );
  check(
    "the append landed in the session",
    append.ok,
    `last seen: ${JSON.stringify(append.phases)?.slice(0, 300)}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}

// Capture the persisted phases while the server is still up: `session export`
// needs a live server, and the sidebar's expected rows are derived from them.
const persistedPhases = bootOnly ? [] : (phasesIn(sessionID) ?? []);

tui.kill("SIGTERM");
await new Promise((resolve) => setTimeout(resolve, 3_000));
try {
  tui.kill("SIGKILL");
} catch {}
shutdown();

const raw = readFileSync(logPath, "utf8");
// The TUI paints with absolute cursor positioning, so a single visual row
// arrives as several writes at different columns. Replay the escapes into a
// grid and read the sidebar the way a person sees it.
const lines = screenLines(raw, { rows: 60, cols: 220 });

console.log("\n--- sidebar rows on screen ---");
// Assert on the RENDERED row format, not loose substrings: the transcript
// echoes the prompt text and the tool's JSON, so a bare "Foundation" match
// would pass without the sidebar drawing anything.
//
// The transcript pane shares screen rows with the sidebar, so a match must be
// anchored to the end of the line and the phase name may not contain a run of
// spaces — that run is the gap between the two panes.
const PHASE_ROW = /(?:^|\s)([A-Z][\w.-]*(?: [\w.-]+)*) (\d+)\/(\d+)\s*$/;
const SUMMARY_ROW = /(?:^|\s)(\d+)\/(\d+) done(?:, (\d+) blocked)?\s*$/;
const TASK_ROW = /[✓✗●○⊘] /;
const phaseName = (line) => {
  const match = PHASE_ROW.exec(line);
  return match ? match[1] : undefined;
};
for (const line of lines) {
  if (phaseName(line) || SUMMARY_ROW.test(line) || TASK_ROW.test(line)) {
    console.log(`  ${line.trim().slice(0, 120)}`);
  }
}

check(
  "the plugin loaded with no TUI error",
  !/failed to load plugin|entrypoint not found|Invalid V2 TUI/i.test(raw),
  raw
    .split("\n")
    .filter((line) => /failed to load|entrypoint not found|Invalid V2 TUI/i.test(line))
    .slice(0, 3)
    .join("\n"),
);
check(
  "the sidebar drew a summary row with the overall count",
  lines.some((line) => SUMMARY_ROW.test(line)),
  `looked for a row like "1/3 done"`,
);
check(
  "the sidebar drew a phase row with its done count",
  lines.some((line) => phaseName(line) === "Foundation"),
  `looked for a row like "Foundation 0/2"`,
);
check(
  "the sidebar drew a marker-prefixed task row",
  lines.some((line) => TASK_ROW.test(line)),
  `looked for a row like "○ scaffold crate"`,
);

// The strongest assertion available: derive the rows the sidebar SHOULD draw
// from the phases the tool actually persisted, then require each on screen. A
// row that overflowed and wrapped would not appear as one line, so this also
// pins the no-wrap property without a heuristic.
//
// The host clips a row to its own content width, which is narrower than the
// slot's 42 columns once padding is taken out, so the painted text is a PREFIX
// of the row this module builds. Match that prefix anywhere in the line, since
// the transcript pane shares the row. The prefix includes the status marker,
// which only the sidebar draws, so transcript prose cannot satisfy it.
if (!bootOnly) {
  const expected = buildTodoHud(persistedPhases).rows.map((row) => rowText(row, SIDEBAR_WIDTH));
  const painted = lines.join("\n");
  const MIN_PREFIX = 12;
  const missing = expected.filter((row) => {
    const prefix = row.slice(0, Math.min(row.length, MIN_PREFIX));
    return !painted.includes(prefix);
  });
  console.log(`\nexpected sidebar rows (${expected.length}): ${JSON.stringify(expected)}`);
  check(
    "the sidebar rendered every row the persisted phases imply",
    missing.length === 0,
    `missing: ${JSON.stringify(missing)}`,
  );
  check(
    "the sidebar updated after a live append",
    lines.some((line) => phaseName(line) === "Verification"),
    "no Verification phase row appeared",
  );
}

if (keep) console.log(`\nsidebar: keeping ${root}`);
else rmSync(root, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\nsidebar: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nsidebar: all checks passed");
