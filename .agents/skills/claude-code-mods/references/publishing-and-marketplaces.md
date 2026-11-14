# Publishing and marketplaces

Publishing a plugin, mod or not, means giving people a source Claude Code can install from and a version scheme that delivers updates. There is no submission form for your own marketplace: committing `.claude-plugin/marketplace.json` publishes it. Facts here are documented in the [publish](https://code.claude.com/docs/en/plugins/publish), [marketplace](https://code.claude.com/docs/en/plugins/create-marketplace), [hosting](https://code.claude.com/docs/en/plugins/host-marketplace), and [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference) pages, fetched 2026-11-13, unless labeled.

## Choose a route

| Audience | Route | Updates |
| :-- | :-- | :-- |
| One person, briefly | Send the folder or a `.zip`. They run `claude --plugin-dir <path>` or `--plugin-url <zip URL>` for a session, or move the folder under `~/.claude/skills/` to load it every session as `<name>@skills-dir`. | None |
| A team or the public | Your own marketplace: a git repository, a hosted `marketplace.json` URL, or a directory on a shared filesystem. A private repository makes a private marketplace that anyone who can clone may install from. | The version scheme below |
| A repository's collaborators | `claude plugin marketplace add <source> --scope project`, then commit the `.claude/settings.json` it writes. Collaborators who trust the folder get the marketplace. | As above |
| An organization | Managed `extraKnownMarketplaces` plus `enabledPlugins`, with `autoUpdate` if wanted. On Team or Enterprise plans, claude.ai's organization settings can also distribute a private or internal repository. | Managed |
| Everyone on claude.ai, Cowork, and Claude Code | A submission to Anthropic's directory | Directory review |

People install from your marketplace with `claude plugin marketplace add <owner/repo|URL|path>` followed by `claude plugin install <name>@<marketplace>`. One step also works: `/plugin install <name> --marketplace <source>` in a session (2.1.275 or later) or `claude plugin install <name> --marketplace <source>` in a shell (2.1.292 or later). Put one of those lines in the README; `claude plugin validate` advises it when the line is missing.

## The marketplace file

`.claude-plugin/marketplace.json` sits at the marketplace root. A layout with several plugins is in [plugin structure](plugin-structure-and-development.md).

- **Required**: `name`, `owner` (an object with `name`, plus optional `email` and `url`), and `plugins`
- **Optional**: `description` (validate warns without it), `version`, `metadata.pluginRoot` (2.1.239 or later), `allowCrossMarketplaceDependenciesOn`, `renames`, `forceRemoveDeletedPlugins`
- **The name**: letters, digits, `.`, `_`, and `-`, starting with a letter or digit. A person cannot register two marketplaces with one name, so pick one other authors will not.
- **Reserved names**: Anthropic's marketplace names, such as `claude-plugins-official` and `claude-community`, are refused unless the source is under `github.com/anthropics/`. So are names that imitate them, any non-ASCII name, `npm`, `pip`, `uv`, `cargo`, `github`, and `gh` in any case, and names starting `claudeai-`.
- **Unknown keys**: they load silently, and `claude plugin validate` warns about them

Each plugin entry needs `name` and `source`, and may carry `description`, `version`, `category`, `tags`, `strict`, `relevance`, `dependencies`, `defaultEnabled`, `displayName`, and any `plugin.json` field. The entry `name` is the install id (`<entry>@<marketplace>`) even when `plugin.json` says otherwise, so keep the two equal, or installing by the manifest name fails with `Plugin "<name>" not found in marketplace "<marketplace>"`.

### Plugin sources

| `source` | Form | Notes |
| :-- | :-- | :-- |
| Relative path | `"./plugins/name"` from the marketplace root | No `..`. Works only where the marketplace's files are present (GitHub, git, file, and directory marketplaces), not for a `url` marketplace. A missing folder passes validate and fails at install. |
| `github` | `{ "source": "github", "repo": "owner/repo", "ref", "sha" }` | `ref` is a branch or tag; `sha` is a full 40-character commit and wins over `ref` |
| `url` | `{ "source": "url", "url": "<any git URL>", "ref", "sha" }` | No `owner/repo` shorthand |
| `git-subdir` | `{ "source": "git-subdir", "url", "path", "ref", "sha" }` | A sparse checkout of one folder |
| `npm` | `{ "source": "npm", "package", "version", "registry" }` | Install scripts never run; git addresses, file paths, and tarballs on git hosts are refused |
| `archive` | `{ "source": "archive", "url": "https://….zip", "sha256" }` | Pin `sha256`; a mismatch fails with `Plugin archive integrity check failed`. Downloads stop at 256 MiB. |
| `command` | `{ "source": "command", "command", "timeout", "mode" }` | 2.1.229 or later. Prints one absolute folder path; people must accept the command, and `disableCommandPluginSources` blocks it. |

`strict` (default `true`) decides how an entry combines with a `plugin.json`. With `strict: true`, the entry's component fields are added to the manifest's, except `hooks`, whose matchers replace the manifest's for each event. With `strict: false`, an entry that declares components beside a `plugin.json` fails with `has conflicting manifests`. Hooks in an entry must be an inline object: a path passes validate and never runs.

## Versions and updates

A copy updates only when its computed version changes. The version is the `plugin.json` `version`, else the entry's `version`, else, for a git source, the commit ([loading](https://code.claude.com/docs/en/plugins/loading)). Pick one scheme:

- **Bump `version` on every release**: an unbumped release reaches no one, and `claude plugin update` reports `<name> is already at the latest version`
- **Omit `version` in both places**: every commit becomes a release. `claude plugin validate --strict` fails on a missing `version`, so drop `--strict` in CI if you choose this.

Never set different versions in `plugin.json` and the entry; `plugin.json` wins and validate warns. People update with `claude plugin update <name>@<marketplace>`, or `/plugin marketplace update <marketplace>` in a session, then `/reload-plugins` or a new session. Auto-update is off for your marketplace by default, and no `marketplace.json` field turns it on: each person enables it under Marketplaces in `/plugin`, or an administrator sets `"autoUpdate": true` on the managed `extraKnownMarketplaces` entry.

For release channels, there is no channel field. Host two marketplaces with different names whose entries point at different `ref`s. To hold people on one version, use `ref` or `sha` on the entry, or `#<ref>` on the add command (`your-org/your-marketplace#stable`).

Tag releases with `claude plugin tag [path] --push`, which creates `<name>--v<version>` after checking that validation passes, the versions agree, and the tree is clean. It matters only when other plugins declare version ranges on yours ([plugins and components](plugins-and-components.md)).

### Renames, removals, and moves

- **Never change a published `name`**: people lose the plugin. Add a top-level `renames` map from the old name to the new one, or to `null` for a removal. Claude Code then rewrites `enabledPlugins` and `pluginConfigs` in user, project, and local settings. Treat `renames` as append-only.
- **Removal**: with `forceRemoveDeletedPlugins: true`, plugins neither listed nor renamed are uninstalled at session start. Otherwise they stay installed and report `not found in marketplace`.
- **No deprecation state**: a marketplace has no deprecated flag, no per-audience entries, and no field for git credentials

## Private repositories

Claude Code runs non-interactive `git` with the person's own credentials; there is no token field. For `owner/repo` it probes SSH first, and `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` skips that. SSH needs a key without a passphrase prompt (an agent) and a `known_hosts` entry. HTTPS needs a stored credential helper, such as `gh auth login` followed by `gh auth setup-git`; `GITHUB_TOKEN` alone does not authenticate. Background auto-update with a helper that must prompt fails quietly and keeps the old checkout. An `archive` source with `headers` or a `headersHelper` serves people who have no git-host account.

## Anthropic's directory and marketplaces

- **The directory**: submit at `claude.ai/directory/manage` with a GitHub repository holding the plugin and a paid claude.ai plan. Pro, Max, and Ultra submit from their own accounts; Team and Enterprise submit through an Owner. Synced plugins load in Claude Code as `<name>@synced`.
- **Directory review**: the portal applies rules the CLI does not check. The pre-submission checklist and per-app component support live on claude.com pages this skill did not fetch (Unverified).
- **Local checks first**: run `claude plugin validate --strict` and, observed on 2.1.316 and 2.1.321, `claude plugin validate --profile directory`, which also exits 1 when the directory would refuse the submission.
- **Directory-only fields**: `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, and `termsOfServiceUrl` belong in `plugin.json`
- **`claude-plugins-official`**: Anthropic's official marketplace (`anthropics/claude-plugins-official`) takes no portal submissions; partners go through an Anthropic contact
- **`claude-community`**: the community marketplace (`anthropics/claude-plugins-community`) holds third-party plugins submitted to Anthropic. How to submit there is not documented in the pages fetched.
- **Third-party marketplaces**: Anthropic does not review them

## Before you publish

- **A permanent name**: pick a kebab-case `name`, and set `displayName` for the label
- **A version scheme**: choose one of the two above
- **Validation**: run `claude plugin validate --strict` on each plugin folder and on the marketplace root (`claude plugin validate .`). A clean run prints `Validation passed`. Validate does not read `.lsp.json` or a root `SKILL.md`, does not fetch remote sources, and does not notice a missing relative-source folder, so install from a local marketplace too: `claude plugin marketplace add ./path`, install, start a session, and confirm it loads.
- **Metadata**: fill `description`, `author`, `homepage` (a valid URL), and `repository`, and write a `README.md` with the install line, the Claude Code builds tested, and the minimum build ([sources and compatibility](sources-and-compatibility.md))
- **Mods**: for a mod, run `claude plugin test` as well ([security, testing, and distribution](security-testing-and-distribution.md))
- **Packages**: hook commands and MCP servers that need Node packages ship `package.json` with a `bun.lock` or npm lockfile ([plugin structure](plugin-structure-and-development.md))
- **Executables**: claude.ai organization sync and Cowork refuse a top-level `bin/`, so plugins meant for them keep executables in a `scripts` folder and call `${CLAUDE_PLUGIN_ROOT}/scripts/<name>`

## Evaluate and measure

`claude plugin eval` (2.1.269 or later) runs cases from `evals/<case>/prompt.md` with graders in `graders/`, once with the plugin and once without, and scores the difference. Grader types are `regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, and `baseline`. A run costs roughly two agent runs per case per repetition, plus judge calls for `llm` and `baseline` graders. It spends real model money, so keep it out of routine tests and cap it with `--max-cost-usd`, which is checked before each run and can be exceeded. In CI, pass `--trust-plugin`, `--json results.json`, `--threshold`, pinned `--model` and `--judge-model`, and `--no-publish`. Exit codes are 0 for a pass, 1 for a failure, and 2 for a partial run ([evals](https://code.claude.com/docs/en/plugin-evals)).

`claude plugin details <name>` shows a loaded plugin's always-on and on-invoke token cost. Claude Code reports no usage to authors: people see their own usage in `/plugin`, and organizations get OpenTelemetry events such as `claude_code.plugin_loaded` and `claude_code.skill_activated`, where non-official plugin names are redacted ([measure](https://code.claude.com/docs/en/plugins/measure)).

## Getting a plugin suggested

- **`relevance` on an entry**: `{ "topic", "signals" }` with `cwd`, `cli`, `hosts`, `filesRead`, or `manifestDeps` signals lets Claude Code suggest an uninstalled plugin when a session matches. Matching is local and never installs anything. A terminal shows suggestions only from marketplaces an administrator lists in managed `pluginSuggestionMarketplaces`. A field over its limit invalidates the whole entry ([relevance](https://code.claude.com/docs/en/plugins/relevance)).
- **The `claude-code-hint` tag**: a CLI can print `<claude-code-hint v="1" type="plugin" value="<name>@claude-plugins-official" />` alone on a stderr line when `CLAUDECODE` or `CLAUDE_CODE_CHILD_SESSION` is set. It works only for plugins in an official marketplace, never `claude-community` or your own ([CLI hints](https://code.claude.com/docs/en/plugins/cli-hints)).

## Failures people hit

| Message | Cause |
| :-- | :-- |
| `Plugin "<name>" not found in marketplace "<marketplace>"` | A stale catalog (`claude plugin marketplace update`), an entry name that differs from the manifest name, or a rename without `renames` |
| `Source path does not exist: <path>` | A relative source folder missing at install |
| `has conflicting manifests` | `strict: false` with components in both the entry and `plugin.json` |
| `Failed to clone marketplace repository:` | SSH or HTTPS credentials, a missing `known_hosts` entry, or the 120-second clone limit (`CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS`) |
| `The name '<name>' is reserved for official Anthropic marketplaces` | A reserved or imitating marketplace name |
| `This plugin uses a source type your Claude Code version does not support` | The person's build is older than the source type; they update Claude Code |
| `is blocked by enterprise policy`, `is not in the allowed marketplace list` | `blockedMarketplaces` or `strictKnownMarketplaces` |

The [plugin troubleshooting page](https://code.claude.com/docs/en/plugins/troubleshooting) has the rest, grouped by stage.
