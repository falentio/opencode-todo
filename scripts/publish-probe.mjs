#!/usr/bin/env node
/**
 * Prove the packed artifact works the way a published install uses it.
 *
 * A checkout hides two failures that a published install exposes.
 *
 * - `dist/index.mjs` must not import a package it does not declare. A checkout
 *   resolves `@opencode/plugin` from its own `node_modules` even when the
 *   manifest lists it as an optional peer, so only a real npm install shows the
 *   failure.
 * - The host resolves a plugin's entrypoints through the installed package's
 *   `exports` map, and the installed package sits under a `node_modules`
 *   directory. The host's JSX transform skips paths under `node_modules`, so a
 *   `.tsx` entrypoint works from a checkout and fails once published.
 *
 * Two arms, one per failure.
 *
 * - **install** npm-installs the tarball and imports the entrypoint with a bare
 *   `node` process, which has no access to the checkout's `node_modules`.
 * - **boot** unpacks the tarball under a `node_modules` path and boots the TUI
 *   against it. The TUI is the surface that reconciles plugins; `opencode serve`
 *   on its own does not, so a bare server boot proves nothing here.
 *
 *   node scripts/publish-probe.mjs           pack, install, boot, assert
 *   node scripts/publish-probe.mjs --keep    keep the sandbox
 *
 * Environment:
 *   OPENCODE_BIN   opencode binary (default `opencode` on PATH)
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.OPENCODE_BIN ?? "opencode";
const keep = process.argv.includes("--keep");

const failures = [];
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok && detail) {
    for (const line of String(detail).split("\n").slice(0, 12)) console.log(`         ${line}`);
  }
  if (!ok) failures.push(name);
}

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const segments = manifest.name.split("/");

const root = mkdtempSync(join(tmpdir(), "opencode-todo-publish-probe-"));
console.log(`probe: sandbox ${root}`);

const tarball = join(
  root,
  execFileSync("npm", ["pack", "--pack-destination", root], { cwd: packageRoot, encoding: "utf8" })
    .trim()
    .split("\n")
    .at(-1),
);

function scratchEnv(label) {
  const home = join(root, label, "home");
  const work = join(root, label, "work");
  const configDir = join(home, ".config", "opencode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PWD: work };
  for (const key of Object.keys(env)) {
    if (key === "OPENCODE" || key.startsWith("OPENCODE_")) delete env[key];
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.PWD = work;
  return { home, work, configDir, env };
}

console.log("\narm 1: npm install");
const install = scratchEnv("install");
let installError = "";
try {
  execFileSync("npm", ["install", tarball, "--no-audit", "--no-fund"], {
    cwd: install.configDir,
    env: install.env,
    encoding: "utf8",
    stdio: "pipe",
  });
} catch (error) {
  installError = String(error.stderr ?? error.message).slice(0, 600);
}
const installed = join(install.configDir, "node_modules", ...segments);
check("the tarball installs with npm", existsSync(installed), installError);

// The regression this probe exists for. An optional peer installs nothing, so a
// runtime import of one throws here while it resolves fine from a checkout.
const hostDep = join(install.configDir, "node_modules", "@opencode", "plugin");
console.log(`  npm installed @opencode/plugin: ${existsSync(hostDep)} (must be false)`);

let entrypoint = "";
try {
  entrypoint = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(join(installed, "dist", "index.mjs"))})
         .then((m) => console.log("ok", m.default.id, typeof m.default.setup))
         .catch((e) => { console.log("fail", e.code); process.exit(1); });`,
    ],
    { encoding: "utf8" },
  ).trim();
} catch (error) {
  entrypoint = String(error.stdout ?? "").trim() || String(error.message).slice(0, 300);
}
check(
  "the installed server entrypoint imports with only node builtins",
  entrypoint.startsWith("ok todo function"),
  entrypoint,
);

console.log("\narm 2: published layout boot");
const boot = scratchEnv("boot");
// A registry name would make the host fetch the package from npm and 404 before
// the first publish, so this arm names an unpacked copy instead. It sits under a
// `node_modules` directory, which is the layout that decides resolution.
const published = join(boot.home, "pkg", "node_modules", ...segments);
mkdirSync(published, { recursive: true });
execFileSync("tar", ["xzf", tarball, "-C", published, "--strip-components=1"], {
  encoding: "utf8",
});
const spec = `file:${published}`;

writeFileSync(
  join(boot.work, "opencode.json"),
  `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [spec] }, null, 2)}\n`,
);
writeFileSync(
  join(boot.configDir, "cli.json"),
  `${JSON.stringify(
    { $schema: "https://opencode.ai/v2/cli.json", session: { sidebar: "show" }, plugins: [spec] },
    null,
    2,
  )}\n`,
);

const logPath = join(root, "tui.log");
const tui = spawn(
  "script",
  [
    "-qec",
    `stty cols 200 rows 50 2>/dev/null; ${binary} --standalone --print-logs --log-level debug`,
    logPath,
  ],
  { cwd: boot.work, env: boot.env, stdio: "ignore" },
);

// The host reconciles plugins on its own schedule, so wait for the evidence
// rather than guessing a sleep long enough.
const deadline = Date.now() + 60_000;
let log = "";
while (Date.now() < deadline) {
  log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  if (/stage=setup plugin=opencode-todo\.sidebar/.test(log)) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
tui.kill("SIGKILL");
await new Promise((resolve) => setTimeout(resolve, 300));

const entrypoints = [...new Set([...log.matchAll(/entrypoint=(\S+)/g)].map((m) => m[1]))];
const setups = [...new Set([...log.matchAll(/stage=setup plugin=(\S+)/g)].map((m) => m[1]))];
const problems = [
  ...new Set(
    [
      ...log.matchAll(
        /entrypoint not found|Cannot find package|ERR_MODULE_NOT_FOUND|no server or TUI entrypoint|SyntaxError|Unexpected token/gi,
      ),
    ].map((m) => m[0]),
  ),
];

console.log(
  `  entrypoints: ${entrypoints.map((e) => e.replace(root, ".")).join(", ") || "(none)"}`,
);
console.log(`  setups: ${setups.filter((s) => !s.startsWith("opencode.")).join(", ") || "(none)"}`);
console.log(`  problems: ${problems.join(" | ") || "(none)"}`);

check(
  "the server entrypoint resolved through the exports map",
  entrypoints.some((e) => e.includes(`${manifest.name}/dist/index.mjs`)),
  entrypoints.join("\n"),
);
check(
  "the TUI entrypoint resolved to the built file",
  entrypoints.some((e) => e.includes(`${manifest.name}/dist/tui.mjs`)),
  entrypoints.join("\n"),
);
check(
  "the TUI entrypoint ran its setup",
  setups.includes("opencode-todo.sidebar"),
  setups.join("\n"),
);
check("no resolution or syntax problem was reported", problems.length === 0, problems.join("\n"));

if (keep) console.log(`\nprobe: kept ${root}`);
else rmSync(root, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
  console.log("publish probe: all checks passed");
  process.exit(0);
}
console.log(`publish probe: ${failures.length} failed -> ${failures.join(", ")}`);
process.exit(1);
