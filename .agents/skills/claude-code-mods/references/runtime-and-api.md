# Runtime and API

A hooks module is not a Node.js program and not a web page. It is an ES module that Claude Code loads into an environment of its own and calls through `register(on, options)`. Everything outside the module, from files to the network, processes, the interface, and models, is reached through `$`, the mods API every hook receives. Because each `$` call is spelled out in the source, Claude Code can list what a mod does before it runs it.

## The environment

The 2.1.321 declarations name what a module has:

- **Globals**: `h` and `Fragment` (what JSX compiles against), the JSX namespace, and the environment's web APIs, such as `URL`, `TextEncoder`, `AbortController`, and `crypto.subtle`. `crypto.randomUUID()` worked at module top level in a real 2.1.321 session (observed).
- **Not present**: no DOM, no Node.js modules, no `require`, no `setTimeout` or `setInterval` (use `$.clock`), no global `fetch` (use `$.http.fetch`), no file or process access of its own.
- **Where installed mods run**: one shared worker thread. The debug log shows `hooks module <name> loaded (worker, environment 1, tier user)` for a user's mod and `native` for the built-ins (observed). A hook that blocks that thread, such as a loop that never awaits, gets its mod unloaded with `<mod> was unloaded: it crashed the hooks worker`. After three crashes Claude Code cannot attribute, every mod that is not built in is off until `/reload-plugins` ([troubleshooting](https://code.claude.com/docs/en/plugins/mods/troubleshoot)).

Keep CPU-heavy or long-running work out of the hooks module. Run it in a process through `$.process.run` or `$.process.spawn`, or in a companion service (Recommendation).

## The entry point

```typescript
import type { Register } from 'claude-code';

export const register: Register = (on, options) => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e);
    return result;
  });
};
```

- **`register(on, options)`**: runs once per load and again on every reload. `options` holds the manifest's `userConfig` values, defaults filled in. Its return value is dropped, and a returned promise is awaited.
- **`on(event, matcher?, hook)`**: adds a hook and returns a registration whose one method is `.catch(handler)`. See [events and lifecycle](events-and-lifecycle.md).
- **`($, e, next)`**: `$` is the mods API (`EngineInterface`), `e` is the event's input as deeply frozen plain data, and `next(e)` runs the rest of the chain and resolves to the event's result. `turn.step` and `process.spawn` hooks are async generators instead.

## Imports

| Import | What it provides | Where |
| :-- | :-- | :-- |
| `import type { ... } from 'claude-code'` | Every declared type, such as `Register`, `On`, `EngineInterface`, `PluginState`, `Shaped`, `StateFamily`, `ToolCallResult`, and `ModelCompleteResult` | Hooks modules, contracts, tests |
| `import { atom, read, update, derive, memberOf } from 'claude-code'` | The five state helpers, the only runtime values the module exports | Hooks modules |
| `import { test, describe, expect, mock, tier } from 'claude-code/testing'` | The test kit | `*.test.ts` and `*.test.tsx` files only |
| `import { name } from './file'` | The plugin's own files, by relative path, inside the plugin folder | Anywhere in the plugin |

First-party mods import their own files without extensions (`import type { Host } from './host'`), and the type-check uses `moduleResolution: "bundler"`. Use top-level `import` declarations only. A dynamic `import()` is refused at validation and load.

## Static analysis

Claude Code reads the module's source before running it, to list its hooks, calls, environment variables, and state, and refuses a module it cannot read. `claude plugin validate` runs the same analysis. These outcomes were observed on 2.1.295, 2.1.309, 2.1.316, and 2.1.321 unless a row says otherwise:

| Code | Result |
| :-- | :-- |
| `$.store.get('notes')`, spelled in full | Accepted and listed under `calls:` |
| `const ui = $.ui`, destructuring `$`, or a computed member such as `$[name]` | Refused: `$.ui is used as a value (a noun of $ bound, passed or read)` |
| `on(EVENT, hook)` with a variable or a loop of names | Refused: `the event name passed to on() is not a string literal` |
| `$.env.get(NAME)` with a variable | Refused: `$.env.get takes a literal name as its first argument` |
| `$` passed to a function declared at the top level of the same file | Accepted, listed as `$.ui.status (via show)` |
| `$` passed to a function declared inside `register` or inside a hook | Refused: `$ is passed to "show", which is not a function declared at the top of this file` |
| `$` passed to a function imported from another file of the plugin | Refused on 2.1.295 (`$ is followed only into a function declared in this same file, never across an import`); first observed accepted on 2.1.309, with the builds between unchecked. The documentation still describes the refusal. |
| An object of closures, each spelling a `$` call, passed to an imported helper | Accepted on every build, with each closure's call listed |
| The same event registered twice without a matcher | Refused: `on("session.start") is registered twice without a matcher` |
| A second variable or parameter named `on` inside `register` | Refused (documented: `"on" is declared again (shadowed)`) |
| An `import()` | Refused: `a dynamic import(); a hooks module imports its own files with an import declaration` |
| A bare import other than `claude-code` | Refused: `cannot import "lodash" ... a hooks module imports its own files by relative path and "claude-code", nothing else` |

`read` and `update` from `claude-code` are the imports that may take `$` on every build. `$.state` references need literal `plugin` and `key`, and each `atom` result must be held in a `const`. See [state, configuration, and environment](state-configuration-and-environment.md).

## Keep `$` at the boundary

Put logic that does not need Claude Code in ordinary TypeScript modules, so tests can call it directly, and keep the integration thin. When imported logic needs a capability, give it a narrow adapter built where `$` is in scope rather than `$` itself. The built-in `diff` mod does this: its `session.start` hook builds a `Host` object whose members each spell one `$` call, and every later hook, timer, and press uses that object ([first-party source](https://github.com/anthropics/claude-code/tree/main/mods/diff)).

```typescript
// connection.ts: plain TypeScript, no `$`.
export type CompanionHost = {
  fetch: (
    url: string,
    init: { method?: string; body?: string },
  ) => Promise<{ status: number; text: string }>;
  now: () => Promise<number>;
};

export async function isServiceHealthy(host: CompanionHost, url: string): Promise<boolean> {
  const response = await host.fetch(`${url}/health`, { method: 'GET' });
  return response.status === 200;
}

// register.ts: the adapter, built inside the hook that has `$`.
import { isServiceHealthy } from './connection';
import type { CompanionHost } from './connection';

on('session.start', async ($, e, next) => {
  const host: CompanionHost = {
    fetch: (url, init) => $.http.fetch(url, init),
    now: () => $.clock.now(),
  };
  // Not awaited, so the session starts without waiting on the network.
  isServiceHealthy(host, 'http://127.0.0.1:47615').then(
    (isHealthy) => $.ui.status(isHealthy ? undefined : 'the companion service is not answering'),
    () => $.ui.status('the companion service is not answering'),
  );
  return next(e);
});
```

The validator lists every call inside the closures, so a reviewer still sees what the mod reaches. This pattern also keeps working on builds that refuse `$` across an import. Do not turn every helper into an adapter call or an HTTP endpoint: a pure function that takes data needs neither (Recommendation). The [companion template](../assets/templates/companion-service/README.md) uses this shape.

A timer callback or a button handler can keep using a `$` captured by the hook that created it. The documented background-work example and the `diff` mod both do. Calls made after the hook returned run in the mod's own context: a relative path then resolves against the session's directory, not a subagent's (`$.session.cwd` declaration).

## JSX and elements

A `.tsx` or `.jsx` module may write trees as JSX, which compiles against the global `h`. The elements are not globals: destructure them per drawing from the surface's table with `const { Box, Text, Button } = $.ui.resolve(e)`. Without JSX, call them as functions, as in `Text({ children: ['ready'] })`. There is no React: no components with their own state, no hooks such as `useState`, no effects, and no web component libraries. A drawing is a plain-data tree the hook returns again whenever Claude Code redraws. See [UI and rendering](ui-and-rendering.md).

## Capability map

The namespaces of `$` in 2.1.321, from the declarations. Each method's own doc comment and example are in the build's `claude-code/index.d.ts`.

| Namespace | Methods | What it is for | Notes |
| :-- | :-- | :-- | :-- |
| `$.plugin` | `name`, `root` | This plugin's manifest name and absolute directory | Properties, not calls |
| `$.ui` | `resolve`, `invalidate`, `open`, `close`, `panes`, `place`, `scroll`, `focus`, `toast`, `notify`, `cancelNotify`, `status`, `log`, `notice`, `ask`, `copy`, `selection`, `blit`, `view` | Drawing, redraws, panes, placed rows, notices, questions, clipboard | `view` 2.1.300, `place` 2.1.314 |
| `$.theme` | `set`, `clear` | A backdrop the Desktop or mobile app draws | 2.1.319; replaced `$.ui.backdrop` |
| `$.command` | `register`, `run`, `list` | Slash commands the person runs | Register in `session.start` |
| `$.tool` | `register`, `call`, `check`, `list` | Tools the model calls; calling tools; asking the permission verdict | Registered tools are `mcp__<plugin>__<name>` |
| `$.agent` | `register`, `spawn`, `list` | Subagent types, starting subagents, this session's agents | See [models, agents, and sessions](models-agents-and-sessions.md) |
| `$.model` | `complete`, `fork`, `classify` | A side request to a model | Billed to the session's credentials |
| `$.prompt` | `submit`, `read`, `media`, `fill`, `paint`, `suggest`, `compose` | Starting a turn, the prompt box, a submitted prompt's attachments, system prompt sections | `submit` waits for an idle session |
| `$.turn` | `abort` | Ending the main loop's running turn, by the `turnId` its `turn.start` carried | Rejects for any other turn |
| `$.session` | `messages`, `cwd`, `root`, `model`, `turns`, `id`, `repo`, `surfaces`, `surface`, `usage`, `version`, `compact`, `send`, `append`, `authorize`, `identity` | The conversation, its directory and identity, usage, messaging | `surface` is deprecated; `identity` answers only organization-installed mods |
| `$.config` | `list`, `set` | The `/config` menu's rows | Not a `settings.json` editor |
| `$.settings` | `read` | Merged settings, one source, or one key | Read only; `{ key }` 2.1.304 |
| `$.env` | `get`, `set` | This process's environment, inherited by everything it starts after | Literal names only |
| `$.fs` | `read`, `write`, `list`, `exists`, `stat`, `ancestors` | Files as the person's account reaches them | 4 MiB a file; `write` is not atomic |
| `$.store` | `get`, `set`, `delete`, `keys` | The plugin's JSON key-value store, shared by every local session | 4 MiB in all |
| `$.state` | `get`, `set` | Reactive, versioned values for the session | Use `atom`, `read`, `update` |
| `$.clock` | `now`, `sleep`, `after`, `every` | Time and timers | Timers end with the module |
| `$.http` | `fetch` | HTTP and HTTPS through the host | Whole-body responses, 30 seconds, 4 MiB |
| `$.process` | `run`, `spawn` | Host commands by argument vector, no shell | Declared as "CLI only" |
| `$.mcp` | `call`, `connect` | Calling a tool on a connected MCP server; connecting one the plugin's manifest lists | A plugin's `call` opens no permission prompt |
| `$.audio` | `play`, `speak` | A clip from the plugin's files; platform speech | `afplay` and `say` on macOS |
| `$.telemetry` | `log`, `mark` | First-party analytics rows and collector records | A first-party row is sent only for Claude Code and built-in mods |

A mod can also add a noun of its own in an `engine.create` hook and ship its types as a contract; the built-in `telemetry` mod does this for `$.telemetry`. Other mods list it under `dependencies` to see its types.

## Every call is an event

Each `$` method is also an event named for it, such as `fs.write` or `model.complete`. A hook on that event sees the calls of the mods that run after it in the chain, and can pass them on, rewrite them, answer `{ value }`, or refuse with `{ deny }`, which makes the caller's call reject. That is how a policy mod limits other mods. Two consequences matter when writing hooks:

- **Your own call skips only the calling hook**: the `$.tool.call` declaration says a call "runs through every hook but the calling one (the plugin's others see it)", so an observer elsewhere in the same module can see a call your guard makes. In the test kit, `$.ui.ask` reaches the stubs as an `AskUserQuestion` tool call, so a broad `tool.call` stub must tell that call apart by `e.tool`.
- **Interception covers mods only**: a hook on `fs.write` sees mods' `$.fs.write` calls, not every write on the machine, not the model's `Write` tool (that is `tool.call`), and not what a process the mod started does.

`next.origin` names who raised the event (`{ plugin: 'engine', tier: 'core' }` for Claude Code itself), which is how a hook tells the engine's own `settings.read` or `http.fetch` from another mod's.
