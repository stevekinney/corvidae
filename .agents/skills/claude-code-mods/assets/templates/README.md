# Mod templates

Each directory is a complete, self-contained starting point. Copy one out of the skill before you edit it, then rename the plugin. A copy stays a template until you change its `name`, `description`, and `author` in `.claude-plugin/plugin.json`, and the command, pane, and state names that repeat the plugin name.

| Template | What it shows | Run its tests from |
| :-- | :-- | :-- |
| [`minimal-mod`](minimal-mod/README.md) | The three required files, a command, and an observer that tells a requested tool call from a completed one | `minimal-mod/` |
| [`reactive-pane`](reactive-pane/README.md) | A `$.state` contract, `atom`, `read`, `update`, `derive`, `memberOf`, a pane, a band that keeps other mods' bands, and a preference restored after `/clear` (exercised in the test kit, not in a live session) | `reactive-pane/` |
| [`guarded-tool-call`](guarded-tool-call/README.md) | A fail-closed guard with `.catch`, a confirmation hold whose default is refusal, and a fail-open audit observer | `guarded-tool-call/` |
| [`companion-service`](companion-service/README.md) | A mod that polls a loopback Bun service with backoff, coalescing, stale-result suppression, presence heartbeats, and a deliberate acknowledge action | `companion-service/plugin/` and `companion-service/service/` |

All four were checked on 2026-11-12 with Claude Code 2.1.295, 2.1.309, 2.1.316, and 2.1.321: `claude plugin validate` passed and `claude plugin test` passed on every build, and a type-check against the 2.1.321 declarations passed. Neither command wrote any file into the mod folder. Each README lists its own commands and anything that build range does not cover.

## Type-check a template

The templates ship no `tsconfig.json`, because Claude Code writes one. When an interactive session loads a mod from a watched folder (a `--plugin-dir` folder, or a folder named in `CLAUDE_CODE_PLUGIN_DIRS`), it lays the build's declarations into `.claude-plugin/types/` and, where the mod has no `tsconfig.json` of its own, adds one at the mod root that extends them. After that first load, `tsc --noEmit -p <mod folder>` works with no setup. A copy that has never been loaded interactively, or one loaded only by `claude -p`, has no declarations yet. Check it with a `tsconfig.json` kept outside the mod folder whose `include` names the declaration file (the `plugin-authoring` skill names this build's path when it loads) plus the mod's `hooks`, `types`, and `tests` folders, using the compiler options in that declaration file's header.
