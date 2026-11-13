# Plugin structure and development

A mod is a plugin whose `hooks/hooks.json` names a hooks module. Everything else about plugins applies to it unchanged: the manifest, marketplaces, scopes, and caching. This file covers the files, how plugins are enabled and installed, and the edit and reload loop on each surface.

## The files

| File | Required | Role |
| :-- | :-- | :-- |
| `.claude-plugin/plugin.json` | Yes | The manifest. `name` is the only required field. Mods add no required fields. |
| `hooks/hooks.json` | Yes, for a mod | `modules`: one path to the hooks module, relative to `hooks.json`. The same file can hold settings hooks under a `hooks` key, and a `description`. |
| The hooks module, such as `hooks/register.ts` | Yes | Exports `register(on, options)`. Named `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, or `.cts`, and an ES module whatever its suffix. |
| `types/index.d.ts` | When the mod uses `$.state` or adds a noun to `$` | The contract: `PluginState` values, and any noun the mod adds. Named by `types` in the manifest; from 2.1.299 that path is the default. |
| `*.test.ts`, `*.test.tsx` | No | Tests that `claude plugin test` runs, anywhere under the plugin folder |
| `skills/`, `agents/`, `commands/`, `.mcp.json` | No | The other plugin components. A mod can ship beside a skill, agent types, and MCP servers in one plugin. |

`hooks.json` names exactly one module. A second entry is refused with `hooks.json \`modules\` names one hooks module per plugin; a second entry is refused`(observed on 2.1.295, 2.1.309, 2.1.316, and 2.1.321). A`hooks.json`with no`modules`key validates cleanly but lists no`hooks:`line, because the plugin then has no mod at all ([troubleshooting](https://code.claude.com/docs/en/plugins/mods/troubleshoot)). Split code across files with relative`import` declarations from the one module.

Settings hooks and a mod can share `hooks/hooks.json`, and they are different things. The `hooks` key holds command, HTTP, prompt, and agent hooks in the same shape as `settings.json`. They run as processes, and they receive `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, and `CLAUDE_PLUGIN_OPTION_<KEY>` ([manifest reference](https://code.claude.com/docs/en/plugins-reference)). The `modules` key names code that runs inside Claude Code and reaches all of that through `$` instead.

## Manifest fields a mod uses

| Field | Notes |
| :-- | :-- |
| `name` | Kebab-case, the namespace for every component. `claude plugin validate` errors on a name that starts with `claude-`, `anthropic-`, `anthropics-`, or `cc-plugin-`, on `claude`, `anthropic`, `anthropics`, `claude-code`, or `claude-mods`, and on `official` beside `claude` or `anthropic`. It warns on `claude` as a whole word elsewhere (documented, and the error observed). |
| `version` | Pins installed users to that version until it changes. A folder marketplace's relative-path plugin and a `--plugin-dir` plugin are not pinned by it. |
| `types` | Path of the state and noun contract |
| `userConfig` | Values the person sets. Each field becomes an `options` value in `register(on, options)`, defaults filled in, validated before the module loads. A required field with no value fails the load. |
| `dependencies` | Other plugins this one needs. A mod runs before the mods it depends on, and their noun contracts are laid into `.claude-plugin/types/<plugin>/`. |
| `defaultEnabled` | Whether it starts enabled where the person has not chosen |

`userConfig` fields take `type` (`string`, `number`, `boolean`, `directory`, or `file`), `title`, `description`, and optionally `required`, `default`, `options` (a picker, 2.1.271 or later), `multiple`, `sensitive`, `min`, and `max`. Non-sensitive values are stored under `pluginConfigs` in the person's settings, keyed by the plugin id, or by `<name>@inline` for a `--plugin-dir` plugin. Sensitive values go to the platform's secure storage, and they are left out of the `/config` rows. A change in `/config` reloads the module with the new `options`. In a test, `test(name, { options }, body)` supplies the values.

## One repository, several plugins

A marketplace is a directory with `.claude-plugin/marketplace.json` listing plugin entries. One repository can hold several independently installable plugins this way:

```text
mods-repository/
├── .claude-plugin/
│   └── marketplace.json
└── plugins/
    ├── agent-roster/
    │   ├── .claude-plugin/plugin.json
    │   └── hooks/
    └── protected-paths/
        ├── .claude-plugin/plugin.json
        └── hooks/
```

```json
{
  "name": "team-mods",
  "owner": { "name": "Platform team" },
  "plugins": [
    { "name": "agent-roster", "source": "./plugins/agent-roster", "description": "Agents pane" },
    {
      "name": "protected-paths",
      "source": "./plugins/protected-paths",
      "description": "Edit guard"
    }
  ]
}
```

These rules come from the [marketplace page](https://code.claude.com/docs/en/plugin-marketplaces):

- **Paths from the marketplace root**: write each relative `source` from the directory that contains `.claude-plugin/`. A path with `..` is invalid, and a path to a missing directory passes validation and fails at install.
- **Same name twice**: keep each entry's `name` equal to the plugin's manifest `name`. The entry name is the install id (`<entry>@<marketplace>`) and the `enabledPlugins` key.
- **Validate both levels**: `claude plugin validate` on the repository root checks the marketplace file. Run it on each plugin folder too.

Several plugins and several features in one plugin are different choices. One plugin has one hooks module, one `$.store`, one state namespace, and one switch in `/plugin`. Put features in one plugin when they share state or ship and enable together. Split them when people should enable, update, or trust them separately, or when one is a policy mod your organization installs and the other is not (Recommendation).

## Where a plugin is enabled and where its files live

Enabling and installing are separate. `enabledPlugins` can come from six sources, merged key by key, highest precedence last ([loading reference](https://code.claude.com/docs/en/plugins/loading)):

| Source | Where | Reaches |
| :-- | :-- | :-- |
| `--add-dir` | Settings files in a directory added with `--add-dir` | This session; only `true` counts |
| `user` | `~/.claude/settings.json` | The person, in every project |
| `project` | `.claude/settings.json` | Everyone who clones the repository |
| `local` | `.claude/settings.local.json` | The person, in this repository |
| `flag` | `--settings` | This session |
| `managed` | Managed settings | Everyone the policy covers; `true` forces and `false` blocks |

Committing a project setting does not run anything on a teammate's machine by itself. A plugin enabled only in `.claude/settings.json` does not load until that person installs it (`claude plugin install <name>@<marketplace> --scope project`), and project-scope plugin content loads only after the workspace trust check. A repository can also share a plugin by placing it at `.claude/skills/<name>/` with its own `.claude-plugin/plugin.json`. Claude Code loads it as `<name>@skills-dir`, from the session's primary working directory only, after trust. It does not search parent directories for plugins, and it reads only a manifest directly inside each skill folder.

On disk, installed plugins live under `~/.claude/plugins` (or `CLAUDE_CODE_PLUGIN_CACHE_DIR`):

- **Copied plugins**: every marketplace plugin from GitHub, git, a URL, an archive, or npm is copied to `cache/<marketplace>/<plugin>/<version>/` and runs from that copy, so editing a working copy changes nothing until a new version is installed. A previous version is removed 14 days after it is orphaned.
- **In-place plugins**: `--plugin-dir` folders, skills-directory plugins, and relative-path plugins in a marketplace added from a local folder load from where they are. Edit the folder, then run `/reload-plugins`.
- **Data**: `${CLAUDE_PLUGIN_DATA}` (`data/<plugin-id>/`) survives updates and holds installed dependencies or caches for hook commands and MCP servers. `$.store` lives elsewhere, in a JSON file under `store/`.

A component path that resolves outside the plugin folder is rejected, whether through `..` or a symbolic link that leads out. The exception is links between plugins of one marketplace.

## The development loop

Work against a folder you own and load it with `--plugin-dir`. Never edit an installed cache copy.

```bash
claude --plugin-dir ./agent-roster
claude --plugin-dir ./agent-roster --plugin-dir ./protected-paths
claude --debug-file ./mod-debug.log --plugin-dir ./agent-roster
```

These reload rules come from the bundled `plugin-authoring` reference and the [create page](https://code.claude.com/docs/en/plugins/mods/create):

- **What is watched**: an interactive session watches every `--plugin-dir` folder, every folder named in `CLAUDE_CODE_PLUGIN_DIRS`, and skills-directory plugins. Saving a file the module loaded reloads the module. A save that leaves the text the same reloads nothing, and after a failed reload any new save tries again.
- **When a reload happens**: saves made during the session's own turn (Claude editing the mod) reload once when the turn ends. If a tool or command the plugin registered is about to run, they reload sooner. Saves from anywhere else reload once the folder has been quiet, about a quarter second for a single save.
- **What a reload recreates**: `register` runs again in a fresh environment, so module variables start over and `session.start` runs again. Timers are dropped, and a `$.process.spawn` child the old copy held is ended with it. `$.state` and `$.store` are kept, so new code meets old values; tag values with a `Shaped` contract. A call still running in the old copy may be refused with `the hooks module that made the call is no longer loaded`.
- **A failed reload**: the transcript says `reload failed, the previous version stays loaded:` with the reason. Where the line ends `the version loaded before is unloaded`, fix the error and run `/reload-plugins`.
- **Headless runs**: a `--plugin-dir` folder in `claude -p` loads fresh and is not watched. `claude -p "/your-command" --plugin-dir ./your-mod` runs a command the mod answers itself. On 2.1.321 that completed with zero model turns and zero cost (observed), which makes it a cheap check that the module loads in the real engine.

When Claude writes a mod through the built-in `plugin-authoring` skill, it writes into a session folder under `~/.claude/dev-mods/` followed by the session id. Writing the first file there asks the person whether to turn hot reloading on for the session. In `auto` and `bypassPermissions` modes nobody is asked and the mod loads at the end of the turn. That folder is temporary: Claude Code deletes it once it is older than `cleanupPeriodDays`, so copy a mod out of it to keep it. This skill's templates are meant to be copied to a folder of the person's choosing instead.

### Desktop app sessions

A Code tab session in the Desktop app runs Claude Code's engine without a terminal of its own and draws on the `desktop` surface. It takes no command-line flags, so:

- **Loading**: name the folders in `CLAUDE_CODE_PLUGIN_DIRS`: absolute paths separated by `:` (`;` on Windows), with `~` allowed, set in the process environment or in the `env` block of `~/.claude/settings.json`. A project's settings are never read for it (documented in the mods reference and the bundled reference).
- **Reloading**: the bundled reference says a long-lived headless session such as the Desktop app's watches those folders only when `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` is set as well. That combination was not exercised in this session (Unverified).
- **Version**: the Desktop app bundles its own copy of Claude Code, and on this machine it was 2.1.321 while the CLI was 2.1.316 (observed).
- **Installing**: `/plugin` does not run in a local Desktop session. Install from a terminal at user scope, which then loads in the Desktop session too, or use the app's own plugin controls (bundled reference).

Remote and cloud sessions differ again. Remote Control runs the hooks in the session on the person's machine. A cloud session runs the hooks of a plugin that reaches the cloud environment, draws nothing, and there `localhost` is the cloud machine, not the laptop ([mods overview](https://code.claude.com/docs/en/plugins/mods)).

## Dependencies, imports, and bundling

A hooks module imports only its own files by relative path, plus the bare `claude-code` module. Any other bare specifier is refused: `cannot import "lodash" (from hooks/register.ts): a hooks module imports its own files by relative path and "claude-code", nothing else` (observed on all four builds). A dynamic `import()` is refused too, and a module that uses `require` does not load, because every file is an ES module.

Claude Code does install Node.js packages for copied plugins, under these conditions ([loading reference](https://code.claude.com/docs/en/plugins/loading)):

- **The trigger**: the plugin root has both a `package.json` and a supported lockfile, either `bun.lock`, or `npm-shrinkwrap.json`/`package-lock.json` (lockfile version 2 or 3)
- **The constraints**: registry packages pinned exactly, frozen resolution, no lifecycle scripts (`--ignore-scripts`), no overrides or patches, a separate install folder, and a 60-second timeout
- **No install**: for git, folder, workspace, or linked dependencies, which rules out a monorepo's `workspace:*` packages; for `yarn.lock`, `pnpm-lock.yaml`, or `bun.lockb`; and for plugins loaded in place

Those packages serve the plugin's hook commands and MCP servers. They do not become imports a hooks module can use. A file you vendor into the plugin is just another relative module: it must pass the same static analysis (no `import()`, no `require`, no bare imports of its own) and run without Node.js or DOM globals. Treat bundling a library that way as an experiment to validate and test, not a supported workflow (Recommendation). A dependency a companion process needs belongs to that process's own `package.json`.

## Names and limits

- **Component names**: command, tool, subagent type, and pane names, and the `id` of a placed row or a backdrop, are letters, digits, `_`, and `-`, up to 64 characters
- **Visible names**: a registered tool is listed as `mcp__<plugin>__<name>`, and an agent type as `<plugin>:<name>`
- **A taken command name**: `$.command.register` throws, as in `"/focus" refused: it is the built-in /focus`, which fails the rest of a `session.start` hook unless the call is wrapped
- **Two plugins with one name**: when two enabled plugins share a name, one holds it and the other's hooks module does not load (`another plugin of that name loads first`). A `--plugin-dir` plugin replaces a same-named installed or skills-directory plugin for that session.
