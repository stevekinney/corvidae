# Project guidance

This is a pre-release, internal-only Bun and Turborepo workspace. Libraries are private source packages; applications own their executable toolchains. Do not add publishing, CI/CD, deployment infrastructure, or Git-hook installation. The single exception is the public mirror tooling: `scripts/mirror/` and the sync workflow at `.github/workflows/mirror-sync.yaml`, which transform this workspace's source into the public mirror repositories that build, bundle, and publish it. Those two paths are the whole of the exception—the prohibition is otherwise unchanged, and publishing, CI/CD, deployment infrastructure, and Git-hook installation remain prohibited everywhere else in this workspace, including in any other workflow file.

## Workflow

- Inspect the existing workspace and nearby conventions before changing code.
- Plan non-trivial work, implement one complete testable capability at a time, and add a regression test for every defect.
- Use current official Bun, TypeScript, Turborepo, and dependency documentation for unfamiliar APIs or configuration.
- Run the relevant focused command while working and `bun run validate` before finishing. Treat warnings, console errors, and failed checks as defects.
- Treat file length as review guidance, including in imported tests. Enforce classic cyclomatic complexity of at most 100 in implementation and tests, or 300 under `scripts/`. Keep executable repository tooling in its owning workspace’s `scripts/` directory; required tool configuration and application entrypoints retain their documented locations. Require a concrete ownership, duplication, or correctness benefit before restructuring code. Keep correctness, types, tests, and builds enforced. Prefer platform and Bun primitives over new abstractions or dependencies.
- Do not add compatibility, migration, shim, adapter, or re-export layers while the template is pre-release unless the requirement explicitly demands one.

## Workspace and dependencies

- `applications/*` contains deployable applications; `components/*` contains browser component libraries; `packages/*` contains other shared libraries; `internal/*` contains repository configuration. Every workspace is named `@corvidae/*`.
- Internal dependencies always use `workspace:*`. Shared external tool versions belong in the root Bun `catalog`; add runtime dependencies to the workspace that imports them.
- Component source uses the shared browser TypeScript configuration and root browser lint policy. Keep Bun and Node APIs in tests or scripts. Run both the browser source check and the inclusive tooling/test check.
- The `@corvidae/typescript` configuration package under `internal/typescript` exports only `library.json` and `browser.json`; `base.json` is private composition.
- Shared source libraries export TypeScript source directly. Consumers compile it, so do not add a build step to a just-in-time package without a packaging need.
- Use Bun commands only. `bun.lock` is authoritative, and dependency changes must update it with `bun install`.
- Keep `typescript` explicit at the root. Do not rely on a transitive or peer dependency to supply `tsc`.

## Turborepo

- Only applications have `build` tasks. Cache their declared application outputs. Lint, type-check, test, and development tasks consume library source directly and must not depend on upstream library builds.
- Declare an environment variable in `turbo.json` only when it changes that task's result. Add task outputs whenever a task writes reusable artifacts; keep watchers and mutation tasks uncached.
- Use `--filter` for focused work, for example `bunx turbo run test --filter=@corvidae/operative`. Run `bun run validate` for the complete graph.

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
bun run format:check
bun run test:self
bun run validate
bun audit --audit-level=high
bun run --filter=@corvidae/weft test:benchmarks
```

Run local quality commands explicitly. This repository has no Git hooks or automated release pipeline.

Weft's throughput, latency, and memory benchmarks are the one workspace-scoped entry in that list, because they belong to `@corvidae/weft` alone and `bun run --filter` is how the root invokes a single workspace's script. `bun run test` excludes them: their measurements swing far enough between runs on the same machine that they cannot assert a target, so they record numbers on demand instead of gating validation. Their targets are unchanged, and the benchmark directory's unit tests still run in the default suite.
