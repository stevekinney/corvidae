# Sources and compatibility

Mods are early access: the declarations the engine writes say the surface "may change between releases without notice". This file records what this skill was checked against, how to tell a durable fact from a version-specific one, and what to recheck when the build differs.

## Verification snapshot

Everything in this skill was checked on 2026-11-12 against these builds on macOS:

| Build | Where it came from | Used for |
| :-- | :-- | :-- |
| 2.1.321 | The copy of Claude Code bundled with the Desktop app, which ran this session | The target: declarations, `validate`, `plugin test`, headless runs |
| 2.1.316 | The `claude` CLI on `PATH` | `validate` and `plugin test` |
| 2.1.309, 2.1.295 | Earlier CLI versions still installed | `validate` and `plugin test`, to find where behavior changed |

The CLI and the Desktop app can run different versions of Claude Code on one machine, so check the version where the mod will run. Run `claude --version` in a shell. In a local Code tab session of the Desktop app, enter `/status` and read its Claude Code row; the [mods overview](https://code.claude.com/docs/en/plugins/mods) documents both checks.

## Evidence labels

The references label claims that are not obvious from the declarations:

- **Declared**: written in the 2.1.321 declaration file, `claude-code/index.d.ts`. The strongest evidence for that build.
- **Documented**: stated on code.claude.com as fetched on 2026-11-12. The pages describe the CLI and Desktop app "as of v2.1.290" overall, with later version notes up to 2.1.321.
- **Observed**: reproduced on this machine, with the builds named. Scratch probes and template runs, not a published contract.
- **First-party example**: in Anthropic's own mod source or samples. Shows a pattern works; not a guarantee for every build.
- **Recommendation**: this skill's architectural advice. Not a property of Claude Code.
- **Unverified**: plausible but not confirmed. Treat it as a question to check, never as a rule.

## Evidence hierarchy

When sources disagree, rank them in this order:

1. The declarations the target build writes, and behavior you reproduce on that build
2. Official documentation that applies to that build
3. First-party implementations and their tests
4. Issue reports and community mods, with their limitations stated

Record a mismatch instead of silently mixing versions. A runnable example follows the target build's declarations even when a page says otherwise.

## Where the declarations come from

Claude Code writes the declarations itself; there is no command to run:

- **While the built-in `plugin-authoring` skill loads**: the skill's text names a `types/claude-code.d.ts` file written for the running build. The path is inside a per-process temporary directory, so read it from the skill's text each session rather than copying the path anywhere.
- **When an interactive session loads a mod from a watched folder**: the mod's `.claude-plugin/types/` receives `claude-code/index.d.ts` (the API), `claude-code-tools/index.d.ts` (this build's built-in tools on this machine), `claude-code-mcp/index.d.ts` (MCP tools connected at the last save), one directory per plugin the manifest lists under `dependencies`, and a `tsconfig.json`. If the mod has no `tsconfig.json`, one is added at its root that extends the generated one ([create a mod](https://code.claude.com/docs/en/plugins/mods/create)).
- **Not from `validate` or `plugin test`**: observed on all four builds, neither command wrote anything into the mod folder.

The copy on GitHub at `mods/types/claude-code.d.ts` in [anthropics/claude-code](https://github.com/anthropics/claude-code/tree/main/mods) was written by 2.1.277 (13,527 lines at commit `89eb88e3357be13ae7fcf8966144ad32f44def33`, 2026-11-12), while 2.1.321 wrote 23,487 lines. The [mods reference](https://code.claude.com/docs/en/plugins/mods/reference) itself says to trust the copy your build writes. 2.1.321 has no `/plugin-types` command. The GitHub mods README mentions it only as future work, and the 2.1.321 binary contains the string only as a Content Security Policy directive name.

The built-in tool table in `claude-code-tools/index.d.ts` is what the build registers on that machine. The 2.1.321 macOS build here registered `Edit`, `Write`, `NotebookEdit`, `Read`, and `Bash` but not `Glob`, `Grep`, or `MultiEdit`. Compare a tool another build may have through `String(e.tool)`.

## Sources

Official documentation, fetched as Markdown on 2026-11-12 by appending `.md` to each URL:

| Page | What this skill takes from it |
| :-- | :-- |
| [Mods overview](https://code.claude.com/docs/en/plugins/mods) | Where mods run, trust, built-in mods, comparison with hooks, skills, and MCP |
| [Create a mod](https://code.claude.com/docs/en/plugins/mods/create) | Files, the edit and reload loop, generated types, static analysis rules |
| [Use the mods API](https://code.claude.com/docs/en/plugins/mods/api) | Commands, tools, model calls, timers, interruption, messaging, files, processes, network |
| [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference) | Events, methods, render sites, elements, limits, settings, commands |
| [React to events](https://code.claude.com/docs/en/plugins/mods/events) | `next`, matchers, ordering, failure handling, settings-hook events |
| [Draw in the interface](https://code.claude.com/docs/en/plugins/mods/interface) | Panes, the band, placed rows, backdrops, elements, focus, state |
| [Interface gallery](https://code.claude.com/docs/en/plugins/mods/gallery) | Element examples, including `Code` with `source` |
| [Test a mod](https://code.claude.com/docs/en/plugins/mods/test) | The test kit, stubs, mocks, surfaces, policy-mod tests |
| [Troubleshoot a mod](https://code.claude.com/docs/en/plugins/mods/troubleshoot) | Refusal messages, the debug log, worker crashes |
| [Manage mods for your organization](https://code.claude.com/docs/en/plugins/mods/admin) | The built-in guard, managed settings, review, policy mods |
| [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading) | Scopes, in-place and copied plugins, caches, dependency installs |
| [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference) | Manifest fields, reserved names, `userConfig`, path variables |
| [Create a marketplace](https://code.claude.com/docs/en/plugin-marketplaces) | Marketplace files, entry rules, sources |
| [Hooks reference](https://code.claude.com/docs/en/hooks) | Settings hooks, `CLAUDE_PROJECT_DIR`, `CLAUDE_ENV_FILE` |
| [Skills](https://code.claude.com/docs/en/skills) | Skill format, frontmatter, description limits |
| [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) | `listSessions`, `getSessionInfo`, `getSessionMessages` |
| [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | Session discovery and resume guidance |

First-party source, read at these commits:

| Repository | Commit | What it shows |
| :-- | :-- | :-- |
| [anthropics/claude-code `mods/`](https://github.com/anthropics/claude-code/tree/main/mods) | `89eb88e3357be13ae7fcf8966144ad32f44def33` (2026-11-12) | `diff`, `sec-default`, `telemetry`, `agents-md`, `privacy`, with tests |
| [anthropics/claude-code-playground `claude-code/mods/`](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods) | `569c5283d9a0a7ee7938df85bb32e4f48cbb8c86` (2026-10-01) | `token-weather`, `blast-radius`, `replay-theater` samples, unsupported by design |

## Version gates

The earliest version a feature needs, from the documentation unless marked observed. Builds below 2.1.295 were not run here.

| Feature | Needs | Source |
| :-- | :-- | :-- |
| Mods on by default | 2.1.287 in a terminal, 2.1.286 in the Desktop app | Documented |
| `userConfig` field `options` | 2.1.271; earlier builds cannot load the plugin | Documented |
| `ui.fault`, agent statuses `idle` and `waiting` | 2.1.289 | Documented |
| `tool.check` `e.agentId` and `e.ceiling`, `prompt.mention`, `turn.step` `serverToolUses` | 2.1.290 | Documented |
| `$.model.complete` prompt and system blocks with `cache` | 2.1.292 | Documented |
| `isDeferred` on `$.tool.register`, `mock.session` | 2.1.293 | Documented |
| `Button` with children other than one string | 2.1.295 | Documented |
| VS Code drawing, spacing step names, `Text` `size`, `weight`, `mono`, `tabular`, a default `types` path, `agent.spawn` for resumes, `skill.prompt` source fields | 2.1.299 | Documented |
| `$.ui.view` | 2.1.300 | Documented |
| `tool.check` `e.isReadOnly`, `$.settings.read({ key })`, `settings.read` on the engine's own read, refusals after a Stop | 2.1.304 | Documented |
| Validation following `$` into an imported helper | No later than 2.1.309 | Observed: refused on 2.1.295, accepted on 2.1.309, 2.1.316, 2.1.321; 2.1.296 to 2.1.308 not checked |
| `$.ui.place` | 2.1.314 | Documented |
| `$.theme.set` and `$.theme.clear` (and `$.ui.backdrop` removed) | 2.1.319 | Documented |
| `breakPromptCache` | 2.1.321 | Documented |

## Known mismatches

| Topic | Older source says | 2.1.321 or observation | What to do |
| :-- | :-- | :-- | :-- |
| `$` passed to an imported helper | [Create a mod](https://code.claude.com/docs/en/plugins/mods/create) says validation fails | First observed accepted on 2.1.309, listed as `$.ui.status (via show)`; refused on 2.1.295 | Prefer a closure adapter, accepted on every build checked |
| `command.register` stub in tests | The [test page](https://code.claude.com/docs/en/plugins/mods/test) stub table answers `{ value: undefined }` | Runs, but fails `tsc`: the declared value is `{ command }` | Answer `{ value: { command: e.name } }` |
| `$.command.run` in tests | Doc examples pass `{ command, args }` | Runs, but the declared input also requires `origin` and `presentation` | Pass both, as the templates do |
| A collapsed band | The [interface page](https://code.claude.com/docs/en/plugins/mods/interface) says a mod cannot tell | `AbovePrompt` props declare `isCollapsed` | Read it where the build declares it; never make the band the only place for something the person must answer |
| `$.session` methods | The reference table omits two | 2.1.321 declares `identity` (only for organization-installed mods) and `surface` (deprecated for `surfaces`) | Use `surfaces()` |
| Declaration size | The bundled skill says about 14,000 lines | 23,487 lines | Search the file by name rather than reading it whole |
| Sample `token-weather` | Reads `e.hasSurvey` and `e.bodyColumns` | Both are under `e.props` | Copy patterns from samples, never field names |
| `pluginConfigs` sources | The reference lists user and managed settings | A `--settings` value reached an `@inline` mod in `claude -p` (observed, 2.1.321) | Use it for headless tests; do not depend on it for users |
| `CLAUDE_CODE_PLUGIN_DIR_WATCH` | The reference table says environment | The bundled reference says it is set the same way as `CLAUDE_CODE_PLUGIN_DIRS`, which also reads `env` in `~/.claude/settings.json` | Set it in the environment, and confirm in the debug log |
| `Link` on remote surfaces | The interface page allows `http://localhost` in the Desktop app and VS Code | `LinkProps` says a remote surface draws anything but `https:` as plain text | Use `https:` links, or test the surface |
| Built-in mods | The overview table lists six | 2.1.321 also loaded `cc-plugin-easel` and `cc-plugin-privacy` (observed in the debug log) | Expect built-ins beyond the documented list in the chain |

## Recheck before generating code for another build

Repeat these when the target build differs from 2.1.321. They take minutes, not a research project:

- **Version**: `claude --version`, and `/status` in the Desktop app
- **Declarations**: search the build's `claude-code/index.d.ts` for each event, method, and element the code uses, such as `'tool.call'`, `Pane: {`, or `export type ToolCallResult`
- **Validation**: `claude plugin validate <mod folder>` on that build. Its `hooks:`, `calls:`, `gating hook`, `env reads:`, and `state reads:` lines are the build's own reading of the code.
- **Tests**: `claude plugin test <mod folder>` on that build
- **Documentation**: the page's version notes for anything newer than the build

## Minimum versions and degraded behavior

Set a mod's minimum version from the features it actually uses, using the gates above, and say in its README which builds it was tested on. A build that is too old usually refuses the module at load, so the README is the person's warning. Inside the mod, degrade by result rather than by version string. These are the answers to check:

- `$.ui.open` resolves `{ isPlaced: false, reason }`; answer with text or a toast instead
- `$.theme.set` resolves `isDrawn`
- `$.ui.notify` resolves `isSent`
- `$.ui.place` resolves `isPlaced`
- `e.surface`, or `$.session.surfaces()`, says which element table applies

For a version-specific branch, `$.session.version()` answers `{ version, base, builtAt }`. Compare `base` against the release that introduced the feature, and when the build is older, log the reason with `$.ui.log(text, { to: 'debug' })` and skip the feature.
