# Plugins and their components

A plugin is a directory of components that Claude Code installs, enables, updates, and namespaces as one unit. A mod is one of those components: the hooks module named by `modules`. This file covers everything else a plugin can carry, how each part is configured, and how plugins are installed, loaded, and controlled. Unless marked otherwise, every statement is documented in the [plugins section](https://code.claude.com/docs/en/plugins/overview) as fetched on 2026-11-13. Hooks have their own reference, [plugin hooks and mod hooks](plugin-hooks-and-mod-hooks.md), and publishing has [publishing and marketplaces](publishing-and-marketplaces.md).

## When a plugin is the right package

Skills, subagents, settings hooks, and MCP servers all work without a plugin: a skill in `~/.claude/skills/` already applies to every project. Package them as a plugin when several of them should install and update together, when someone else should get the whole setup with one command, or when you publish versioned releases ([overview](https://code.claude.com/docs/en/plugins/overview)).

An enabled plugin is part of every session. The name and description of each skill, agent, and command the model can invoke sit in the context every turn, its MCP servers run beside each session, its hooks fire on their events, and everything runs as the person. `claude plugin details <name>` prints that always-on token cost for a loaded plugin ([measure](https://code.claude.com/docs/en/plugins/measure)).

## The components

Only `name` in `.claude-plugin/plugin.json` is required, and the manifest itself is optional: without one, Claude Code finds components in the standard layout and takes the name from the marketplace entry or the folder. Keep every file except the manifests at the plugin root, never inside `.claude-plugin/` ([manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference)).

| Component | Default location | Manifest key and how it combines | What it is |
| :-- | :-- | :-- | :-- |
| Skills | `skills/<name>/SKILL.md` | `skills` adds directories to the default scan | Instructions invoked as `/<plugin>:<skill>` or by the model. A root `SKILL.md` with no `skills/` loads as one skill. |
| Commands | `commands/*.md` | `commands` replaces the default; a map form takes `source` or inline `content` | The older form of a skill; the docs prefer skills for new work. `commands/db/migrate.md` becomes `/<plugin>:db:migrate`. |
| Agents | `agents/*.md`, subfolders included in the name | `agents` replaces the default and takes `.md` files only | Subagent types such as `<plugin>:security-reviewer`. Plugin agents ignore `permissionMode`, `hooks`, `mcpServers`, and `initialPrompt` in their frontmatter. |
| Settings hooks | `hooks/hooks.json` under a top-level `hooks` key | `hooks` merges with the file; inline objects have no wrapper | Commands, HTTP requests, MCP tool calls, prompts, or subagents run on events, outside Claude Code |
| Mod | `hooks/hooks.json` `modules` | No manifest key; `types` names the state contract | One hooks module running inside Claude Code against `$` |
| MCP servers | `.mcp.json` | `mcpServers` merges; also takes `.mcpb` or `.dxt` bundles and `https://` URLs | Shown as `plugin:<plugin>:<server>`; tools are `mcp__plugin_<plugin>_<server>__<tool>` |
| LSP servers | `.lsp.json`, a map with no wrapper | `lspServers` merges | Language servers for code intelligence. `command` and `extensionToLanguage` are required; the binary must already be on `PATH`. |
| Output styles | `output-styles/<name>.md` | `outputStyles` replaces the default | Listed in `/output-style` as `<plugin>:<name>` |
| Themes | `themes/<slug>.json` | `experimental.themes` replaces the default | Read-only custom themes |
| Monitors | `monitors/monitors.json` | `experimental.monitors` replaces the default | Background shell commands with `name`, `command`, `description`, and `when` (`always` or `on-skill-invoke:<skill>`) |
| Channels | None | `channels`, each naming one of the plugin's MCP servers | Messages pushed into a running session, started with `claude --channels plugin:<name>@<marketplace>` (research preview) |
| Workflows | `workflows/*.js` | `workflows` replaces the default | Scripts for dynamic workflows |
| Executables | `bin/` | None | Added to the Bash tool's `PATH` while enabled, after the person's own entries. claude.ai and Cowork refuse a plugin with a top-level `bin/`. |

These details trip people up:

- **Replaced defaults**: when a manifest names `commands`, `agents`, `outputStyles`, `workflows`, `experimental.themes`, or `experimental.monitors`, the default folder is no longer read. `claude plugin list` and `/plugin` note `Default <folder>/ folder is ignored because the manifest sets "<key>"`, and `claude plugin validate` says nothing (both observed on 2.1.321). Point the key at paths inside the default folder, or list that folder explicitly, to keep it.
- **Paths**: every component path is relative and starts with `./`, must exist, and must resolve inside the plugin root. `..`, a symbolic link that leads out of the plugin, and a backslash on macOS or Linux are rejected.
- **Unknown fields**: an unknown top-level manifest key is stripped with a warning. An unknown key inside a `userConfig` option, a `channels` entry, an `lspServers` configuration, or a `monitors` entry is an error, and the plugin does not load.
- **Strict component files**: one invalid entry in `.lsp.json` skips the whole file, and `claude plugin validate` reads neither `.lsp.json` nor a root `SKILL.md`, so a clean validate does not cover them.
- **Monitors run unguarded**: a monitor command runs in a shell with the person's full permissions, outside the sandbox. Monitors never start under `claude -p`, do not load from project-scope plugins, keep running when the plugin is disabled mid-session, and get no `userConfig` values. An updated monitor needs a new session.
- **Agents carry no hooks**: a plugin cannot give one of its agents its own hooks or MCP servers. Put hooks at plugin level.
- **A root `CLAUDE.md` is not loaded**: `claude plugin validate` warns about it. Put standing instructions in a skill.

## Manifest fields beyond components

| Field | Notes |
| :-- | :-- |
| `name` | No spaces, `@`, `:`, or path separators; kebab-case advised. Reserved names fail `claude plugin validate`: prefixes `claude-`, `anthropic-`, `anthropics-`, `cc-plugin-`, and the exact names `claude`, `anthropic`, `anthropics`, `claude-code`, `claude-mods`. Claude Code still loads such a plugin, but `plugin init` and `plugin tag` refuse it. |
| `version` | Not checked as semver. When set, people stay on the cached copy until the string changes. A manifest version beats a marketplace entry's. |
| `description`, `author`, `homepage`, `repository`, `license`, `keywords` | `homepage` must parse as a URL, or the plugin fails to load |
| `displayName` | A label for the interface only; a marketplace entry's value wins |
| `defaultEnabled` | Default `true`. It applies only where the person has no `enabledPlugins` entry, and once they choose, a later change to it never reaches them. |
| `dependencies` | `"name"`, `"name@marketplace"`, or `{ name, marketplace, version }` with a semver range |
| `userConfig`, `channels`, `types` | Below, the channel table above, and [state](state-configuration-and-environment.md) |
| `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl` | Read only by Anthropic's directory, never at load |
| `experimental` | `themes`, `monitors`, and `evals` (the eval directory when it is not `evals/`) |

## Values the person configures

`userConfig` declares the values a person sets: each key maps to an option with a required `type` (`string`, `number`, `boolean`, `directory`, or `file`), `title`, and `description`, plus optional `required`, `default`, `options` (a fixed list, 2.1.271 or later; declaring it stops the plugin loading on older builds), `multiple`, `sensitive`, `min`, and `max`. Non-sensitive values are stored under `pluginConfigs` in the person's user settings; sensitive ones go to the platform's credential store.

How a value reaches each component:

| Component | How it gets values |
| :-- | :-- |
| MCP and LSP configuration, exec-form hook `args`, skill and agent text | `${user_config.KEY}` is substituted. In skill and agent text a sensitive value becomes a placeholder. |
| Every settings hook process | `CLAUDE_PLUGIN_OPTION_<KEY>` (uppercased) in the environment |
| A mod | `options` in `register(on, options)` ([state](state-configuration-and-environment.md)) |
| Shell-form hook commands, monitor commands, MCP `headersHelper` | `${user_config.*}` is an error there. Monitors get no option values at all. |

The configuration dialog opens on install from `/plugin`, and `/plugin configure <plugin>@<marketplace>` reopens it. `claude plugin install` never prompts: pass `--config KEY=VALUE`, or run `claude plugin configure <plugin>@<marketplace> --values-stdin` afterwards.

## Paths and variables

| Variable | Value | Where it resolves |
| :-- | :-- | :-- |
| `${CLAUDE_PLUGIN_ROOT}` | The installed copy's folder, which changes on every update. Never write state there. | Hook `command` and `args`, monitor `command`, MCP and LSP configuration, skill, command, and agent text; exported to hook, stdio MCP, and LSP processes |
| `${CLAUDE_PLUGIN_DATA}` | `~/.claude/plugins/data/<id>/`, with `<id>` the plugin id with every character other than letters, digits, `_`, and `-` replaced by `-`. It survives updates and is deleted on the last uninstall unless `--keep-data` is passed. | Same as above |
| `${CLAUDE_PROJECT_DIR}` | The project root | Same as above |

None of these exist in commands run through the Bash tool. Quote substituted paths in shell-form hooks (`"${CLAUDE_PLUGIN_ROOT}/scripts/check.sh"`), or use exec form (`args`), which needs no quoting.

## Installing, enabling, and loading

Installing puts a copy on disk; enabling decides whether it loads. Both have scopes:

- **Scopes**: `user` (`~/.claude/settings.json`), `project` (`.claude/settings.json`, committed), `local` (`.claude/settings.local.json`), and `managed`. A committed project entry still needs each collaborator to install the plugin (`claude plugin install <name>@<marketplace> --scope project`). The precedence of `enabledPlugins` sources is in [plugin structure](plugin-structure-and-development.md).
- **Identifiers**: `<name>@<marketplace>` for installed plugins, `@inline` for `--plugin-dir`, `--plugin-url`, `CLAUDE_CODE_PLUGIN_DIRS`, and SDK `plugins`, `@skills-dir` for a plugin folder under `~/.claude/skills/` or the project's `.claude/skills/`, and `@synced` for plugins from a claude.ai account.
- **Copies and in-place loading**: marketplace plugins from GitHub, git, a URL, an archive, or npm run from `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, so a file outside the plugin folder (`../shared`) is absent there. `--plugin-dir` folders, skills-directory plugins, and relative-path plugins of a marketplace added from a local folder load in place.
- **Project plugins wait for trust**: project-scope plugins load only after the workspace trust check, each of their MCP servers needs approval, and their monitors never load.
- **Updates in a running session**: a session keeps the old version until `/reload-plugins`, which reloads hooks, MCP and LSP servers, and mods. It can refuse a change that adds or removes an MCP server until rerun with `--force`, to protect the prompt cache. Monitors need a new session.
- **Auto-update**: on by default for Anthropic's official marketplaces and off for others. It runs after the first message, at a random delay of up to ten minutes.
- **Node packages**: copied plugins with a `package.json` and a `bun.lock` or npm lockfile get registry packages installed for their hook commands and MCP servers, with no lifecycle scripts and a 60-second limit. A hooks module cannot import them ([plugin structure](plugin-structure-and-development.md)).

## Dependencies between plugins

`dependencies` entries take a semver range such as `^2.0` or `~2.1.0`. A range resolves to the highest git tag named `<plugin>--v<version>` in the repository that hosts the dependency, which `claude plugin tag` creates. Pre-releases count only when the range opts in (`^2.0.0-0`). Installing a plugin installs and enables its dependencies at the same scope; disabling one that another enabled plugin needs is refused; uninstalling leaves the dependencies until `claude plugin prune`. A dependency from another marketplace must be allowed by the root marketplace's `allowCrossMarketplaceDependenciesOn`. Test both locally with `claude --plugin-dir ./dependency --plugin-dir ./plugin` ([dependencies](https://code.claude.com/docs/en/plugins/dependencies)).

## What a plugin can do on the machine

An installed plugin runs arbitrary code with the person's privileges ([security](https://code.claude.com/docs/en/plugins/security)):

- **Outside every rule**: settings hooks, monitors, stdio MCP servers, LSP servers, and mods run outside the sandbox and outside permission rules
- **Inside the rules**: Claude's calls to a plugin's MCP tools, and Bash commands that run its `bin/` executables, are ordinary tool calls that permission rules govern
- **Instructions only**: skills, commands, and agents are text the model reads; they change behavior without running code
- **Drift after review**: installing also enables a plugin unless `defaultEnabled` is `false`, and auto-update can change files after someone reviewed them

Review a plugin before installing it: read its `hooks/hooks.json`, `.mcp.json`, `bin/`, and any hooks module, then run `claude --plugin-dir <folder> plugin details <name>`.

## Organization controls

Managed settings decide what loads ([organization](https://code.claude.com/docs/en/plugins/org)):

| Key | Effect |
| :-- | :-- |
| `extraKnownMarketplaces` with `enabledPlugins` | Registers marketplaces and force-enables (`true`) or blocks (`false`) plugins |
| `strictKnownMarketplaces` | An allowlist of marketplace sources; `[]` blocks every marketplace, the official one included, but not `--plugin-dir` |
| `blockedMarketplaces` | A blocklist, checked first |
| `disableSideloadFlags` | Rejects `--plugin-dir`, `--plugin-url`, `--agents`, SDK `plugins`, and `CLAUDE_CODE_PLUGIN_DIRS` |
| `allowManagedHooksOnly` | Blocks hooks and installed mods that are not the organization's ([plugin hooks and mod hooks](plugin-hooks-and-mod-hooks.md)) |
| `strictPluginOnlyCustomization` | Allows skills, agents, hooks, or MCP servers only from plugins (`true` or a list of those four) |
| `disableCommandPluginSources` | Refuses plugins whose source is a command; defaults to the value of `allowManagedHooksOnly` |
| `syncClaudeAiPlugins` | `false` stops plugins synced from claude.ai |
| `pluginSuggestionMarketplaces` | Marketplaces whose `relevance` suggestions may show ([publishing](publishing-and-marketplaces.md)) |
| `channelsEnabled`, `allowedChannelPlugins` | Turn channels on and choose which plugins may push |

Mods have their own controls, such as `allowManagedModsOnly` on the built-in guard; [runtime and API](runtime-and-api.md) and the [mods admin page](https://code.claude.com/docs/en/plugins/mods/admin) cover them.

## Commands

`claude plugin` (alias `claude plugins`) subcommands: `init`, `install`, `uninstall`, `enable`, `disable`, `update`, `list`, `details`, `configure`, `prune`, `tag`, `test`, `validate`, `eval`, and `marketplace add|list|update|remove`. Inside a session, `/plugin` covers most of them, but not `init`, `update`, `details`, `prune`, `eval`, or `test`, and it is unavailable in `claude -p` and in local Desktop sessions. `--plugin-dir <folder or .zip>` and `--plugin-url <zip URL>` load a plugin for one session ([commands reference](https://code.claude.com/docs/en/plugins/cli-reference)).

Observed on 2.1.316 and 2.1.321 on 2026-11-13: both builds list every documented subcommand with identical flag help. Both also accept `install --registry <url>` and `validate --profile directory`, and 2.1.321 adds `restore-set-aside`, none of which the fetched docs mention.
