---
name: add-workspace
description: Add an application or private source library that matches this repository's existing workspace architecture.
---

# Add a workspace

Read the root `AGENTS.md`, neighboring manifests, shared TypeScript configuration, and `turbo.json`. Determine the requested name, capability, and application or library boundary before editing. Use the existing toolchain that fits that capability; the existing CLI application is also a valid boundary when no server or browser is needed. If the name, concrete capability, execution model, or required framework is unresolved, report `needs input` before creating files.

Before implementation, name the exact application commands and verification signals appropriate to the requested capability: a CLI invocation and result, or a server startup, successful request/render, and owned-process shutdown. Only require scripts the application actually needs; record absent development/build/preview commands as not applicable.

This guide creates source libraries and applications. Reuse the existing `@repo/typescript-configuration` owner for shared compiler configuration; a request for another configuration-only workspace requires its own explicit contract before proceeding.

## Library contract

Create the requested library under `packages/<name>` with `name: "@repo/<name>"`, `private: true`, `type: "module"`, and `exports: { ".": "./src/index.ts" }`. Implement the requested source capability and its meaningful tests.

Provide `lint`, `lint:fix`, `test`, and `typecheck` scripts that consume source. Reuse root lint and formatting policy and extend `@repo/typescript-configuration/library.json`. Select the package's actual source and tests in its local TypeScript configuration. Declare the shared TypeScript configuration with `workspace:*`, and declare `typescript`, `oxlint`, and `@types/bun` through the catalog. Reuse `@repo/testing` when tests need its infrastructure; add other test tools only when used. Add package-local configuration only when the tool requires it.

Use `workspace:*` for internal dependencies and `catalog:` for shared external versions. Keep runtime dependencies with the workspace that imports them. Libraries do not emit declarations, build artifacts, package archives, or publishing metadata.

## Application contract

Create applications under `applications/<name>` with private `@repo/*` manifests. Match a relevant existing application: Bun for an executable service, Vite for a browser application, or the documented SvelteKit Vite integration for SvelteKit. Add only the scripts and local configuration the application uses.

Applications own their builds and generated tooling inputs. Declare reusable generated inputs and build output for each producing task in `turbo.json`; keep watcher and mutation tasks uncached. Checks must prepare required generated inputs on a fresh checkout and must not depend on upstream library builds. Do not add CI/CD, release automation, deployment infrastructure, or hook installation.

## Verification

Run `bun install`, `bun install --frozen-lockfile`, and `bunx turbo run lint typecheck test --filter=@repo/<name> --concurrency=1`. Exercise an application's actual supported development and production commands. Update `README.md`, the workspace/dependency tables in `MIGRATION.md`, and the applicable cases in `scripts/workspace-contract.test.ts`, `scripts/workspace-imports.test.ts`, and `scripts/task-cache.test.ts`, then run `bun run validate`.

For generated-input changes, verify in a disposable checkout: run the focused command with `--force`, remove only its run-owned declared outputs, then rerun without `--force`. Require cache hits, restored artifacts, and passing checks. Never remove user-owned output to construct this probe.

Report the new workspace boundary, files, dependency edges, and exact validation exit statuses. Diagnose failures without placeholder implementations, suppressed checks, or increased limits.
