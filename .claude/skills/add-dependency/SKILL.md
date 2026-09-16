---
name: add-dependency
description: >
  Add a dependency to the correct workspace in this Turborepo monorepo,
  handling the workspace:* protocol for internal packages. Triggers when the
  user says "add dependency", "install package", "add a package", "bun add",
  or "/add-dependency". Also triggers when the user asks to add, install,
  or use a new library or package.
allowed-tools: Read, Grep, Glob, Bash, AskUserQuestion
---

Add a dependency to the correct workspace in this Turborepo monorepo.

## Determine the Target

1. **Which package?** Identify the dependency to add (from the user's request).
2. **Which workspace?** Determine where it belongs:
   - If the user specified a workspace, use that.
   - If context makes it obvious (e.g., a server framework goes in `apps/server`), use that.
   - Otherwise, ask the user.
3. **Dev or production?** Determine if it is a devDependency or a regular dependency.
   - Type definitions (`@types/*`), linters, test utilities, build tools -> devDependency
   - Everything else -> regular dependency

## Internal vs External

**Internal packages** (packages that exist in this monorepo):

- Use `workspace:*` protocol
- Check if the package exists in `packages/` or `apps/` first
- The workspace name is in the package's `package.json` `name` field
- Edit the target workspace's `package.json` directly, adding `"@repo/<name>": "workspace:*"` to the appropriate dependencies field
- Then run `bun install` to link

**External packages** (from npm):

- Navigate to the workspace directory and run `bun add <package>`
- For devDependencies: `bun add -d <package>`

## Root vs Workspace

Dependencies shared across the entire monorepo as dev tooling (e.g., prettier, turbo,
lefthook) belong at the root. Application-specific dependencies belong in the workspace.

**Root-level** (add with `bun add -d -w <package>`):

- Formatting tools (prettier, plugins)
- Git hooks (lefthook)
- Monorepo tools (turbo)

**Workspace-level** (add from within the workspace directory):

- Runtime dependencies
- Workspace-specific dev tools
- Type definitions for workspace-specific packages

## Execution

Run the appropriate `bun add` command from the correct directory, then verify
the lockfile updated correctly with `bun install`.
