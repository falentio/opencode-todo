# opencode-todo port: decision trail

Port of `gamaraan/todos-tool-pi-extension` (a pi coding-agent extension) to an
OpenCode v2 plugin.

## Definition of done

A fresh OpenCode v2 process loads the plugin, exposes the `todo` tool and the
`/todo` command, persists a phased list across processes, and injects a
reminder when the model stops with work open. Verified against the real binary
by `scripts/smoke.mjs`, which reads the exported session transcript.

**Verdict: VERIFIED.** `node scripts/smoke.mjs` passes 11/11 checks, three runs
in a row. Evidence is the session transcript, not the model's reply.

## Host API map

Every row was established by a live probe against opencode v2.0.21, not by
reading docs.

| Capability       | pi (source)                        | OpenCode v2 (target)                                                  | How it was established                               |
| ---------------- | ---------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| Plugin entry     | `pi` extension factory             | `export default { id, setup(ctx) }`                                   | A load error names the required shape                |
| Register tool    | `pi.registerTool` + TypeBox        | `ctx.tool.transform(e => e.add({name, description, input, execute}))` | Probe: tool callable, `session.tool.success` fired   |
| Tool args schema | TypeBox                            | JSON Schema object                                                    | Probe: `input: {type:"object", properties}` accepted |
| Tool result      | return string + `details`          | return `{content, metadata}`                                          | Probe: `session.tool.success` carried `metadata`     |
| Persistence      | session branch replay              | `ctx.storage.get/set/scan`                                            | Probe: round trip                                    |
| Slash command    | `pi.registerCommand`               | `ctx.command.transform(e => e.add({name, description, execute}))`     | `ctx.command.list()` inside the host shows `todo`    |
| Inject context   | `before_agent_start`               | `ctx.session.hook("context", e => e.system.push(part))`               | Probe: pushed part, hook re-fired                    |
| Read history     | `session.entries`                  | `ctx.session.hook("context")` `event.messages`                        | Probe: user/assistant/tool roles visible             |
| Trigger a turn   | `sendMessage({triggerTurn})`       | `ctx.session.synthetic({sessionID, text, resume: true})`              | Probe: message landed and re-entered context         |
| Skills           | `resources_discover`               | `ctx.skill.transform(e => e.add(skill))`                              | `ctx.skill.list()` shows `todo-discipline`           |
| Events           | `agent_settled`                    | `ctx.event.subscribe()` (`session.execution.succeeded`)               | Probe: event fired with `data.sessionID`             |
| Tool rendering   | pi-tui `renderCall`/`renderResult` | none; tool output is text                                             | Probe: `result: {type:"text", value}`                |

## Decisions

| #   | Decision                                                                                              | Why                                                                                             | Alternative rejected                                                                  |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Keep the pure reducer core (`state.ts`, `execute.ts`, `format.ts`, `markdown.ts`) as the port's spine | Host-free, already tested, and the right shape for the domain (an op-application model)         | Rewriting state logic would discard ~1200 lines of pinned behavior                    |
| 2   | Persist through `ctx.storage`, not tool-result replay                                                 | v2 ships a session-scoped KV store; the pi branch-replay existed only because pi had none       | Replaying `metadata` off message parts couples the port to an undocumented projection |
| 3   | Replace TypeBox with a hand-written validator in `validate.ts`                                        | v2 tool arguments are plain JSON; TypeBox is not a v2 dependency                                | Shipping TypeBox for one schema                                                       |
| 4   | Drop the pi-tui renderer                                                                              | v2 tool results are plain text and expose no plugin renderer                                    | Porting components against an API that does not exist                                 |
| 5   | Drop desktop notifications                                                                            | The source gates them on OSC 9/99 terminal focus detection, a pi EventBus feature               | No v2 equivalent                                                                      |
| 6   | Name the tool `todo`                                                                                  | The v2 catalog has no `todo` tool, so there is no collision                                     | A prefixed name would break the ported prompt and skill text                          |
| 7   | Keep the bundled `todo-discipline` skill                                                              | `ctx.skill.transform` is the v2-native way to contribute it                                     | Inlining the guidance into the tool description loses load-on-demand                  |
| 8   | Config from a JSON file plus `options`, read once at setup                                            | The plugin runs in the shared background server, so a CLI environment variable never reaches it | Environment overrides were built, found unreachable, and removed                      |
| 9   | One `TodoTracker` per session, with state passed in                                                   | The pi port's stale-reminder bug came from the tracker caching phases                           | A tracker holding its own copy                                                        |
| 10  | Retry the model drive in the smoke test                                                               | The model intermittently reports "there is no todo tool" while calling it                       | Trusting the model's prose                                                            |

## Bugs found and fixed during the port

| Symptom                                                                       | Root cause                                                                                                       | Fix                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Sandbox loaded no plugins at all                                              | `execFileSync({cwd})` leaves `PWD` stale; OpenCode resolves the project from `PWD`                               | Set `env.PWD` in the smoke script                                         |
| A 0755 sandbox still loaded nothing                                           | `mkdtemp` creates 0700 and OpenCode skips plugins in a directory it cannot traverse                              | `chmod 755` after `mkdtemp`                                               |
| `vp check` scanned `node_modules` and reported 110k warnings                  | No ignore patterns                                                                                               | `lint.ignorePatterns`                                                     |
| `vp check` failed with `Detected cycle while resolving name 'configDefaults'` | A vite-plus 0.3.1 bug                                                                                            | Upgraded to vite-plus 1.0.0                                               |
| Lint died with `SIGKILL` before analysis                                      | `tsgolint` exceeds this machine's memory limit                                                                   | `typeAware: false`; `tsc --noEmit` covers types                           |
| Sidebar row ended in a lone `\ud83c` before the ellipsis                      | Truncating at a fixed code-unit index lands inside an emoji's surrogate pair                                     | Cut on grapheme clusters via `Intl.Segmenter`                             |
| A CJK row wrapped onto a second screen row                                    | `rowText` capped UTF-16 units, but the host wraps at display columns                                             | Measure display columns; a wide glyph counts two                          |
| An astral CJK or Tangut row wrapped, though `displayWidth` said 36            | The wide-glyph regex covered only the BMP, so CJK Ext B-G, Tangut, Kana Supplement, and Nushu counted one column | Encode the astral wide ranges as data and include regional indicators     |
| The sidebar did not update after a `/todo` edit                               | `/todo` writes storage and sends a synthetic message; the sidebar reads only tool results                        | Corrected the claim; a manual edit appears on the next `todo` tool result |

## Verification

| Gate            | Command                          | Result                                       |
| --------------- | -------------------------------- | -------------------------------------------- |
| Unit tests      | `vp test run`                    | 168 passed                                   |
| Typecheck       | `npx tsc --noEmit`               | clean                                        |
| Format and lint | `vp check`                       | 0 errors, 0 warnings                         |
| Build           | `vp pack`                        | `dist/index.mjs`, 67 kB                      |
| End to end      | `node scripts/smoke.mjs`         | 11/11 checks, stable across 3 runs           |
| Sidebar         | `node scripts/sidebar-check.mjs` | 7/7 checks, sidebar painted and updated live |

The smoke test's checks: the CLI responds, the tool is in the model's catalog,
`init` ran and completed, the summary listed both tasks, the metadata carried
the phases, a second process read the list back with `view`, the reminder fired,
`/todo` registered, the skill registered, the plugin loaded without error, and
the tool reported no argument error.

## Sidebar

The todo list renders in the TUI session sidebar. The port's original
DECISIONS row 4 dropped the pi renderer because "v2 tool results are plain text
and expose no plugin renderer" — that was true of the tool surface, and false of
the TUI. `@opencode/plugin/tui` publishes `ui.slot`, and the host's `SlotMap`
declares `sidebar.content`.

Every claim below came from running opencode 2.0.21, not from docs.

| Question                                        | Finding                                                                                                                                               | Evidence                                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is there a sidebar surface?                     | `SlotMap` publishes `sidebar.content` and `sidebar.footer`, input `{sessionID}`                                                                       | `@opencode/plugin/dist/tui/context.d.ts`; host renders the outlet                                                                                               |
| How does a TUI plugin load?                     | `cli.json` `plugins` array; entry `{id, setup}`; the host resolves `./tui` and transpiles `.ts`/`.tsx` with no build step                             | `oc-tps` ships raw `tui.tsx`; loader log `entrypoint=.../tui.tsx`                                                                                               |
| Where does the TUI read todo state?             | Off the assistant messages. `data.session.message.list(sid)` exposes tool parts whose `state.metadata.phases` is the plugin's own tool result, intact | `scripts/sidebar-check.mjs`                                                                                                                                     |
| Is the render reactive?                         | Yes. `data.on("session.tool.success")` fires per mutation and the message list is already fresh inside the handler                                    | one shared `opencode serve`; a snapshot at the event showed the new phase                                                                                       |
| Does the TUI entry need its own `node_modules`? | No. The host supplies `@opentui/solid` and `solid-js`                                                                                                 | rendered with `node_modules` moved away; declared as optional peers                                                                                             |
| Does the host truncate the metadata?            | Not at these sizes; it adds `truncated: false` beside the plugin's keys                                                                               | metadata dumps at 3 phases / 24 tasks                                                                                                                           |
| What is the sidebar's usable width?             | 37 display columns. A wider row WRAPS onto a second screen row, which breaks the column layout, so rows truncate to 36                                | independent probe painting labeled rows at 28-44 columns: 37 fits on one line, 38 wraps and keeps all its characters; the host measures columns, not code units |

**Design.** `src/hud.ts` is the host-free view model and `src/tui.tsx` is a thin
slot adapter, so the view logic is unit tested rather than eyeballed. Rows are a
discriminated union and the status markers are an exhaustive
`Record<TodoStatus, string>`, so a new status is one entry and one type error,
not another branch. `selectCollapsedTodos` and `COLLAPSED_ITEMS_CAP` were
ported, tested, and had zero callers; the sidebar is their consumer.

**Refresh.** The event path is the hot path: `session.tool.success` fires on
each todo mutation and the message list is already fresh inside the handler. A
2s poll recovers a missed event, not a `/todo` edit. `/todo` writes storage and
sends a synthetic message, and the sidebar reads only tool results, so a manual
edit appears on the next `todo` tool result. An earlier draft claimed the poll
covered `/todo`; an independent probe refuted that by watching the sidebar stay
byte-identical across seven poll intervals after a `/todo` write.

**Rejected.** An RPC channel between the server and TUI plugins
(`ctx.rpc.register`). It needs a definition, handlers, and a subscribe protocol
to carry data the tool result already carries.

**Probe discipline.** The first reactivity probe reported "no events", and that
was wrong: it gave both processes `--standalone`, so each had a private server
and nothing could cross. The corrected probe uses one shared `opencode serve`
with `OPENCODE_PASSWORD`. The first sidebar assertions were also wrong, matching
`Foundation` anywhere in the log including the transcript's echo of the prompt.
They now replay the PTY escapes into a screen grid (`scripts/screen.mjs`) and
match the rendered row format, and the negative control confirms transcript text
alone cannot satisfy them.

## Publishing

The package publishes as `@falentio/opencode-todo`. Two defects had to be fixed
first, and both were invisible from a checkout. Every claim below came from
running opencode 2.0.21 and npm 11.19.0.

### The loader's entrypoint contract

The host picks entrypoints with this function, decompiled from the 2.0.21
binary. For a named package it resolves `<name>/server`, then bare `<name>`, then
`<name>/tui`, through Node resolution and therefore through the installed
package's `exports` map.

```js
function Rm(r) {
  let n = (t) => {
    for (let o of t) {
      let i = r.name ? [r.name, o].filter(Boolean).join("/") : s.resolve(r.directory, o || "index");
      try {
        return Xm(i, r.directory);
      } catch (e) {
        /* skip ENOENT, MODULE_NOT_FOUND, ERR_PACKAGE_PATH_NOT_EXPORTED */
      }
    }
    return;
  };
  return { server: n(["server", ""]), tui: n(["tui"]), rpc: n(["rpc"]) };
}
```

A package with neither a server nor a TUI entrypoint is rejected whole, with
`Plugin package has no server or TUI entrypoint: <spec>`. `@falentio/opencode-zedokai`
carries an empty `./server` for exactly this reason.

### Bug: the packed artifact could not load

| Symptom                                                                                       | Root cause                                                                                                                                                                            | Fix                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node -e "import('<pkg>/dist/index.mjs')"` threw `ERR_MODULE_NOT_FOUND` on a real npm install | `dist/index.mjs` runtime-imported `@opencode/plugin`, declared as an _optional_ peer, so npm installed nothing for it. A checkout hid this by resolving the repo's own `node_modules` | `import type` in `src/index.ts`, plus a typed object literal instead of `Plugin.define`. `define` is the identity function, so this deletes the dependency rather than adding one |

### Bug: a raw `.tsx` TUI entrypoint does not survive publishing

| Symptom                                             | Root cause                                                                                                                                                                                                          | Fix                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| The sidebar never appeared from a published install | The host's solid JSX transform filter is `/^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx?$/`, a negative lookahead that **excludes** `node_modules`. A symlinked checkout is transpiled; an installed package is not | `src/tui.tsx` is now a second `pack.entry`, and `./tui` points at the built `dist/tui.mjs` |

`dist/tui.mjs` imports `solid-js` and `@opentui/solid/jsx-runtime`, which the host
supplies to `node_modules` code through its runtime module map
(`nodeModulesRuntimeSpecifiers`). Both stay optional peers for that reason.

### Why the probe unpacks instead of naming the registry package

The host npm-installs a named spec before resolving it. A registry name would
make the probe fetch the package from npm and fail with a 404 before the first
publish, and placing files in the config directory's `node_modules` is not
enough, because the host re-installs and overwrites them. The probe therefore
unpacks the tarball under a `node_modules` path and names that path as a `file:`
spec, which reaches the same resolution and transform path a registry install
takes.

`opencode serve` on its own does not reconcile plugins, so a bare server boot
proves nothing. The TUI is the surface that reconciles, and the probe reads its
loader log.

### Manifest

| Field              | Value                                                        | Why                                                                                        |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `exports`          | `.`, `./server` → `dist/index.mjs`; `./tui` → `dist/tui.mjs` | Both entrypoint names the loader probes, plus the bare name                                |
| `dependencies`     | none                                                         | The host supplies the runtime. A bundled copy would duplicate it and break plugin identity |
| `peerDependencies` | `@opentui/solid`, `solid-js`, both optional                  | The host maps these specifiers for `node_modules` code                                     |
| `publishConfig`    | `access: public`, `provenance: true`                         | Scoped packages default to restricted, and provenance is free on a public repo             |
| `engines`          | `opencode: ^2.0.0`                                           | The plugin targets the v2 API only                                                         |

### The first publish needs a token

npm trusted publishing cannot publish a package's initial version. The npmjs.com
UI requires the package to exist before a trusted publisher can be attached
(npm/cli#8544, still open). So 0.1.0 goes out with a token, and later versions go
out through the `publish.yml` OIDC workflow once the trusted publisher points at
`falentio/opencode-todo` and `.github/workflows/publish.yml`.
