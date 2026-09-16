---
name: validate-monorepo
description: >
  Run a comprehensive health check on this Turborepo monorepo. Validates
  workspace configurations, dependency consistency, TypeScript resolution,
  linting, and the full turbo pipeline. Triggers when the user says "check
  health", "validate setup", "validate monorepo", "is the monorepo healthy",
  "audit the monorepo", or "/validate-monorepo". Also triggers when something
  seems broken across workspaces or after significant structural changes.
allowed-tools: Read, Grep, Glob, Bash, AskUserQuestion
---

Run a comprehensive health check on this Turborepo monorepo and report findings.

## Checks to Perform

Run all checks and collect results before reporting. Do not stop at the first failure.

### 1. Workspace Structure

- Verify all directories in `apps/` and `packages/` have a `package.json`
- Verify each workspace `package.json` has a `name` field with `@repo/` prefix
- Verify each workspace has a `tsconfig.json`
- Verify workspaces declared in root `package.json` `workspaces` field match actual directories

### 2. Dependency Consistency

- Run `bun install --frozen-lockfile` to verify lockfile is up to date
- Check that internal dependencies use `workspace:*` protocol
- Verify `@repo/typescript-configuration` is a devDependency of every workspace that has a `tsconfig.json` extending it
- Check for duplicate dependency versions across workspaces (same package, different versions)

### 3. TypeScript Resolution

- Run `bun run typecheck` (delegates to turbo) -- verify all workspaces pass
- Verify each workspace's `tsconfig.json` extends from `@repo/typescript-configuration`
- Check that path aliases (`@/*`) are configured consistently

### 4. Linting and Formatting

- Run `bun run lint` -- verify all workspaces pass
- Run `bun run format:check` -- verify formatting is consistent
- Verify `.oxlintrc.json` exists at root (required for traversal discovery)

### 5. Build Pipeline

- Run `bun run build` -- verify all buildable workspaces succeed
- Verify turbo caching works (run build twice, second should hit cache)
- Check that `turbo.json` task definitions cover all scripts used by workspaces

### 6. Tests

- Run `bun run test` -- verify all workspace tests pass

## Reporting

Present results as a checklist with pass/fail status for each check.
For failures, include the specific error and a suggested fix.
