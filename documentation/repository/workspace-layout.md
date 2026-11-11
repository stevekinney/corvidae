# Workspace layout

The full rules behind AGENTS.md "Workspace and dependencies", "Release intent" and "Worktrees and agents", which state them in short. `scripts/workspace-contract.integration.test.ts` enforces the workspace list and the `testing/*` and plugin rules.

## Workspaces

- `applications/*` contains deployable applications; `components/*` contains browser component libraries; `packages/*` contains other shared libraries; `testing/*` contains verification tooling (the shared test helpers and the agent evaluator), which libraries and components may name only in `devDependencies`, never in `dependencies` or `peerDependencies` (applications, which nothing depends on, are exempt); `internal/*` contains repository configuration; `plugins/*` contains Interborough plugins, trusted in-process code authored with `@lostgradient/interborough-plugin`, whose `dependencies` may name only that package, `armorer`, Operative, Weft, Storage, Lifecycle, Memory, `zod`, and external packages (Bureau and `testing/*` only in `devDependencies`, and no application or other plugin anywhere; `scripts/plugin-dependency-rules.ts` states the rule); `scripts/browser-fixtures` is a private workspace that only declares the workspaces the root browser fixtures import. Every workspace is named `@lostgradient/*`, except `armorer` and `conversationalist`, which carry their unscoped npm names. Repository scripts read these directories from `scripts/workspace-directories.ts`; `scripts/workspace-contract.integration.test.ts` keeps that list equal to the root `workspaces` field and enforces the `testing/*` and plugin rules.
- Component source uses the shared browser TypeScript configuration and root browser lint policy. Keep Bun and Node APIs in tests or scripts. Run both the browser source check and the inclusive tooling/test check.
- The `@lostgradient/typescript` configuration package under `internal/typescript` exports only `library.json` and `browser.json`; `base.json` is private composition.
- Shared source libraries export TypeScript source directly, and consumers compile it at runtime, so do not add a build step to a just-in-time package without a packaging need. Type-checking is the one exception: a TypeScript library that another package type-checks against has a `tsconfig.source.json` (composite, declarations only, into the ignored `.types/`) built by its `types` script with `tsc -b`, and each consumer's `tsconfig.json` lists it under `references` and type-checks with `tsc -b tsconfig.json`. A Svelte component library (Cinder, chat, editor, terminal) emits its declarations with `svelte2tsx` through the same `types` script, into `.types/src`, and its `exports` map names them under the `types` condition while `svelte` and `default` keep naming source, because `svelte-check` does not substitute declarations for `.svelte` files on its own.
- Keep `typescript` explicit at the root. Do not rely on a transitive or peer dependency to supply `tsc`.
- Treat file length as review guidance, including in imported tests. Enforce classic cyclomatic complexity of at most 100 in implementation and tests, or 300 under `scripts/`. Keep executable repository tooling in its owning workspace's `scripts/` directory; required tool configuration and application entrypoints retain their documented locations.

## Release intent

- Per-change publishing is paused, and this workspace carries no `.changeset/` directory. Release intent for a batch backport is written in `stevekinney/corvidae-mirror`, next to the tooling that carries it to the mirrors, when the backport is made.
- `scripts/published-exports.json` (each public package's `exports` map, which Weft's documentation check and Markdown's import-graph test resolve against) is updated by hand after a backport.
- Interborough release automation belongs in Corvidae: build from a pinned source revision and verify the installed artifact on each supported target before publishing it. Corvidae GitHub Releases can host the compiled archives and checksums.

## Worktrees and design review

- Claude Code uses `claude --worktree <name>`; Codex uses its managed Worktree mode with a local-environment setup command of `bun install --frozen-lockfile`. Use native Git worktree behavior rather than custom creation hooks.
- Never copy `.env`, credentials, `node_modules`, caches, generated artifacts, or other ignored local state between worktrees. Do not add `.worktreeinclude` unless a specific non-secret ignored file is required.
- The design review of an Interborough interface or Cinder change gets its implementation-review verdict against the agreed design when there is one; the `design-review` skill also sweeps the existing interface and critiques a proposed design before it is built. Interborough is Cinder's only consumer, so a finding a Cinder component, default, or token can carry lands in Cinder.
- A "Design source" list is context, never a substitute for design rows as acceptance criteria, and a design programme closes only after a full drift audit of the canvas against the shipped interface.

### Worktree accumulation and Spotlight

Merged worktrees left in place keep `fseventsd` and Spotlight busy (COR-2398): one development host showed 332 worktrees and about 175% of a core between the two daemons. `bun scripts/chef/deliver.ts` removes the delivered worktree by default (`--keep-worktree` opts out), and `bun scripts/chef/worktree.ts stale` lists every worktree under the accepted roots with its branch, age, cleanliness, lock, live processes and delivered state; `stale --remove` removes the clean, unlocked, idle, delivered ones and never the main checkout or the worktree it runs from.

The two worktree roots are:

- `<main checkout>/.claude/worktrees`, where Claude Code's Agent tool makes worktrees.
- `~/.agent-worktrees`, which holds the `claude` and `codex` provider roots (`~/.agent-worktrees/<provider>/corvidae`).

To stop Spotlight indexing them on macOS, open System Settings, Spotlight, Search Privacy and add both folders. An empty file named `.metadata_never_index` in a folder also stops Spotlight indexing that folder. This is the owner's machine setting: no script or agent creates that file or changes a Spotlight setting, and a session that finds indexing slow reports it rather than changing it.
