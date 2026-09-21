---
name: validate-monorepo
description: Verify the internal workspace's dependency graph, direct-source library contracts, application toolchains, and local quality commands.
---

# Validate the workspace

Read the root `AGENTS.md`, manifests, and `turbo.json`. Preserve user changes. Validation does not authorize unrelated edits or external publication.

## Architecture

Confirm private `@lostgradient/*` names, resolvable acyclic `workspace:*` edges, root catalog ownership, and explicit compiler dependencies. Source libraries export only `./src/index.ts` through their root entry and have no build or publishing contract. The `@lostgradient/typescript` workspace under `internal/typescript` exports only `library.json` and `browser.json`; its `base.json` remains internal composition.

Check all four workspace roots: `applications/*`, `components/*`, `packages/*`, and `internal/*`. Component production source must pass its browser-only TypeScript check, with DOM types and no ambient server types; tests and tooling must also pass the inclusive TypeScript check. Root lint must reject server globals and imports in component source without excluding its tests from normal quality checks.

Applications own executable toolchains and build outputs. Source checks do not require upstream builds. Generated check inputs must work cold and restore from Turbo cache; watcher and mutation tasks must remain uncached. Shared formatting, lint, TypeScript policy, editor settings, and repository configuration belong at the root or the shared configuration package.

## Commands

Run each command from the root and record its actual exit status:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
bun run format:check
bun run validate
bun audit --audit-level=high
```

Use `bunx turbo run lint typecheck test --filter=@lostgradient/<name> --concurrency=1` for focused evidence. Application changes require commands appropriate to that application: exercise existing CLI entrypoints, or start the supported server and verify its expected response/render before stopping the owned process. Build and preview only where that toolchain provides them; record absent commands as not applicable. Name those exact commands and observable pass criteria before executing them. Root `test:self` contracts run through the normal test and validation commands. They verify the existing cache contracts. When generated-input ownership changes, additionally use a disposable checkout: run focused checks with `--force`, remove only the run-owned declared outputs, rerun without `--force`, and require cache hits plus restored artifacts and passing checks.

Run the listed commands in order. If one fails, stop that sequence, report its command/exit/log and which dependent gates remain unproven, and diagnose before rerunning the sequence. Independent investigation may continue. Do not run the aggregate `validate` as a substitute for resolving a failed component. Never infer success from filtered log text, remove assertions, suppress errors, or increase limits. Repair defects within the user's authorized scope; otherwise report the concrete blocker. Completion requires all required commands to pass against the final tree, with exact evidence and any unresolved failure stated plainly.
