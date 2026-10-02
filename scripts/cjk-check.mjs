#!/usr/bin/env node
/**
 * Prove a CJK todo list does not wrap in the sidebar.
 *
 * The host wraps a sidebar row wider than 37 display columns onto a second
 * screen row. A CJK character is one UTF-16 code unit and two columns, so a
 * code-unit cap let a row wrap. This drives a CJK list through the real TUI and
 * counts how many screen rows the sidebar consumes.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenLines } from "./screen.mjs";
import { buildTodoHud, displayWidth, rowText, SIDEBAR_WIDTH } from "../src/hud.ts";

const binary = process.env.OPENCODE_BIN ?? "opencode";
const model = process.env.OPENCODE_TODO_SMOKE_MODEL ?? "9router/glm";
const root = mkdtempSync(join(tmpdir(), "todo-cjk-"));
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
for (const d of [
  env.HOME,
  env.XDG_CONFIG_HOME,
  env.XDG_DATA_HOME,
  env.XDG_CACHE_HOME,
  env.XDG_STATE_HOME,
  env.TMPDIR,
])
  mkdirSync(d, { recursive: true });
mkdirSync(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
const work = join(root, "work");
mkdirSync(work, { recursive: true });

const providerConfig = JSON.parse(
  readFileSync(join(process.env.HOME, ".config", "opencode", "opencode.json"), "utf8"),
);
delete providerConfig.$schema;
for (const key of ["mcp", "plugin", "plugins", "instructions"]) delete providerConfig[key];
writeFileSync(
  join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
  JSON.stringify({ $schema: "https://opencode.ai/config.json", ...providerConfig }, null, 2) + "\n",
);
mkdirSync(join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
try {
  writeFileSync(
    join(env.XDG_DATA_HOME, "opencode", "auth.json"),
    readFileSync(join(process.env.HOME, ".local", "share", "opencode", "auth.json")),
  );
} catch {}

mkdirSync(join(work, ".opencode", "plugins"), { recursive: true });
symlinkSync(
  "/home/kevin/Repositories/opencode-todo",
  join(work, ".opencode", "plugins", "opencode-todo"),
);
writeFileSync(
  join(work, "opencode.json"),
  JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n",
);
writeFileSync(
  join(env.XDG_CONFIG_HOME, "opencode", "cli.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/v2/cli.json",
      session: { sidebar: "auto" },
      plugins: ["file:/home/kevin/Repositories/opencode-todo"],
    },
    null,
    2,
  ) + "\n",
);

const runEnv = { ...env, PWD: work };
const port = 49800 + Math.floor(Math.random() * 90);
const url = `http://127.0.0.1:${port}`;
const server = spawn(
  binary,
  ["serve", "--port", String(port), "--print-logs", "--log-level", "info"],
  { cwd: work, env: runEnv, stdio: ["ignore", "pipe", "pipe"] },
);
let serverOut = "";
server.stdout.on("data", (c) => (serverOut += c));
server.stderr.on("data", (c) => (serverOut += c));
let password = "";
for (let i = 0; i < 120 && !password; i++) {
  const m = /server password (\S+)/.exec(serverOut);
  if (m) password = m[1];
  else await new Promise((r) => setTimeout(r, 500));
}
if (!password) {
  console.log("cjk: no password");
  server.kill("SIGKILL");
  process.exit(1);
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
function phasesIn(sessionID) {
  const out = spawnSync(binary, ["session", "export", "--server", url, sessionID], {
    cwd: work,
    env: { ...runEnv, OPENCODE_PASSWORD: password },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (out.status !== 0) return undefined;
  try {
    let phases;
    for (const m of JSON.parse(out.stdout).messages ?? []) {
      for (const p of m.content ?? []) {
        if (
          p.type === "tool" &&
          p.name === "todo" &&
          p.state?.status === "completed" &&
          Array.isArray(p.state?.metadata?.phases)
        )
          phases = p.state.metadata.phases;
      }
    }
    return phases;
  } catch {
    return undefined;
  }
}

const sessionID = `ses_cjk${Date.now().toString(36)}`;
// A freshly registered location boots with an empty tool catalog on its first
// call, so warm a throwaway session before driving the real one.
run("Reply with exactly: WARM", sessionID);
run("Reply with exactly: WARM2", `ses_cjkwarm${Date.now().toString(36)}`);
// Long CJK task content: 40 units would be 80 columns if measured in code units.
const cjkTasks = [
  "日本語のタスク内容をここに書きます非常に長い説明文です",
  "二番目の項目も十分に長い日本語のテキストにします",
];
for (let attempt = 1; attempt <= 4; attempt++) {
  run(
    `Call the todo tool exactly once with op=init and list=[{phase:'実装',items:[${cjkTasks.map((t) => `'${t}'`).join(",")}]}]. Then stop.`,
    sessionID,
  );
  const phases = phasesIn(sessionID);
  if (phases && phases.length === 1) break;
}

const logPath = join(root, "tui.log");
const pairs = Object.entries(env)
  .filter(([k]) => k.startsWith("XDG_") || k === "HOME" || k === "TMPDIR")
  .map(([k, v]) => `${k}=${v}`)
  .join(" ");
const tui = spawn(
  "script",
  [
    "-qec",
    `stty cols 200 rows 50 2>/dev/null; env ${pairs} OPENCODE_PASSWORD=${password} ${binary} --server ${url} --session ${sessionID} --print-logs --log-level info`,
    logPath,
  ],
  { cwd: work, env: { ...runEnv, OPENCODE_PASSWORD: password }, stdio: "ignore" },
);
await new Promise((r) => setTimeout(r, 30_000));
// Capture while the server is up: `session export` needs a live server.
const finalPhases = phasesIn(sessionID);

tui.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 3000));
try {
  tui.kill("SIGKILL");
} catch {}
server.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
try {
  server.kill("SIGKILL");
} catch {}

const lines = screenLines(readFileSync(logPath, "utf8"), { rows: 60, cols: 220 });

// The sidebar occupies the rightmost columns. A row that wrapped would push its
// tail onto the next screen row, so counting the screen rows the list consumes
// is the check: the persisted list needs exactly one row per rendered line, and
// a wrap adds one.
const persisted = finalPhases ?? [];
const expectedRows = buildTodoHud(persisted).rows.map((row) => rowText(row, SIDEBAR_WIDTH));
const missing = expectedRows.filter((row) => !lines.some((line) => line.includes(row)));

console.log("--- sidebar region (cols 150..205) ---");
for (const l of lines) {
  const region = l.slice(150, 205);
  if (region.trim()) console.log("  " + JSON.stringify(region));
}
console.log(`\ncjk: expected rows (${expectedRows.length}): ${JSON.stringify(expectedRows)}`);

const failures = [];
// The check is worthless if the drive never persisted CJK content: it would
// then assert "No todos" is on one line, which exercises nothing.
const cjkTasksPersisted = persisted
  .flatMap((phase) => phase.tasks)
  .filter((t) => /[\u3000-\u9fff]/.test(t.content));
if (persisted.length === 0) {
  failures.push("no todo list was persisted; the drive did not run");
} else if (cjkTasksPersisted.length === 0) {
  failures.push(`the persisted list carries no CJK task: ${JSON.stringify(persisted)}`);
}
if (missing.length > 0)
  failures.push(`rows not found whole on one line: ${JSON.stringify(missing)}`);
for (const row of expectedRows) {
  if (displayWidth(row) > 37)
    failures.push(`row exceeds the host's 37-column limit: ${JSON.stringify(row)}`);
}

for (const failure of failures) console.log(`  [FAIL] ${failure}`);
if (failures.length > 0) {
  console.log(`\ncjk: ${failures.length} check(s) failed`);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
console.log(`\ncjk: all checks passed (${expectedRows.length} rows, each whole on one line)`);
rmSync(root, { recursive: true, force: true });
