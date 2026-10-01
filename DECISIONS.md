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

| Symptom                                                                       | Root cause                                                                          | Fix                                             |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| Sandbox loaded no plugins at all                                              | `execFileSync({cwd})` leaves `PWD` stale; OpenCode resolves the project from `PWD`  | Set `env.PWD` in the smoke script               |
| A 0755 sandbox still loaded nothing                                           | `mkdtemp` creates 0700 and OpenCode skips plugins in a directory it cannot traverse | `chmod 755` after `mkdtemp`                     |
| `vp check` scanned `node_modules` and reported 110k warnings                  | No ignore patterns                                                                  | `lint.ignorePatterns`                           |
| `vp check` failed with `Detected cycle while resolving name 'configDefaults'` | A vite-plus 0.3.1 bug                                                               | Upgraded to vite-plus 1.0.0                     |
| Lint died with `SIGKILL` before analysis                                      | `tsgolint` exceeds this machine's memory limit                                      | `typeAware: false`; `tsc --noEmit` covers types |

## Verification

| Gate            | Command                  | Result                             |
| --------------- | ------------------------ | ---------------------------------- |
| Unit tests      | `vp test run`            | 147 passed                         |
| Typecheck       | `npx tsc --noEmit`       | clean                              |
| Format and lint | `vp check`               | 0 errors, 0 warnings               |
| Build           | `vp pack`                | `dist/index.mjs`, 67 kB            |
| End to end      | `node scripts/smoke.mjs` | 11/11 checks, stable across 3 runs |

The smoke test's checks: the CLI responds, the tool is in the model's catalog,
`init` ran and completed, the summary listed both tasks, the metadata carried
the phases, a second process read the list back with `view`, the reminder fired,
`/todo` registered, the skill registered, the plugin loaded without error, and
the tool reported no argument error.
