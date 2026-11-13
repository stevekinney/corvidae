# State, configuration, and environment

A mod handles several kinds of values, and each belongs in a different place. Putting one in the wrong place is the most common way a mod loses data, shows stale values, or races another session.

## Separate the kinds of state

| Kind | Examples | Where it belongs |
| :-- | :-- | :-- |
| Disposable implementation state | A pending timer, an in-flight flag, a cache rebuilt on demand | A module variable |
| UI state for this session | Which tab is open, which row is expanded, the latest snapshot a pane draws | `$.state` |
| Small per-person persistence | A preference, a counter, recent history | `$.store`, mirrored into `$.state` for drawing |
| Configuration the person sets | An endpoint, a mode, a threshold | `userConfig`, which arrives as `options` |
| Conversation history | Prompts, responses, tool results | Claude Code's own transcript; read with `$.session.messages()`, add with `$.session.append` |
| Agent execution state | Which subagents run and their status | Claude Code's own; read with `$.agent.list()` |
| Live presence | Which sessions are alive right now | A heartbeat to a service that expires silent entries |
| Durable business state | Claims, leases, accepted decisions, acknowledgments | A database owned by a companion service |

The last two rows are outside what the mods API offers. See [companion services and coordination](companion-services-and-coordination.md).

## Lifetimes and scopes

| Place | Survives a reload | Survives `/clear`, `/resume`, `/branch` | Survives the session | Shared with | Reactive | Atomic | Limits |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| Module variable | No | Yes, the module is not reloaded | No | This loaded copy only | No | Not applicable | Memory |
| `$.state` | Yes | No, reset to defaults | No | The session; any plugin can read a value | Yes | Compare-and-set per value | JSON values |
| `$.store` | Yes | Yes | Yes | Every local session running this plugin | No | No | 4 MiB of JSON in all |
| `userConfig` options | Yes, and a change reloads the module | Yes | Yes | Every session reading those settings | No | Not applicable | Declared fields only |
| A companion database | Yes | Yes | Yes | Whatever the service allows | Through polling | As the database provides | The service's |

These sources support the table: [Draw in the interface](https://code.claude.com/docs/en/plugins/mods/interface) "Keep state", the `$.state` and `$.store` declarations, and the reference's limits. A `$.store` value lasts until the mod deletes it, or until no session reads or writes the store for `cleanupPeriodDays`. The store is a JSON file of the plugin's own under `~/.claude/plugins/store/`; files there were named `<plugin>_<id>.json` (observed). Treat the file as an implementation detail, not an interface.

## `$.state`

`$.state` holds named, versioned values for the session. A `ui.render` hook that reads a value subscribes to it, so writing the value redraws exactly the drawings that read it, and no `$.ui.invalidate` call is needed.

### Declare the values

Declare each value under the plugin's name in a contract file, and name the file in the manifest with `"types": "./types/index.d.ts"`:

```typescript
export type AgentRow = { id: string; status: string };

declare module 'claude-code' {
  interface PluginState {
    'agent-roster': {
      agents: Shaped<AgentRow[]>;
      isExpanded: StateFamily<boolean>;
      isBandHidden: boolean;
    };
  }
}
```

- **`Shaped<T>`**: a value stored with a tag. An atom created with `{ shape: 'agents-1' }` reads a value stored under any other tag as its initial value. Change the tag whenever the value's shape changes, because new code meets what old code stored across a reload.
- **`StateFamily<T>`**: one value per `id`, such as per row or per agent. A reference to a member carries `id`. Only `id` may be computed; `plugin` and `key` must be literals.

The validator holds every state key the module names to this contract. An undeclared key fails with `<plugin>.<key> is not declared` (documented).

### The helpers

These are the exact 2.1.321 signatures, simplified:

| Helper | Signature | Behavior |
| :-- | :-- | :-- |
| `atom` | `atom(ref, initial)` or `atom(ref, initial, { shape })` returns `Atom<T>` | Pure: builds a frozen description and calls nothing. A family's atom is given without `id`. |
| `read` | `read($, source)` returns `Promise<T>` | Reads an atom or a derived value, never `undefined` for an atom. While drawing, it subscribes the drawing. A raw reference reads `T \| undefined`. |
| `update` | `update($, target, change)` returns `Promise<T>` | Reads, applies `change`, and writes with `ifVersion`, trying again on a miss, so two presses before a redraw both land. Keep `change` pure: it can run more than once. |
| `derive` | `derive(sources, compute)` returns `Derived<T>` | Pure. `read` recomputes only when a source's version moved, and reading it subscribes to every source. |
| `memberOf` | `memberOf(family, { requestId })` returns `Atom<T>` | Adds the member's `id`, taken from `requestId`, to a family atom. Inside a render hook pass `e` itself; for a row keyed by its own id, pass `{ requestId: id }`. |

```typescript
import { atom, derive, memberOf, read, update } from 'claude-code';
import type { Register } from 'claude-code';

const agents = atom({ plugin: 'agent-roster', key: 'agents' } as const, [], { shape: 'agents-1' });
const isExpanded = atom({ plugin: 'agent-roster', key: 'isExpanded' } as const, false);
const activeCount = derive(
  [agents],
  (rows) => rows.filter((row) => row.status === 'running').length,
);

export const register: Register = (on) => {
  // Reading while drawing subscribes this drawing to both values.
  on('ui.render', { component: 'Pane', requestId: 'agent-roster' }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e);
    const rows = await read($, agents);
    const running = await read($, activeCount);
    const first = rows[0];
    if (first === undefined) return Text({ children: ['No agents yet.'] });
    const isOpen = await read($, memberOf(isExpanded, { requestId: first.id }));
    return Box({
      flexDirection: 'column',
      children: [
        Text({ children: [`${running} running`] }),
        // Writing happens in a handler, never in the render hook itself.
        Button({
          key: `toggle-${first.id}`,
          label: isOpen ? 'Hide details' : 'Show details',
          onPress: () =>
            update($, memberOf(isExpanded, { requestId: first.id }), (value) => !value),
        }),
      ],
    });
  });
};
```

The underlying calls are `$.state.get(ref)`, which resolves `{ value, version }` (a value never written is `undefined` at version 0), and `$.state.set(ref, value, { ifVersion })`, which resolves `{ isSet, version }`. Every `get` in one dispatch reads one moment.

### Rules

- **Literal references**: write `plugin` and `key` as string literals and hold each `atom` in a `const`. A `let` fails with `takes a source the scan can read` (documented).
- **No writes while drawing**: `$.state.set` is refused inside a `ui.render` hook. Write from `onPress`, `onSubmit`, `onSelect`, a timer, or another event's hook.
- **Owner writes**: any plugin can read any value, but only its owner writes it. Another plugin changes a value by hooking `state.set` and passing a different `value`. Plugin namespacing is a naming convention, not a security boundary.
- **JSON only**: values are JSON data as `$.store` takes them, never `undefined`.
- **Not a transaction**: `update` is compare-and-set on one value. Nothing makes two values change together, and nothing crosses sessions.

### Restore after `/clear`, `/resume`, and `/branch`

Those commands reset every `$.state` value to its default, and `session.start` does not fire again. A mod that mirrors `$.store` into `$.state` must copy it again, or the drawing shows defaults. Worse, a handler that saves the `$.state` value can then write the default over what was stored. The documented recipe re-copies the value in a `classic.SessionStart` hook filtered to `source: ['clear', 'resume', 'fork']`.

Where the built-in guard loads, a user-installed mod's `classic.*` hooks never run, so that recipe silently does nothing there. The [reactive-pane template](../assets/templates/reactive-pane/README.md) keeps the recipe and adds a fallback meant to work in both cases. Its tests exercise the fallback from default state, but no live `/clear` was run with the guard loaded, so confirm it in a session (Unverified there):

- `session.start` restores on every load and reload
- `classic.SessionStart` restores at once where it runs
- `session.end` with `reason` `clear` or `resume` sets a module flag. Module variables survive those commands, because the module is not reloaded.
- The next main-loop `turn.start` restores when the flag is set
- Every handler saves to `$.store` before it updates `$.state`, and re-reads the store before a read-modify-write, so a reset can never overwrite the stored value

## `$.store`

`$.store.get(key)`, `set(key, value)`, `delete(key)`, and `keys()` keep JSON values across sessions. `set` stores what `JSON.parse(JSON.stringify(value))` gives back: a `Date` becomes its ISO string, an `undefined` field disappears, and a `Map` or `Set` becomes `{}`. It rejects a function, a cycle, or a store over 4 MiB.

Every session on the machine that runs the plugin shares one store, and a `get` followed by a `set` is not atomic. Two sessions that read, change, and write one key race, and the later write wins ([interface page](https://code.claude.com/docs/en/plugins/mods/interface)). To reduce that:

- **One key per item**: a `set` changes only its own key
- **Re-read right before writing**: build the new value from a fresh `get` in the handler, not from a copy loaded at `session.start`
- **Leave coordination elsewhere**: anything that needs a lock, a lease, or exactly-one ownership belongs in a service with a real transaction

`$.store` is not reactive. Writing it does not redraw anything, and another session's write is not seen until something reads the store again. `$.fs.write` is not atomic either: it replaces a file's content in place, so another process can read a partly written file.

## Who can reach what

| Who | Module variables | `$.state` | `$.store` |
| :-- | :-- | :-- | :-- |
| The mod's own hooks, timers, and handlers | Yes | Yes | Yes |
| The mod's hooks on a subagent's events (`e.agentId` set) | Yes, the same module | Yes, the same session's values | Yes |
| Another mod in the session | No | Reads any value; changes one only through a `state.set` hook | Can intercept the store calls of mods after it in the chain |
| Another session on the machine | No | No, it has its own | Yes, the same plugin's store |
| A subagent's model, or the main model | No | No | No |
| Any local process running as the person | No | No | Yes, the file is readable |

Claude sees a value only when the mod puts it in front of Claude: a tool result, a command's `text`, a `prompt.submit` `context`, a `$.session.append` row, or a system prompt section. Subagents do not receive the parent's state directly.

## Configuration

Four mechanisms look alike and are not interchangeable:

- **`userConfig` and `options`**: the plugin's own settings, declared in the manifest and delivered to `register(on, options)` with defaults filled in. Non-sensitive values are stored under `pluginConfigs` and each appears as a `/config` row keyed `<plugin>.<field>`. A change reloads the module with the new `options`.
- **`$.config.list()` and `$.config.set({ key, value })`**: the `/config` menu's rows, built-in and plugin alike, after every `config.describe` hook. Each `ConfigRow` has `key`, `label`, `description`, `kind`, `value`, `options`, `provider`, and `isLocked`. `set` changes a row as if the person did, through the other plugins' `config.set` hooks with `origin` `{ kind: 'plugin', name }`. It answers `{ deny }` when a hook refused, the value does not fit, a trusted source owns the row (`isLocked`), or only the row's dialog can change it. It is not a way to edit arbitrary `settings.json` keys.
- **`$.settings.read()`**: a read-only snapshot of the merged settings, or of one source (`{ source: 'user' | 'project' | 'local' | 'flag' | 'policy' }`), or one top-level key (`{ key }`, 2.1.304 or later). Settings can hold credentials in `env` and helper commands, so read only what the mod needs.
- **`settings.read` hooks**: change or refuse what the session or another mod reads. A changed `env` or permission rule there has no effect, and where the guard loads a user mod's hook is skipped ([events page](https://code.claude.com/docs/en/plugins/mods/events)).

## Environment variables

`$.env.get('NAME')` and `$.env.set('NAME', value)` read and write the environment of the Claude Code process. Every Bash command, MCP server, and `$.process.run` started after a `set` inherits the change, and `set('NAME', undefined)` unsets it. The name must be a string literal, so `claude plugin validate` can list it under `env reads:` and `env writes:`. A computed name is refused. `set` resolves `{}` once written, or `{ deny }` when the engine holds the write. An organization's session can hold a write that the person's own settings file could not make.

Several variables carry plugin paths, and each exists in a specific context ([manifest reference](https://code.claude.com/docs/en/plugins-reference), [hooks reference](https://code.claude.com/docs/en/hooks)):

| Variable | Where it exists | In a mod, use instead |
| :-- | :-- | :-- |
| `CLAUDE_PLUGIN_ROOT` | Substituted in, and exported to, hook commands, MCP and LSP servers, and skill and agent content. Points at the installed version's directory. | `$.plugin.root` |
| `CLAUDE_PLUGIN_DATA` | The same components; `~/.claude/plugins/data/<id>/`, kept across updates | A path built from it in a companion, or `$.store` |
| `CLAUDE_PROJECT_DIR` | Hook commands, stdio MCP servers, LSP servers; the project root where the session started | `$.session.root()` |
| `CLAUDE_PLUGIN_OPTION_<KEY>` | Hook processes, one per `userConfig` option | `options` |
| `CLAUDE_ENV_FILE` | `SessionStart` settings hooks: a file whose `export` lines persist variables for later Bash commands | `$.env.set` |
| `CLAUDE_CODE_PLUGIN_DIRS`, `CLAUDE_CODE_PLUGIN_DIR_WATCH` | The Claude Code process environment; the first also in `env` of `~/.claude/settings.json` | Development settings, not mod code |

None of the first five is documented as present in the Claude Code process environment that `$.env.get` reads, and Bash commands do not receive the plugin path variables. Do not read them from a mod. Use the API properties in the last column.

The environment a mod sees depends on how the session started. A terminal session inherits the shell's environment. A Desktop app session starts from the app, and `env` blocks in settings files add to the process environment. A companion service has whatever environment its own launcher gives it. Never log the whole environment, `$.settings.read()` output, or any secret value. Read the one variable the mod needs (Recommendation).

## Paths

| Value | Meaning |
| :-- | :-- |
| `$.plugin.root` | The plugin's own directory, the one holding `.claude-plugin/plugin.json`, absolute. Resolve bundled files from it. |
| `$.plugin.name` | The manifest name |
| `$.session.cwd()` | The session's working directory. Inside a hook for a subagent's event, a relative `$.fs` path resolves against that subagent's directory. A timer that outlives its hook reads the session's. |
| `$.session.root()` | The project root: where the session started, or where `/cd`, the host, or a worktree move took it. A shell `cd` does not move it. |

`$.fs` paths may be absolute; a relative path resolves against the working directory of the session, or of the subagent whose event the hook handles. `$.audio.play({ asset })` names a file of the plugin's own.
