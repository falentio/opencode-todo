# opencode-todo

An OpenCode v2 plugin that gives the agent a phased todo list, and gives you a
`/todo` command to inspect and edit it.

A port of [`@gamaraan/todos-tool`](https://github.com/gamaraan/todos-tool-pi-extension),
a pi coding-agent extension, which is itself a port of [Oh My Pi](https://github.com/oh-my-pi)'s
todo tool. The tool's semantics, prompts, and tests come from that lineage.

```
Todo  2/5 done
  I. Foundation 1/2
    ✓ Scaffold crate
    ○ Wire workspace
  II. Auth 1/3
    ○ Port credential store
```

## What the agent gets

A `todo` tool with nine operations. Tasks are addressed by their exact content
string, never by a generated ID.

| `op`      | Fields                               | Effect                                      |
| --------- | ------------------------------------ | ------------------------------------------- |
| `init`    | `list: [{phase, items}]`             | Replace the whole list                      |
| `start`   | `task`                               | Mark in progress                            |
| `done`    | `task` or `phase`                    | Mark completed                              |
| `drop`    | `task` or `phase`                    | Mark abandoned                              |
| `block`   | `task` or `phase`; optional `reason` | Mark blocked, waiting on something external |
| `unblock` | `task` or `phase`                    | Blocked task back to pending                |
| `rm`      | optional `task` or `phase`           | Remove; omit both to clear                  |
| `append`  | `phase`; `items`                     | Add tasks, creating the phase if needed     |
| `view`    | none                                 | Read-only echo                              |

Three behaviors matter when reading the code:

- **Auto-promote fires only when nothing is in progress.** Completing a task
  with no in-progress task promotes the earliest open one. Out-of-order work can
  move the pointer back to an earlier phase, which is expected; a completed task
  never reverts.
- **A failing batch is discarded whole.** A half-applied batch makes a retry hit
  "already exists" for the operations that did land, so nothing is applied and
  the previous state stands.
- **A missing `op` is repaired when the shape is unambiguous.** `{list: [...]}`
  is `init`, `{phase, items}` is `append`, and bare `items` on an empty list is
  `init`. Every other shape is an error.

## What you get

```
/todo                              Show current todos
/todo edit                         Open todos in $EDITOR
/todo copy                         Print todos as Markdown
/todo export [<path>]              Write todos to a file (default TODO.md)
/todo import [<path>]              Replace todos from a file (default TODO.md)
/todo append [<phase>] <task...>   Append a task, creating the phase if needed
/todo start  <task>                Mark a task in progress
/todo done   [<task|phase>]        Mark a task, a phase, or everything completed
/todo drop   [<task|phase>]        Mark abandoned
/todo rm     [<task|phase>]        Remove
```

Task and phase arguments match fuzzily: exact first, then a unique prefix, then
a unique substring. Manual edits are recorded and the model is told what changed,
including an explicit "do not recreate" instruction after a removal.

## Session behavior

While the tool is enabled, the plugin watches the session and can inject three
hidden messages.

- **Eager prelude.** With `eager` set to `preferred` or `always`, the first turn
  of a new session asks the model to lay out a phased plan with one `init` call.
  A resumed session never injects it, and neither does a prompt ending in `?` or
  `!`. OpenCode cannot force a tool call, so `always` injects a MUST-call
  reminder rather than a `tool_choice`.
- **Mid-run nudge.** After 12 successful mutating tool calls with work still
  open, a nudge asks the model to mark finished tasks done. At most two per
  cycle.
- **Completion reminder.** When the model stops with work still open, a reminder
  lists the open items and starts a fresh turn. It never fires while the model is
  waiting on your answer, and it pauses until the model makes progress.
  `remindersMax` caps it at 3 per cycle by default.

The plugin also contributes a `todo-discipline` skill. Its description sits in
every system prompt, and it mandates a phased `init` before multi-step work and
marking each task done as it finishes rather than batching at the end.

## Install

From a checkout:

```bash
vp install && vp pack
ln -s "$PWD" ~/.config/opencode/plugins/opencode-todo
```

From npm, add it to `opencode.json`:

```json
{
  "plugins": ["@kevin/opencode-todo"]
}
```

## Configure

Settings come from four places, each overriding the last:

1. built-in defaults
2. `~/.config/opencode/todo.json`
3. `<project>/.opencode/todo.json`
4. `OPENCODE_TODO_*` environment variables, then the plugin entry's `options`

```json
{ "enabled": true, "reminders": true, "remindersMax": 3, "eager": "default" }
```

| Key            | Default     | Meaning                                                                                                           |
| -------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `enabled`      | `true`      | Registers the tool and every session behavior. A `false` in the global file is a floor; nothing can re-enable it. |
| `reminders`    | `true`      | Stop-time reminders.                                                                                              |
| `remindersMax` | `3`         | Reminder attempts per cycle.                                                                                      |
| `eager`        | `"default"` | `"default"`, `"preferred"`, or `"always"`.                                                                        |

The environment variables are `OPENCODE_TODO_ENABLED`, `OPENCODE_TODO_REMINDERS`,
`OPENCODE_TODO_REMINDERS_MAX`, and `OPENCODE_TODO_EAGER`. An invalid value warns
and keeps the previous one instead of silently falling back to the default.

## How it is built

State lives in OpenCode's plugin storage, one key per session. There is no
sidecar file.

```
ctx.tool.transform     → the todo tool
ctx.command.transform  → /todo
ctx.skill.transform    → todo-discipline
ctx.session.hook       → reads history, feeds the reminder tracker
ctx.session.synthetic  → injects a reminder and starts a turn
ctx.storage            → the persisted phase list
```

`src/` splits into a host-free core and thin v2 adapters:

```
src/
  types.ts          TodoStatus, TodoPhase, the tool's JSON Schema
  validate.ts       raw arguments and stored snapshots → typed values
  state.ts          pure reducers: every op, normalization, op inference
  execute.ts        one op against the phase list, with batch atomicity
  format.ts         the summary the model reads
  markdown.ts       Markdown round-trip for export, import, and edit
  persistence.ts    one storage key per session
  config.ts         file, environment, and option precedence
  prompts.ts        tool description and injected-message text
  tracker.ts        eager prelude, mid-run nudge, completion reminder
  command.ts        the /todo verbs
  skill.ts          loads the bundled skill
  index.ts          wiring only
```

The pure modules carry no OpenCode import. They are testable alone, and the
ported test suite exercises them directly.

## Develop

```bash
vp install
vp test run        # 147 unit tests
npx tsc --noEmit   # typecheck
vp check           # format and lint
vp pack            # build dist/
node scripts/smoke.mjs
```

`scripts/smoke.mjs` drives two real `opencode` processes in a sandbox directory,
then asserts against the exported session transcript. It checks that the tool is
in the model's catalog, that `init` ran and persisted, that a second process read
the list back with `view`, that the reminder fired, and that the command and
skill registered. Add `--load` to skip the model calls.

The transcript is the evidence rather than the model's reply, because a model
will sometimes report "there is no todo tool" while the tool result sits in the
transcript.

## Differences from the pi extension

| pi extension                                              | This plugin                                       |
| --------------------------------------------------------- | ------------------------------------------------- |
| Session branch replay for persistence                     | `ctx.storage`, one key per session                |
| Custom TUI rendering (roman numerals, collapsed viewport) | Plain text; v2 exposes no plugin tool renderer    |
| Desktop notifications over the pi EventBus                | Dropped; v2 has no plugin-facing notification bus |
| `--todo-*` CLI flags                                      | Environment variables and plugin `options`        |
| `$EDITOR` fallback outside the TUI                        | `$EDITOR` only; v2 has no plugin editor dialog    |
| OSC 52 clipboard for `/todo copy`                         | Prints the Markdown                               |

## License

MIT. Ported from Oh My Pi (MIT, © Can Bölük) and pi (MIT, © Mario Zechner).
