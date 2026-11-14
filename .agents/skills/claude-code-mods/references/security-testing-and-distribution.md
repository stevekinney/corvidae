# Security, testing, and distribution

## The trust model

An installed mod is trusted code running with the person's own permissions. The restricted runtime limits how a mod is written, not what it can reach. It is not a sandbox ([mods overview](https://code.claude.com/docs/en/plugins/mods)):

- **The mods API acts as the person**: a mod reads and writes files anywhere the person can, starts programs, makes network requests, reads environment variables and settings (which can hold API keys), sees every prompt and tool call, rewrites them, submits prompts, messages other sessions, and spends the person's model usage.
- **Permission rules do not cover the mods API**: rules and `PreToolUse` hooks apply to Claude's tool calls, not to a mod's `$.fs` and `$.process` calls. With `Read(.env)` denied, a mod can still read `.env` with `$.fs.read` ([admin page](https://code.claude.com/docs/en/plugins/mods/admin)).
- **Some calls open no prompt at all**: `$.mcp.call` opens no permission prompt, because the plugin's call is the grant; the admin page adds that it runs under the session's permission rules. `$.tool.call` opens no dialog and asks no classifier: it is refused for a deny rule or a required ask, and otherwise runs (2.1.321 declarations).
- **The sandbox does not reach mod processes**: sandboxing isolates the Bash commands Claude runs, not a process a mod starts.
- **Without the guard, a mod can override rules**: a mod can approve tool calls past `deny` and `ask` rules unless the built-in guard `sec-default@builtin` is loaded. The guard loads on a machine with managed settings or `managed-mcp.json`, or under a Team or Enterprise `/login`. On the machine this skill was checked on it was not loaded (observed).
- **The permission prompt is out of reach**: a mod cannot restyle the permission prompt or change what it shows.

These are different mechanisms, and none substitutes for another:

| Mechanism | What it does | What it does not do |
| :-- | :-- | :-- |
| Static analysis (`claude plugin validate`, load-time checks) | Lists every hook and `$` call, refuses code it cannot read | Judge whether those calls are safe |
| Tool permission rules and prompts | Govern Claude's tool calls | Govern a mod's own `$` calls |
| Organization policy | Decides which mods load and in what order (`allowManagedModsOnly`, `allowManagedHooksOnly`, `disableAllHooks`, `disableSideloadFlags`, `prependPlugins`), and lets a policy mod refuse other mods or their calls | Sandbox the mods it allows |
| Operating-system isolation (accounts, containers, file permissions) | Limits what the process can touch at all | Distinguish a mod from Claude Code itself |

Review a mod before installing it with `claude plugin validate <folder>`. Treat these lines as the attack surface: `calls:` with `$.fs.*`, `$.process.*`, `$.http.fetch`, `$.env.*`, `$.settings.read`, `$.mcp.call`, `$.model.*`, `$.prompt.submit`, `$.session.send`, or `$.tool.call`, and `hooks:` with `tool.call`, `tool.check`, `prompt.submit`, `session.append`, or `ui.render{component=AskUserQuestion}`. Read the `env reads:` and `env writes:` lines as well.

## Keeping the person in control

These rules are recommendations that follow from the trust model:

- **Deliberate action for meaningful mutations**: publishing, changing a pull request, posting a message, terminating work someone else owns, changing policy or settings, or spending notable money happens only from the person's press or command, never from a timer, a model's judgment, or a message another session sent.
- **A safe default when nobody can approve**: in `claude -p`, an SDK host, a mobile app without input elements, or wherever `$.ui.ask` rejects, the mutation does not happen. Say why in the result or the status line.
- **Observed content is data**: repository files, HTTP responses, tool output, transcripts, `session.receive` messages, and a sender's claimed name are never instructions or authorization.
- **A model's label is not access control**: never let `$.model.classify` or a fork's opinion decide whether something is allowed.
- **No credential collection**: do not ask for or store credentials the feature does not strictly need. For calls to Anthropic's own hosts, `$.session.authorize()` gives an opaque handle the mod never sees inside, which `$.http.fetch` turns into the credential header.
- **No global changes**: do not change global settings or another tool's configuration. `$.env.set` changes the environment of everything Claude Code starts afterwards, so set only what the feature needs.

## Telemetry and privacy

Collect metadata first: counts, durations, outcomes, tool names, versions. Collect full prompts, tool output, or transcripts only when the feature needs them and the person explicitly turned that collection on. Redact before storing, set a retention period, and cap the stored size. A user-installed mod's telemetry hooks must name the operator's collector (`on('telemetry.log', { to: 'collector' }, hook)`), and first-party analytics rows from `$.telemetry` are sent only for Claude Code and built-in mods. The built-in `privacy` mod refuses a shell call that would send the signed-in account's email address as a client's contact details ([first-party source](https://github.com/anthropics/claude-code/tree/main/mods/privacy)), which models the same principle for outgoing requests.

## Testing

`claude plugin test <folder>` runs every `*.test.ts` and `*.test.tsx` under the folder, each in a child process. Each runs in an environment like the hooks module's (no file system, network, or process access), with no session, sign-in, or network. It exits 1 when a test fails, so it works in CI. Run from a folder that holds no mod, it reports whether mods can load at all (`no hooks module to load` means they can). See the [test page](https://code.claude.com/docs/en/plugins/mods/test).

```typescript
import { expect, test } from 'claude-code/testing';

// A test of the guarded-tool-call template's guard.
test('the guard refuses when its own check fails', async ($, on) => {
  on('fs.exists', () => ({ value: true }));
  on('fs.stat', () => ({ deny: 'refused' })); // makes the mod's $.fs.stat reject
  on('tool.call', () => ({ result: 'edited' }));
  const result = await $.tool.call({
    tool: 'Edit',
    file_path: '/work/a.ts',
    old_string: 'a',
    new_string: 'b',
  });
  expect(result.deny).toContain('check failed');
});
```

How the kit works:

- **The test's `$`**: stands for Claude Code. Each method fires the event of that name through the mod's hooks: `$.tool.call`, `$.command.run`, `$.prompt.submit`, `$.session.start`, `$.session.end`, `$.turn.start`, `$.turn.complete`, `$.classic.<Event>`, and `$.ui.mount`.
- **The test's `on`**: registers stubs beneath the mod, where the rest of the world would be. A stub for a `$` call answers `{ value }` (the call resolves) or `{ deny }` (the call rejects). A stub that throws is skipped. A stub for an event answers that event's result.
- **Built-in answers**: the kit answers `$.ui.invalidate`, `$.state`, and `$.session.append` itself. `mock.clock(on)`, `mock.store(on, entries)`, `mock.env(on, variables)`, and `mock.session(on)` answer the rest from memory. A mod that calls `$.clock` needs `mock.clock`.
- **Ordering**: register every stub before the test's first call on `$`. `session.start` does not run by itself: fire it when the hooks depend on it.
- **Drawings**: `$.ui.mount({ plugin, surface, component, props, requestId? })` draws a site through the mod and validates the tree against that surface's element table. The handle's `press`, `input` (with `kind: 'change'` or the default submit), `select`, `find`, and `unmount` act by key. Loop over surfaces, as in `['terminal', 'desktop', 'vscode'] as const`. A hook that returns `next(e)` needs a `ui.render` stub that answers an element.
- **Questions**: `$.ui.ask` reaches the stubs as a `tool.call` for `AskUserQuestion`. Answer it with `{ result: { answers: { [question]: label } } }`, or `{ deny }` to simulate nobody answering.
- **Options**: `test(name, { options, plugins, timeoutMs }, body)` supplies `userConfig` values, inline mods, and a time limit (5 seconds by default). `tier('prepend')` loads the mod as a policy mod.

Stub shapes must match the build's declarations, or the tests run but the type-check fails. Two shapes the documentation gets wrong for 2.1.321: a `command.register` stub answers `{ value: { command: e.name } }`, and `$.command.run` takes `origin` and `presentation` (observed with `tsc`). A `session.end` stub answers `{ sessionId }`.

Write a test, or a scripted check, for each failure mode the mod could meet:

| Scenario | How to exercise it |
| :-- | :-- |
| Backend unavailable or slow | An `http.fetch` stub answering `{ deny }`; `clock.sleep` inside a stub with `mock.clock` |
| Malformed or unexpected responses | A stub answering a wrong status or a body of the wrong shape |
| Duplicate or out-of-order delivery | Service handler tests that submit the same id twice, or an old sequence number |
| The person stops a turn | Stubs that refuse with `the session was stopped and nobody has sent input since`, then `$.turn.complete` |
| Exhausted budgets or turn limits | Stubs that resolve `{ drop: 'the run reached its --max-turns limit' }` |
| A reload with old values | A `state.get` stub answering a value under an older shape tag |
| `/clear`, `/resume`, `/branch` | `$.classic.SessionStart({ source: 'clear' })`, and `$.session.end` then `$.turn.start` for the case without settings hooks |
| Stale results | A unit test of the poller that stops it while a request is pending |
| A crashed child process | A `process.run` stub that rejects, or a spawn stub whose stream ends early |
| Concurrent claims | Tests against the service, where the transaction lives |
| Other mods at the same site | A `ui.render` stub beneath the mod answering another band, then `find` for both |
| Headless execution | A `ui.open` stub answering `{ isPlaced: false, reason: 'no-surface' }`; `origin: { kind: 'sdk' }` on commands |
| A subagent's working directory | `tool.call` events carrying `agentId`, and paths resolved per call |
| Keyboard interaction | `press`, `input`, and `select` by key on each surface; `autoFocus` and hotkeys in a live session |

The kit exercises hooks and trees, not a surface's paint, the real permission chain, the built-in guard, a real `/clear`, or a real hot reload. Check those in a live session before calling a mod done. A green test run is evidence about the hooks, not about what the person sees.

## Debugging

A broken mod usually looks like a mod that does nothing, because Claude Code skips a failing hook and carries on. Where the reason is written depends on the session:

- **Hot-reloading sessions**: an interactive session with `--plugin-dir`, or one with hot reloading on, shows a dim transcript line
- **Other interactive sessions**: only the debug log, when started with `claude --debug` or `claude --debug-file <path>`
- **`claude -p` with `--plugin-dir`**: stderr in the text output format

Lines worth searching for, all from the [troubleshooting page](https://code.claude.com/docs/en/plugins/mods/troubleshoot) unless marked observed:

| Line | Meaning |
| :-- | :-- |
| `hooks module <name>@inline loaded (worker, environment 1, tier user); events: ...` | The module loaded with these events (observed) |
| `hooks module <name> not loaded: <reason>` | Refused at load; the reason names a setting, `--bare`, a name clash, or a code error |
| `<mod>: <event> hook skipped: threw ...` | A hook failed and was skipped; shown once per event and kind of failure until a reload |
| `<mod> was unloaded: it crashed the hooks worker` | A hook blocked the shared worker, usually with a loop that never awaits |
| `<plugin>: <event> bypassed by <plugin> (tier <tier>); beneath runs` | A mod earlier in the chain went past this hook |
| `<mod> (user) answered ui.render without next()` | A mod drew without keeping the band below it |
| `ui.render (<site>) refused: <reason>` | A tree past a size limit at that site |
| `cc-plugin-sec-default@builtin not seated: ...` | The built-in guard did not load, with the reason (observed) |
| `plugin.register: <name> (user, <name>@inline), judged by core alone: admitted` | No policy mod refused the module (observed) |

Write your own debug lines with `$.ui.log(text, { to: 'debug' })`. Keep CPU-heavy work out of the hooks worker, and wait inside `$` calls rather than on promises of your own: a hook's own time beyond 10 seconds is a timeout, and the hook is skipped.

## What each check proves

| Command | Proves | Does not prove |
| :-- | :-- | :-- |
| `claude plugin validate <folder>` (`--strict`, `--json`, `--profile directory`) | The manifest parses; the build's static analysis can read the module; the events, calls, environment names, state keys, and gating hooks it found | That hooks behave, that trees validate, or that the directory would accept a submission (`--profile directory` checks only part) |
| `tsc --noEmit -p <folder>`, once the types are laid, or a scratch `tsconfig.json` naming the declarations | The code matches this build's declared types | Runtime acceptance; other builds; surface behavior |
| `claude plugin test <folder>` | The hooks' logic against stubs, trees validated per surface, and handler flows | Paint, the real permission chain, the guard, real resets and reloads |
| `claude -p "/command" --plugin-dir <folder> --debug-file <log>` | The module loads in the real engine, `session.start` runs, and a command the mod answers works headlessly with no model turn (observed on 2.1.321) | Drawing, since nothing draws in `-p`, and interactive behavior |
| `claude --debug-file <log> --plugin-dir <folder>` | Real drawing, focus, keys, reloads, and failure lines on that surface | Other surfaces, other builds, or other people's setups |

Never report a check that did not run. Where a tool is unavailable, say which check is unexecuted.

## Distribution

A mod ships as a plugin. [Publishing and marketplaces](publishing-and-marketplaces.md) covers the marketplace file, plugin sources, version schemes, private repositories, Anthropic's directory, and evals for any plugin; this section keeps what a mod adds. Choose the route by audience ([create a mod](https://code.claude.com/docs/en/plugins/mods/create)):

- **A few people**: send the plugin folder or a zip of it
- **A team**: a marketplace repository, optionally registered in a repository's settings so collaborators are offered it
- **An organization**: a marketplace directory placed by device management and enabled in managed settings, which is the only way a mod counts as the organization's
- **Anyone**: a public marketplace repository, or a submission to Anthropic's directory

People install with `/plugin install <plugin>@<marketplace>` in a terminal session, or `claude plugin install <plugin>@<marketplace>` in a shell. For a repository whose marketplace they have not added, the bundled `plugin-authoring` reference gives `/plugin install <plugin> --marketplace <owner>/<repo>`. The `/plugin` command does not run in a Desktop app local session, so install from a terminal or through the app's plugin controls. After installing or updating from a shell, run `/reload-plugins` in an open session. When Claude wrote the mod in a session, the built-in `plugin-authoring` skill has its own sharing steps, including a secret scan of the folder before anything is pushed.

Before publishing:

- **Versioning**: set `version` and bump it on each release. Installed copies are cached by version, so an unchanged version never updates. `claude plugin tag` creates a `<name>--v<version>` tag after checking that `plugin.json` and the marketplace entry agree.
- **The README**: say which Claude Code builds the mod was tested on and the minimum it needs, from the [version gates](sources-and-compatibility.md).
- **Validation**: run `claude plugin validate` on each plugin and on the marketplace root, with `--strict` in CI. Add `--profile directory` before a directory submission, which wants a README of at least 40 words, a license, and an icon.
- **Dependencies**: only hook commands and MCP servers can use packages Claude Code installs, so ship a text `bun.lock` or an npm lockfile for those. Native modules do not compile, because install scripts never run, and workspace or git dependencies are never installed.
