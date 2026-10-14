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

## Commands

```bash
bun install --frozen-lockfile
bun run dev
bun run build
bun run lint
bun run typecheck
bun run test
bun run test:slow
bun run check:test-durations
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

A test that does seconds of real work (spawning processes, bundling, git, ts-morph, instrumented loops) is a different class: its assertion is correctness, so it stays in the gate, but it sits near Bun's 5-second per-test limit and host contention pushes it over (COR-1499). Such a test either becomes fast by removing redundant work, or moves to a `*.slow.test.ts` file. A workspace's `test` ignores those files (`--path-ignore-patterns='**/*.slow.test.ts'`, or the playground runner's own lane split) and its `test:slow` runs only them. `bun run validate` runs `bun run test:slow` with `--concurrency=1` after the fast phase, so nothing leaves the gate and no timeout is raised. A workspace that holds `*.slow.test.ts` files must define both scripts, and `scripts/check-test-durations.ts` fails otherwise.

Each workspace's fast `test` runs through `scripts/bun-test-junit.ts` (the playground through `scripts/run-tests.ts`), which writes JUnit XML to `test-output/junit/`. `bun run check:test-durations` runs after `bun run test` and fails any fast-lane test that took longer than 2 s unless `scripts/test-duration-allowlist.json` lists it. It also fails an allowlisted entry that is gone or took under 1 s, so the list can only shrink: `bun scripts/check-test-durations.ts --shrink` drops stale entries, and `--seed` refuses to run once the file has entries. Adding an entry is a reviewed edit and needs a tracking issue. Process spawns inside test bodies are a separate rule with its own guard (COR-1507); the duration ratchet also catches the in-process work that guard cannot see, such as ts-morph analysis and per-byte loops, and a test that a spawn fix makes fast leaves the allowlist through the stale-entry failure. The budget is also enforced inside each workspace's `test` run, so a run that leaves a test over budget fails there and turbo never caches it: rerunning `bun run test` measures again. The guard measures wall time, so a loaded host can push a test across the budget; rerun it before treating a failure as a regression, and never raise the budget.
