---
name: add-workspace
description: >
  Scaffold a new app or package workspace in this Turborepo monorepo. Triggers
  when the user says "add a new app", "create a workspace", "new package",
  "scaffold workspace", "add workspace", "create an app", "create a package",
  or "/add-workspace". Also triggers when the user asks to add or create
  something that should live in apps/ or packages/.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, AskUserQuestion
---

Scaffold a new workspace (app or package) in this Turborepo monorepo.

## Gather Requirements

Ask the user (if not already specified):

1. **Type**: Is this an app (`apps/`) or a package (`packages/`)?
2. **Name**: What should it be called? (will be prefixed with `@repo/`)
3. **Description**: One-line description of what it does.

If not specified, use these defaults:

- Apps extend `@repo/typescript-configuration/server.json`
- Packages extend `@repo/typescript-configuration/library.json`
- All workspaces use oxlint for linting with type-aware mode

## Scaffold the Workspace

### For a package (internal, no build step)

Create the following files:

**`packages/<name>/package.json`**:

- `name`: `@repo/<name>`
- `private`: true
- `version`: "0.0.1"
- `type`: "module"
- `exports`: `{ ".": "./src/index.ts" }` (Just-in-Time pattern -- no build)
- `scripts`: lint, lint:fix, test, typecheck (no build script)
- `devDependencies`: `@repo/typescript-configuration` (workspace:\*), `@types/bun`, `oxlint`

**`packages/<name>/tsconfig.json`**:

- Extends `@repo/typescript-configuration/library.json`
- Sets `rootDir`, `paths`, `include`, `exclude`

**`packages/<name>/src/index.ts`**: Empty export placeholder.
**`packages/<name>/src/index.test.ts`**: Basic test verifying test environment works.

### For an app

Create the following files:

**`apps/<name>/package.json`**:

- `name`: `@repo/<name>`
- `private`: true
- `version`: "0.0.1"
- `type`: "module"
- `scripts`: build, clean, dev, lint, lint:fix, start, test, typecheck
- `devDependencies`: `@repo/typescript-configuration` (workspace:\*), `@types/bun`, `oxlint`

**`apps/<name>/tsconfig.json`**:

- Extends `@repo/typescript-configuration/server.json`
- Sets `rootDir`, `paths`, `include`, `exclude`

**`apps/<name>/bunfig.toml`**: Copy from root `bunfig.toml`.
**`apps/<name>/src/index.ts`**: Entry point placeholder.
**`apps/<name>/src/index.test.ts`**: Basic test placeholder.

If the app needs a build step, also create:

- `apps/<name>/tsconfig.build.json` (extends local tsconfig)
- `apps/<name>/scripts/build.ts` (using Bun.build)

## After Scaffolding

1. Run `bun install` to link the new workspace.
2. Run `bun run typecheck` to verify TypeScript resolves.
3. Run `bun run test` to verify tests pass.
4. Report what was created.
