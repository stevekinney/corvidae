# Project guidance

This is a pre-release, internal-only Bun and Turborepo workspace. Libraries are private source packages; applications own their executable toolchains. Do not add publishing, CI/CD, deployment infrastructure, or Git-hook installation. The single exception is the public mirror tooling: `scripts/mirror/` and the sync workflow at `.github/workflows/mirror-sync.yaml`, which transform this workspace's source into the public mirror repositories that build, bundle, and publish it. Those two paths are the whole of the exception—the prohibition is otherwise unchanged, and publishing, CI/CD, deployment infrastructure, and Git-hook installation remain prohibited everywhere else in this workspace, including in any other workflow file. One application-owned hosting file is not infrastructure in this sense: `applications/playground/vercel.json` gives the existing Vercel project that serves cinder.website its install and build commands, response headers, and redirects, which project settings cannot express. Its `ignoreCommand` belongs to the same exception: `applications/playground/scripts/ignore-build.sh`, with the `ignore-build.ts` and `environment-configuration.ts` beside it, decides only whether that project builds a given commit, so that the hour-long export runs only when the deployed site could change. None of it adds a workflow, and the Vercel project's Git integration builds it.

## Workflow

- Inspect the existing workspace and nearby conventions before changing code.
- Plan non-trivial work, implement one complete testable capability at a time, and add a regression test for every defect.
- Use current official Bun, TypeScript, Turborepo, and dependency documentation for unfamiliar APIs or configuration.
- Run the relevant focused command while working and `bun run validate` before finishing. Treat warnings, console errors, and failed checks as defects.
- Treat file length as review guidance, including in imported tests. Enforce classic cyclomatic complexity of at most 100 in implementation and tests, or 300 under `scripts/`. Keep executable repository tooling in its owning workspace’s `scripts/` directory; required tool configuration and application entrypoints retain their documented locations. Require a concrete ownership, duplication, or correctness benefit before restructuring code. Keep correctness, types, tests, and builds enforced. Prefer platform and Bun primitives over new abstractions or dependencies.
- Do not add compatibility, migration, shim, adapter, or re-export layers while the template is pre-release unless the requirement explicitly demands one.

## Workspace and dependencies

- `applications/*` contains deployable applications; `components/*` contains browser component libraries; `packages/*` contains other shared libraries; `internal/*` contains repository configuration; `scripts/browser-fixtures` is a private workspace that only declares the workspaces the root browser fixtures import. Every workspace is named `@lostgradient/*`, except `armorer` and `conversationalist`, which carry their unscoped npm names.
- Internal dependencies always use `workspace:*`. Shared external tool versions belong in the root Bun `catalog`; add runtime dependencies to the workspace that imports them.
- Component source uses the shared browser TypeScript configuration and root browser lint policy. Keep Bun and Node APIs in tests or scripts. Run both the browser source check and the inclusive tooling/test check.
- The `@lostgradient/typescript` configuration package under `internal/typescript` exports only `library.json` and `browser.json`; `base.json` is private composition.
- Shared source libraries export TypeScript source directly. Consumers compile it, so do not add a build step to a just-in-time package without a packaging need.
- Use Bun commands only. `bun.lock` is authoritative, and dependency changes must update it with `bun install`.
- Keep `typescript` explicit at the root. Do not rely on a transitive or peer dependency to supply `tsc`.

## Release intent

- Release intent for a package the mirrors publish belongs in corvidae, next to the change it describes. Write it as a standard changeset Markdown file under the root `.changeset/` directory. The next sync carries each new file to its mirror once, and that mirror's own Changesets flow versions and publishes it.
- One changeset names packages of exactly one mirror target, by the published npm names of `publish-as` workspaces. `scripts/mirror/changesets.test.ts` enforces this.
- A changeset merged to `main` is immutable until it is deleted, and the sync refuses any edit, rename or reused name. To replace one, delete it in one pull request and add the replacement under a new name in a separate, later pull request. After it has synced, fix it in the target's `.changeset/` directory. Do not move a package between mirrors while any corvidae changeset names it: delete those changesets first, and add new ones after the move.
- Publishing stays in the mirrors, and corvidae never publishes. A `.changeset/*.md` file is content, not tooling, so it does not widen the `scripts/mirror/` exception above.

## Turborepo

- Only applications have `build` tasks. Cache their declared application outputs. Lint, type-check, test, and development tasks consume library source directly and must not depend on upstream library builds.
- Declare an environment variable in `turbo.json` only when it changes that task's result. Add task outputs whenever a task writes reusable artifacts; keep watchers and mutation tasks uncached.
- Use `--filter` for focused work, for example `bunx turbo run test --filter=@lostgradient/operative`. Run `bun run validate` for the complete graph.
- The heavy root stages—`lint`, `typecheck`, `test`, `coverage`, and `build`—run through `scripts/run-exclusively.ts`, which holds one lock in the Git common directory that every worktree on the host shares. Concurrent `bun run validate` runs queue stage by stage instead of oversubscribing the machine, which otherwise times out unrelated tests at random. A waiting stage prints which process holds the lock, and a lock whose holder died is reclaimed. Focused `bunx turbo run … --filter` commands bypass the lock on purpose, so keep them focused. `scripts/workspace-contract.test.ts` keeps each stage behind the lock.
- Every turbo task runs the uncached root `//#preflight` task (`bun install --frozen-lockfile`) first, by way of `transit`, so a `package.json` edit without a matching `bun install` fails every turbo command rather than running against a stale tree. Turbo hashes `bun.lock` but never `node_modules`, so a drifted install would otherwise cache a result under a key describing a toolchain it was not built with. A package-specific `<package>#<task>` entry replaces the generic task definition instead of merging with it, so any new override must restate `"dependsOn": ["transit"]`; `scripts/task-cache.test.ts` enforces that every cacheable task still reaches the preflight.
- Keep cache keys scoped to what a task can observe, so a change reruns only the packages it can affect. Because every task depends on `//#preflight`, its inputs are only `bun.lock` and the `package.json` manifests. The root package depends on no workspace except `@lostgradient/typescript`: turbo folds the files of every workspace the root depends on into the global hash, which would invalidate every cached task whenever one of them changed. Give root tooling that needs a workspace its own workspace, as `scripts/browser-fixtures` does. `globalDependencies` names individual configuration files, never directory globs; a package task that runs a root script lists that script in its own `inputs`. `scripts/task-cache.test.ts` enforces all three.

## Worktrees and agents

- Treat each worktree as an isolated checkout. From a fresh worktree, run `bun install --frozen-lockfile` before development or validation.
- Claude Code uses `claude --worktree <name>`; Codex uses its managed Worktree mode with a local-environment setup command of `bun install --frozen-lockfile`. Use native Git worktree behavior rather than custom creation hooks.
- Never copy `.env`, credentials, `node_modules`, caches, generated artifacts, or other ignored local state between worktrees. Do not add `.worktreeinclude` unless a specific non-secret ignored file is required.
- Preserve unrelated worktrees and their branches. Remove only a clean worktree created by the current task after its branch is merged or retired.

## Dev Container

`.devcontainer/` is a local development environment in which `bun run validate` passes from a fresh checkout with nothing on the host but Docker. It is not CI: nothing builds, runs, or publishes it automatically. Its image is Debian 13 (`oven/bun`) with the workspace's pinned Bun, PostgreSQL 17's `initdb` and `pg_ctl` on `PATH`, and Git; it copies nothing from the checkout, so `.env`, credentials, and caches never enter it, and it has no `.dockerignore` because its build context is `.devcontainer/` alone. `scripts/dev-container.test.ts` keeps its Bun tag equal to `packageManager`.

- Open any checkout or worktree with "Reopen in Container" (or `devcontainer up --workspace-folder .`). The checkout is mounted at its host path; `initializeCommand` links `.devcontainer/.git-common-dir` (ignored) to the host's Git common directory, the container mounts it, and `scripts/dev-container.ts` makes a linked worktree's absolute `gitdir:` resolve. The root `node_modules` and Turborepo's cache live in per-container volumes, so the host's darwin packages and cached task results never meet the container's Linux ones. With the isolated linker, the per-workspace `node_modules` links the container's install rewrites point into the root store, so run `bun install --frozen-lockfile` on the host again before using the same checkout there; a dedicated worktree for container work avoids the round trip.
- The container works as the `bun` user, because `initdb` refuses to run as root.
- To validate a committed branch without an editor, clone it inside the image rather than mounting the host checkout: `docker build -t corvidae-dev .devcontainer`, `git bundle create /tmp/corvidae.bundle HEAD`, then `docker run --rm -v /tmp/corvidae.bundle:/tmp/corvidae.bundle:ro corvidae-dev sh -c 'git clone -q /tmp/corvidae.bundle ~/corvidae && cd ~/corvidae && bun install --frozen-lockfile && bun run validate'`.

What the container enables, suite by suite:

- Live PostgreSQL (`packages/weft/src/storage/postgres.test.ts`) and live Neon driver (`neon-live.test.ts`, through `neon-proxy.test-support.ts` to the same disposable cluster): enabled. They need only `initdb` and `pg_ctl`, and they are what keeps `@lostgradient/weft#test:coverage` above its floor for `neon.ts`, `postgres.ts`, and their two test-support modules. The cluster is `initdb --no-locale -E UTF8`, so no system locale is needed; the C collation the key-value schema depends on is pinned in its DDL. PostgreSQL 17 is Debian 13's server major and the release the host-side fix used.
- A real Neon endpoint: not provisioned. The live Neon suite tests the real driver's wire protocol against the local cluster, and a hosted database would need credentials the container must not carry.
- Chromium smoke tests (`WEFT_BROWSER_SMOKE=1`: WebExtensionStorage, IndexedDB, HttpClient, Service Worker) and the Playwright browser fixtures: not installed. They are opt-in and outside `validate` on every machine, the browser adds about half a gigabyte, and the committed visual snapshots are keyed to linux/x64 Ubuntu, which this linux/arm64 Debian image would not match. Inside the container, `bunx playwright install --with-deps chromium` (as root) opts in.
- The Agent Skills reference validator (`AGENT_SKILLS_REFERENCE_VALIDATOR`): not installed. It is opt-in and fetches a pinned Python tool with `uvx`.
- Cinder's Svelte coverage floor is recorded as measured on linux/x64. On Apple silicon the container runs linux/arm64, so `check-coverage-ratchet.ts` prints its platform notice there just as it does on macOS; the floor still applies and passes.

## Commands

```bash
bun install --frozen-lockfile
bun run dev
bun run build
bun run lint
bun run typecheck
bun run test
bun run format:check
bun run test:self
bun run validate
bun run audit
bun run --filter=@lostgradient/weft test:benchmarks
bun run --filter=@lostgradient/markdown test:benchmarks
bun run --filter=@lostgradient/cinder test:benchmarks
```

Run local quality commands explicitly. This repository has no Git hooks or automated release pipeline.

`bun run audit` runs `bun audit --audit-level=high` through `scripts/check-audit-exceptions.ts`. An advisory may be tolerated only by an entry in `scripts/audit-exceptions.ts`, which needs an owner decision, a tracking issue, a review-by date, and the exact dependency chains that may reach the package; the guard fails on a stale, expired, or widened exception. Never add a bare `--ignore`.

The `test:benchmarks` commands are the workspace-scoped entries in that list, because each belongs to a single package and `bun run --filter` is how the root invokes one workspace's script. `bun run test` excludes what they run: a suite that asserts a wall-clock or memory target measures the machine as much as the code, and on a host running several agents at once those measurements swing far enough that they cannot gate validation. They record numbers on demand instead. Their targets are unchanged. A root lint guard, `scripts/check-wall-clock-assertions.ts`, fails the build when a `*.test.ts` outside `scripts/benchmarks/` asserts an upper bound on a duration or a rate it can derive from a timing reading.

Correctness assertions never move with them. Weft keeps its benchmark directory's unit tests in the default suite, and Markdown's pathological-document and diff-identity checks stayed behind in `src/` when its timing assertions left. Each package excludes its benchmarks in the way its layout allows: Weft path-ignores the `.test.ts` benchmark files under `scripts/benchmarks/` in its `test` script and also keeps `*.bench.ts` files there, run by explicit `test:benchmarks` entries; Markdown and Cinder name theirs `*.bench.ts` under `scripts/benchmarks/`, which Bun's default discovery skips on its own. The rule is the same everywhere: a target that depends on host load belongs outside the gate, and the correctness it was bundled with belongs inside it.
