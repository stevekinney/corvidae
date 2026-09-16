# Project Name

A Turborepo monorepo powered by [Bun](https://bun.sh).

## Prerequisites

- [Bun](https://bun.sh) (v1.3.0 or later)

## Getting Started

```bash
bun create turbo my-project
cd my-project
```

Or clone and install manually:

```bash
bun install
```

## What's Inside

### Apps

- **`apps/server`** -- Example Bun server application

### Packages

- **`packages/shared`** -- Shared utilities (internal package, no build step)
- **`packages/typescript-configuration`** -- Shared TypeScript compiler options

### Core Tools

- [Turborepo](https://turbo.build/repo) -- Monorepo task orchestration with caching
- [Bun](https://bun.sh) -- Runtime, bundler, test runner, and package manager
- [TypeScript](https://www.typescriptlang.org/) -- Static type checking
- [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) -- Fast Rust-based linter
- [Prettier](https://prettier.io/) -- Code formatting
- [Lefthook](https://lefthook.dev/) -- Git hooks

## Development

```bash
bun run dev         # Start dev servers (via turbo)
bun run build       # Build all workspaces
bun run test        # Run all tests
bun run lint        # Lint all workspaces
bun run typecheck   # Type check all workspaces
bun run format      # Format all files
bun run validate    # Full validation (lint + typecheck + test)
bun run clean       # Clean build artifacts
```

### Filtering by Workspace

Run tasks for a specific workspace using turbo's `--filter` flag:

```bash
bunx turbo run build --filter=@repo/server
bunx turbo run test --filter=@repo/shared
```

## Project Structure

```
apps/
  server/                   # Example Bun application
    src/                    # Application source code
    scripts/build.ts        # Build script using Bun.build
    package.json
    tsconfig.json
packages/
  shared/                   # Shared internal package
    src/                    # Library source code
    package.json            # Exports TypeScript directly (no build)
    tsconfig.json
  typescript-configuration/ # Shared tsconfig files
    base.json               # Base compiler options
    server.json             # Bun server apps
    library.json            # Runtime-agnostic libraries
turbo.json                  # Task pipeline configuration
package.json                # Workspace root
```

## Adding a New Workspace

### New Package

Create a directory in `packages/` with a `package.json`:

```json
{
  "name": "@repo/my-package",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "lint": "oxlint --type-aware --tsconfig ./tsconfig.json",
    "lint:fix": "oxlint --fix --type-aware --tsconfig ./tsconfig.json",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@repo/typescript-configuration": "workspace:*",
    "@types/bun": "^1.3.14",
    "oxlint": "^1.70.0"
  }
}
```

Add a `tsconfig.json` extending the shared config:

```json
{
  "extends": "@repo/typescript-configuration/library.json",
  "compilerOptions": {
    "rootDir": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"],
  "exclude": ["node_modules", "coverage"]
}
```

Then run `bun install` to link the workspace.

### New App

Same pattern but in `apps/`, extending `server.json` instead of `library.json`, and with additional scripts for `build`, `clean`, `dev`, and `start`.

## Cross-Workspace Dependencies

Use the `workspace:*` protocol in `package.json`:

```json
{
  "dependencies": {
    "@repo/shared": "workspace:*"
  }
}
```

Then import normally:

```typescript
import { greet } from '@repo/shared';
```

## Internal Packages Pattern

Packages in `packages/` export TypeScript source directly -- no build step needed. The consuming application's bundler handles transpilation. This means:

- Changes are reflected immediately (no rebuild required)
- TypeScript types are available without generating declarations
- The turbo pipeline is simpler (fewer build tasks)

## Git Hooks

Hooks are configured in `lefthook.yml` and implemented as Bun TypeScript files
under `scripts/hooks/`. Lefthook is installed via the `prepare` script on
`bun install`.

- `pre-commit`: formats staged files with Prettier, runs `oxlint --fix` on them,
  blocks staged conflict markers, then checks that `bun.lock` is staged when a
  `package.json` changes. Fast by design — typecheck and tests are deferred to
  pre-push. Skipped during merge/rebase.
- `pre-push`: runs `bun run validate` (lint, typecheck, test, build, and format
  check across all workspaces via turbo). The full gate before code leaves your
  machine. Skipped in CI.
- `post-checkout`: installs deps when dependencies changed; surfaces config
  changes across workspaces.
- `post-merge`: installs/cleans when dependencies or config changed; flags
  leftover conflict markers.

Hooks print only when something fails, so clean commits and pushes stay quiet.
Use `--no-verify` to bypass hooks (not recommended; CI will catch you anyway).

## TypeScript Path Aliases

Each workspace supports the `@/*` path alias pointing to its own `src/` directory:

```typescript
import { something } from '@/utilities';
// Resolves to ./src/utilities
```

## Template Bootstrap

When you create a new project with `bun create`, setup scripts automatically:

1. Set the package name from the directory name
2. Copy `.env.example` to `.env`
3. Write any available API keys to `.env`
4. Initialize git hooks
5. Clean up the setup scripts
