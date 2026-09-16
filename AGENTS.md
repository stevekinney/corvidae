# Project guidance

This is a pre-release Bun and Turborepo template. Keep it generic: add an app, package, framework, service, or deployment configuration only for a concrete product requirement.

## Workflow

- Inspect the existing workspace and nearby conventions before changing code.
- Plan non-trivial work, implement one complete testable capability at a time, and add a regression test for every defect.
- Use current official Bun, TypeScript, Turborepo, and dependency documentation for unfamiliar APIs or configuration.
- Run the relevant focused command while working and `bun run validate` before finishing. Treat warnings, console errors, and failed checks as defects.
- Keep source and script files below 500 lines. Prefer platform and Bun primitives over new abstractions or dependencies.
- Do not add compatibility, migration, shim, adapter, or re-export layers while the template is pre-release unless the requirement explicitly demands one.

## Workspace and dependencies

- `apps/*` contains deployable applications; `packages/*` contains shared libraries and configuration. Every workspace is named `@repo/*`.
- Internal dependencies always use `workspace:*`. Shared external tool versions belong in the root Bun `catalog`; add runtime dependencies to the workspace that imports them.
- Shared packages export TypeScript source directly. Consumers compile it, so do not add a build step to a just-in-time package without a packaging need.
- Use Bun commands only. `bun.lock` is authoritative, and dependency changes must update it with `bun install`.
- Keep `typescript` explicit at the root. Do not rely on a transitive or peer dependency to supply `tsc`.

## Turborepo

- `build` depends on upstream builds and caches only declared output files. This template's lint, type-check, test, and development tasks work directly on source, so they do not depend on upstream builds.
- Declare an environment variable in `turbo.json` only when it changes that task's result. Add task outputs whenever a task writes reusable artifacts; keep watchers and mutation tasks uncached.
- Use `--filter` for focused work, for example `bunx turbo run test --filter=@repo/server`. Run `bun run validate` for the complete graph.

## Worktrees and agents

- Treat each worktree as an isolated checkout. From a fresh worktree, run `bun install --frozen-lockfile` before development or validation.
- Claude Code uses `claude --worktree <name>`; Codex uses its managed Worktree mode with a local-environment setup command of `bun install --frozen-lockfile`. Use native Git worktree behavior rather than custom creation hooks.
- Never copy `.env`, credentials, `node_modules`, caches, generated artifacts, or other ignored local state between worktrees. Do not add `.worktreeinclude` unless a specific non-secret ignored file is required.
- Preserve unrelated worktrees and their branches. Remove only a clean worktree created by the current task after its branch is merged or retired.

## Generated-template behavior

- `bun create turbo` must produce a clean project: no `.env`, local Claude settings, build output, coverage, or Turbo cache may cross the template boundary. Keep `.env.example` intact.
- Keep the create-time cleanup and its self-tests synchronized whenever a new ignored generated path is introduced.

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
bun run test:create
bun run validate
bun audit --audit-level=high
```

Git hooks use Lefthook. The pre-commit hook checks the Git index rather than rewriting worktree-only edits; the pre-push hook runs `bun run validate`.
