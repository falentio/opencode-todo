#!/usr/bin/env node
/**
 * Smoke test: prove the built plugin works inside a real OpenCode v2 process.
 *
 * Two sandboxes, each with its own `opencode.json`, plugin symlink, and
 * session, because the plugin reads its config once at setup:
 *
 * - **persistence** (reminders off): a run initializes a list, then a second
 *   process reads it back with `op=view`. Two processes, so the check proves
 *   the list survived rather than that one call returned.
 * - **reminder** (reminders on): a run leaves work open and the tracker must
 *   inject a synthetic reminder.
 *
 * Every assertion reads the exported session transcript. A model will report
 * "there is no todo tool" while the tool result sits in the transcript, so the
 * transcript is the only trustworthy evidence.
 *
 * Usage:
 *   node scripts/smoke.mjs          full run (needs a working model)
 *   node scripts/smoke.mjs --load   load-only (no model call, CI-safe)
 *
 * Environment:
 *   OPENCODE_TODO_SMOKE_MODEL   provider/model for the drive (default 9router/glm)
 *   OPENCODE_TODO_SMOKE_KEEP=1  keep the sandboxes for inspection
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const loadOnly = process.argv.includes("--load");
const model = process.env.OPENCODE_TODO_SMOKE_MODEL ?? "9router/glm";

const failures = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok && detail) {
    for (const line of String(detail).split("\n").slice(0, 8)) {
      console.log(`         ${line}`);
    }
  }
  if (!ok) failures.push(name);
}

/** A throwaway project directory with the plugin symlinked into it. */
function makeSandbox(label, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), `opencode-todo-smoke-${label}-`));
  // mkdtemp creates 0700. OpenCode does not register plugins for a project
  // directory it cannot traverse, so a 0700 sandbox silently loads nothing.
  chmodSync(dir, 0o755);
  const pluginDir = join(dir, ".opencode", "plugins");
  mkdirSync(pluginDir, { recursive: true });
  symlinkSync(packageRoot, join(pluginDir, "opencode-todo"));
  writeFileSync(
    join(dir, "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`,
  );
  writeFileSync(join(dir, ".opencode", "todo.json"), `${JSON.stringify(config, null, 2)}\n`);

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "OPENCODE" || key.startsWith("OPENCODE_")) delete env[key];
  }
  // `execFileSync({ cwd })` changes the child's working directory but leaves
  // `PWD` pointing at the parent's, and OpenCode resolves the project location
  // from `PWD`. Without this the sandbox's plugins are never discovered and the
  // run silently uses the parent's project.
  env.PWD = dir;

  function run(args, timeout = 300_000) {
    try {
      return {
        ok: true,
        out: execFileSync("opencode", args, {
          cwd: dir,
          env,
          timeout,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        console.log("smoke: SKIP, opencode is not on PATH");
        rmSync(dir, { recursive: true, force: true });
        process.exit(process.env.CI === "true" ? 1 : 0);
      }
      return {
        ok: false,
        out: String(error?.stdout ?? error?.stderr ?? error?.message ?? error),
      };
    }
  }

  return { label, dir, run };
}

/** Every `todo` tool call recorded in the session transcript. */
function todoCalls(sandbox, sessionID) {
  const exported = sandbox.run(["session", "export", sessionID], 60_000);
  if (!exported.ok) return { error: exported.out, calls: [] };
  let parsed;
  try {
    parsed = JSON.parse(exported.out);
  } catch (error) {
    return { error: `session export is not JSON: ${String(error)}`, calls: [] };
  }
  const calls = [];
  for (const message of parsed.messages ?? []) {
    if (message.type !== "assistant") continue;
    for (const part of message.content ?? []) {
      if (part.type !== "tool" || part.name !== "todo") continue;
      calls.push({
        input: part.state?.input,
        status: part.state?.status,
        text: (part.state?.content ?? []).map((c) => c.text ?? "").join("\n"),
        metadata: part.state?.metadata,
      });
    }
  }
  return { calls };
}

/** The text of every assistant message in a session. */
function assistantText(sandbox, sessionID) {
  const exported = sandbox.run(["session", "export", sessionID], 60_000);
  if (!exported.ok) return undefined;
  try {
    const parsed = JSON.parse(exported.out);
    return (parsed.messages ?? [])
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
  } catch {
    return undefined;
  }
}

/** Synthetic messages the tracker injected. */
function reminders(sandbox, sessionID) {
  const exported = sandbox.run(["session", "export", sessionID], 60_000);
  if (!exported.ok) return [];
  try {
    const parsed = JSON.parse(exported.out);
    return (parsed.messages ?? []).filter(
      (message) => message.type === "synthetic" && message.description === "todo reminder",
    );
  } catch {
    return [];
  }
}

/** Run a prompt, retrying while `predicate` stays false. Model tool choice is flaky. */
function drive(sandbox, sessionID, prompt, predicate, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    sandbox.run(["run", "--session", sessionID, "--model", model, prompt]);
    if (predicate()) return { ok: true, attempt };
  }
  return { ok: false, attempt: attempts };
}

function newSessionID() {
  return `ses_smoke${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Ask the host what the plugin registered.
 *
 * A second plugin drops into the sandbox and calls `ctx.command.list()` and
 * `ctx.skill.list()` at setup. A server plugin has no other way to enumerate
 * the command palette, and the slash command never appears in the tool catalog.
 */
function probeRegistrations(sandbox) {
  const dir = join(sandbox.dir, ".opencode", "plugins", "zz-registration-probe");
  mkdirSync(dir, { recursive: true });
  const out = join(sandbox.dir, "registrations.json");
  writeFileSync(
    join(dir, "index.mjs"),
    `import { writeFileSync } from "node:fs";
export default {
  id: "zz-registration-probe",
  async setup(ctx) {
    const commands = await ctx.command.list();
    const skills = await ctx.skill.list();
    writeFileSync(${JSON.stringify(out)}, JSON.stringify({
      commands: (commands.data ?? commands ?? []).map((c) => c.name),
      skills: (skills.data ?? skills ?? []).map((s) => s.id ?? s.name),
    }));
  },
};
`,
  );
  sandbox.run(["run", "--model", model, "Reply with exactly: PROBE"], 300_000);
  try {
    return JSON.parse(readFileSync(out, "utf8"));
  } catch {
    return {};
  }
}

function logDirectory(sandbox) {
  const table = sandbox.run(["debug", "paths"], 60_000);
  if (!table.ok) return undefined;
  const line = table.out.split("\n").find((candidate) => candidate.startsWith("log"));
  return line?.split(/\s+/).slice(1).join(" ").trim() || undefined;
}

const persistence = makeSandbox("persistence", { reminders: false });
const reminder = makeSandbox("reminder", { reminders: true });

console.log(`smoke: persistence sandbox ${persistence.dir}`);
console.log(`smoke: reminder sandbox    ${reminder.dir}`);
console.log(`smoke: plugin              ${packageRoot}`);

// A freshly created project directory boots with an empty tool catalog on the
// first call: the location is being registered while that call runs, so plugin
// tools are not in it yet. One throwaway call warms each location.
for (const sandbox of [persistence, reminder]) {
  sandbox.run(["run", "--model", model, "Reply with exactly: WARM"], 300_000);
}

const logDir = logDirectory(persistence);
check("opencode CLI responds and reports a log directory", Boolean(logDir));
const logFile = logDir ? join(logDir, "opencode.log") : undefined;
const logStart = logFile && existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0;

if (!loadOnly) {
  const sessionID = newSessionID();

  // Deterministic: the tool must be in the catalog the model is handed.
  persistence.run([
    "run",
    "--session",
    sessionID,
    "--model",
    model,
    "List every tool name available to you, comma separated, nothing else.",
  ]);
  const catalog = assistantText(persistence, sessionID);
  check(
    "the todo tool is registered in the model's catalog",
    Boolean(catalog && /(^|[\s,])todo([\s,]|$)/.test(catalog)),
    catalog?.slice(0, 500),
  );

  const initDrive = drive(
    persistence,
    sessionID,
    "Call the todo tool once with op=init and list [{phase:'Smoke', items:['first probe','second probe']}]. Then stop.",
    () => todoCalls(persistence, sessionID).calls.some((call) => call.input?.op === "init"),
  );
  const afterInit = todoCalls(persistence, sessionID);
  const initCall = afterInit.calls.find((call) => call.input?.op === "init");
  check(
    "the todo tool ran and completed",
    initCall?.status === "completed",
    initDrive.ok
      ? (afterInit.error ?? JSON.stringify(afterInit.calls))
      : `no init call after ${initDrive.attempt} attempts`,
  );
  check(
    "init returned the phased summary",
    Boolean(
      initCall?.text.includes("first probe") &&
      initCall?.text.includes("second probe") &&
      initCall?.text.includes("Smoke"),
    ),
    initCall?.text,
  );
  check(
    "init persisted the phases into the tool result metadata",
    JSON.stringify(initCall?.metadata?.phases ?? "").includes("first probe"),
    JSON.stringify(initCall?.metadata),
  );

  // A second process on the same session must read the stored list back. The
  // assertion reads the LAST view, because an earlier run may have called one.
  drive(persistence, sessionID, "Call the todo tool once with op=view. Then stop.", () =>
    todoCalls(persistence, sessionID).calls.some((call) => call.input?.op === "view"),
  );
  const views = todoCalls(persistence, sessionID).calls.filter((call) => call.input?.op === "view");
  const viewCall = views.at(-1);
  check(
    "a fresh process read the persisted list back with op=view",
    Boolean(
      viewCall?.status === "completed" &&
      viewCall.text.includes("first probe") &&
      viewCall.text.includes("second probe"),
    ),
    viewCall?.text ?? JSON.stringify(views),
  );

  // The reminder re-enters the loop and the model then reacts to it, so it gets
  // its own sandbox and session.
  const reminderSession = newSessionID();
  drive(
    reminder,
    reminderSession,
    "Call the todo tool once with op=init and list [{phase:'Smoke', items:['reminder probe']}]. Then stop immediately and leave it open.",
    () => todoCalls(reminder, reminderSession).calls.some((call) => call.input?.op === "init"),
  );
  const sent = reminders(reminder, reminderSession);
  check(
    "the stop-time reminder fired for the incomplete list",
    sent.length > 0,
    "no synthetic 'todo reminder' message in the transcript",
  );

  const probe = probeRegistrations(persistence);
  check(
    "the /todo command is registered",
    Boolean(probe.commands?.includes("todo")),
    JSON.stringify(probe.commands),
  );
  check(
    "the todo-discipline skill is registered",
    Boolean(probe.skills?.includes("todo-discipline")),
    JSON.stringify(probe.skills),
  );
}

const logTail = logFile ? readFileSync(logFile, "utf8").slice(logStart) : "";
check(
  "plugin loaded without a load error",
  !logTail.includes(`failed to load plugin") target=${packageRoot}`),
  logTail
    .split("\n")
    .filter((line) => line.includes("failed to load plugin"))
    .slice(0, 3)
    .join("\n"),
);
if (!loadOnly) {
  check("the todo tool reported no argument error", !logTail.includes("Invalid todo arguments"));
}

if (process.env.OPENCODE_TODO_SMOKE_KEEP === "1") {
  console.log(`smoke: keeping sandboxes`);
} else {
  for (const sandbox of [persistence, reminder]) {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.log(`\nsmoke: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke: all checks passed");
