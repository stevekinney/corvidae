# Corvidae

Corvidae is an internal [Bun](https://bun.sh/) workspace for agent runtimes, durable workflows, and [Svelte](https://svelte.dev/) interfaces. [Turborepo](https://turborepo.com/docs) coordinates local quality checks and application builds. The libraries are private, consume one another through `workspace:*` (Bun's protocol for linking another local workspace), and export [TypeScript](https://www.typescriptlang.org/) source directly.

## Working locally

Use the Bun version declared in `package.json`. Install from the root:

```bash
bun install --frozen-lockfile
bun run validate
```

The local quality commands are `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run format:check`. `bun run audit` checks high-severity dependency advisories. The internal workspace has no release or deployment pipeline and installs no Git hooks. Public mirror tooling under `scripts/mirror/` and `.github/workflows/mirror-sync.yaml` is a separate exception: it transforms source for the public repositories that build and publish those packages.

Weft's [PostgreSQL](https://www.postgresql.org/) integration tests start and dispose local clusters. Install PostgreSQL and make `initdb` and `pg_ctl` available on `PATH` before running the complete repository test suite. Those tests use temporary loopback-only databases and require no external credentials.

Run one workspace through its package scripts:

```bash
bunx turbo run lint typecheck test --filter=@lostgradient/operative
bun run --filter=@lostgradient/desktop dev
bun run --filter=@lostgradient/desktop build
```

The desktop application is an [Electrobun](https://electrobun.dev) 2 build: a Bun main process that runs the Operative agent loop, and a Svelte renderer built by Vite that draws the Cinder chat interface. Electrobun 2 does not ship its SDK through npm — `electrobun prepare` projects it into `.hutch/devkit`, which every lint, typecheck, and build task depends on and which is excluded from source control. Set `ANTHROPIC_API_KEY` before `dev` to exercise a real turn; without it the application still starts and reports the missing key in its failure banner. Application output is disposable and excluded from source control.

Run the cross-component browser suite with `bun run test:browser`, or use `bun run test:browser:preview` to exercise production compilation. Run the operator suite with `bun run --filter=@lostgradient/weft-ui test:browser`. Both use [Playwright](https://playwright.dev/). `bun run dev:browser-fixtures` starts the Bun fixture host for local inspection.

## Workspace boundaries

Browser component libraries live in `components/`: Cinder, Chat, Editor, and Weft UI. Other libraries live in `packages/`: the agent runtimes, the [evaluator](./packages/evaluation/README.md) that scores completed runs against versioned rubrics, Weft execution engine, Markdown processing, and shared test infrastructure. Repository configuration lives in `internal/`, including the `@lostgradient/typescript` presets. Every workspace uses the `@lostgradient/*` namespace.

Chat-room is the application under `applications/`. The `weft` package owns its `weft` and `weft-mcp` source executables. Weft UI owns its browser integration host under `components/weft-ui/scripts/browser`. Tests spanning Cinder, Chat, and Editor live under `scripts/browser-fixtures`; they need a real browser page, but have no application or package identity. Both test hosts compile Svelte and serve their assets with Bun. Chat-room is the only workspace that uses Vite.

Every source library exposes exactly one package entry:

```json
{
  "name": "@lostgradient/example",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

Import supported values and types from the package root. There are no built library artifacts or public subpath aliases. The consuming application compiles its libraries. Root style imports accompany the interface library APIs so applications receive their required CSS cascade.

Declare a dependency in the workspace that imports it. Internal dependencies use `workspace:*`; shared third-party versions use the root [Bun catalog](https://bun.sh/docs/pm/catalogs). Run `bun install` after changing manifests and commit the resulting root lockfile with the manifests.

## Configuration and verification

Environment configuration uses [`@lostgradient/environmentalist`](https://github.com/stevekinney/environmentalist) with [Zod](https://zod.dev/) schemas owned by the workspace that consumes the values. Keep schemas and synchronous resolver functions in `environment-configuration.ts` beside the relevant runtime or tooling. Import the resolver where the value is needed; call-time settings must remain call-time settings, and importing a library must not require credentials.

Resolution uses explicitly selected environment values and schema defaults only. Pass `sources: ['env', 'defaults']`, `argv: []`, and `coerce: false`; encode existing conversions in schema transforms and omit undefined source entries. Bun and SvelteKit retain responsibility for loading `.env` files. This does not enable Environmentalist's flag, project-file, or home-directory discovery, and it does not change existing explicit-option precedence or Weft connection-profile resolution. Portable library code uses a custom synchronous source with explicitly mapped canonical keys and no values when Bun and Node globals are absent.

Keep existing environment-variable names and empty-value behavior. Mark credentials with Environmentalist's `secret` metadata. Chat-room reads private request configuration through its server-only module; browser components continue to receive only their existing explicitly injected configuration. Test setup, environment restoration, child-process inheritance, and bundler replacement keys may use the raw environment, but configuration decisions belong in the owning resolver. `bun run test:self` enforces that boundary.

Formatting, lint policy, editor settings, dependency versions, and task coordination live at the root. Executable repository tooling lives in the owning workspace's `scripts/` directory. [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) caps classic cyclomatic complexity—the number of independent paths through a function—at 100 in implementation and tests, and 300 under `scripts/`; file length remains review guidance.

Compiler options live in the configuration-only `@lostgradient/typescript` workspace at `internal/typescript`. It exports `library.json` and `browser.json`; both compose the private `base.json`. Component workspaces extend `@lostgradient/typescript/browser.json`, which supplies DOM types and browser/Svelte resolution conditions without ambient Bun or Node types. Their `tsconfig.browser.json` checks production source; `tsconfig.json` also checks colocated tests and Bun tooling and supports Oxlint's automatic project discovery. Both checks run through `typecheck`. Root lint rules reject Node/Bun globals and imports in component source, including Svelte scripts. Tests and scripts retain their runtime APIs. Other local TypeScript configurations select their own source files; tool-required application and test configurations remain beside their owners.

Turbo hashes upstream library source through transit tasks—dependency-only tasks that affect cache keys without running a build. Changing a provider therefore invalidates its consumers' checks without building the libraries. Root tool configuration and shared scripts also participate in cache keys. Chat-room owns its [Vite](https://vite.dev/) grammar-asset plugin.

The root browser fixtures and Weft UI's browser host share `buildBrowser` and the Svelte compiler from `@lostgradient/testing`, while each host owns its own server and routes. Chat-room checks generate and cache their SvelteKit configuration and types. Root browser fixture tests generate and cache a manifest plus the explicit list of fixture modules they can load lazily; no upstream library build is required.

`bun run test:self` checks the workspace architecture, including source exports, dependency cycles, declared imports, catalog use, cache invalidation, build ownership, and the absence of publishing and hook installation. These checks keep the consolidation rules executable.

The [migration inventory](./MIGRATION.md) records source revisions, package mappings, dependency edges, removal decisions, and validation evidence. It is the completion record for this consolidation.

The [Operative and Bureau API contract](./documentation/operative-type-safe-api.md) explains typed agents, durable execution, and started-work control. [Hierarchical hook composition](./documentation/hierarchical-hook-composition.md) covers how Bureau, agent and direct-run hooks compose into one immutable plan per run, who can narrow whom, and what a run will tell you about its own plan. The [workflow versioning guide](./documentation/workflow-versioning.md) describes version stamps and recovery behavior. Generated codebase reports are disposable; `scripts/measure-codebase.ts` and `scripts/inventory-dependencies.ts` write fresh measurements to `/tmp` by default.

The [runtime contracts guide](./documentation/runtime-contracts.md) connects provider capabilities, model selection, steering, and cleanup across packages. Weft's [workflow revision guide](./packages/weft/documentation/guides/workflow-revisions.md), [shared-store ownership guide](./packages/weft/documentation/guides/shared-store-ownership.md), and [remote task recovery guide](./packages/weft/documentation/guides/remote-task-recovery.md) cover durable execution across deployments. For interfaces, start with [Cinder composition](./components/cinder/documentation/interface-guide.md) and [desktop application integration](./applications/desktop/README.md).

The [completed-project documentation audit](./documentation/completed-project-documentation.md) maps all 28 completed Linear projects to their reader-facing guides and references.
