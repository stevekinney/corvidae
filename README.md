# Corvidae

Corvidae is an internal [Bun](https://bun.sh) workspace for agent runtimes, durable workflows, and [Svelte](https://svelte.dev) interfaces. [Turborepo](https://turborepo.com/docs) coordinates local quality checks and application builds. The libraries are private, consume one another through `workspace:*`, and export TypeScript source directly.

## Working locally

Use the Bun version declared in `package.json`. Install from the root:

```bash
bun install --frozen-lockfile
bun run validate
```

The local quality commands are `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run format:check`. `bun audit --audit-level=high` checks dependency advisories. No CI, publishing, deployment, or Git-hook setup is included.

Weft storage integration tests start and dispose local PostgreSQL clusters. Install PostgreSQL and make `initdb` and `pg_ctl` available on `PATH` before running the full test suite. The tests use temporary loopback-only databases and require no external database credentials.

Run one workspace through its package scripts:

```bash
bunx turbo run lint typecheck test --filter=@repo/operative
bun run --filter=@repo/chat-room dev
bun run --filter=@repo/chat-room build
bun run --filter=@repo/chat-room preview
```

Chat-room uses the documented [SvelteKit Vite integration](https://svelte.dev/docs/kit/@sveltejs-kit-vite). Its `dev`, `build`, and `preview` commands invoke Vite through Bun. Application output is disposable and excluded from source control.

## Workspace boundaries

Libraries live in `packages/`. The Agent Bureau packages provide agent composition, tools, conversations, memory, skills, and lifecycle primitives. Weft provides durable execution; Weft UI provides its reusable operator interface. Cinder, Chat, Editor, and Markdown provide the component and document surfaces. Testing contains shared test infrastructure. The existing TypeScript configuration package owns compiler policy.

Applications live in `applications/`. Chat-room exercises the agent and interface packages. Weft Console owns the operator console's browser build, and Weft CLI owns executable command-line composition. Cinder Browser Fixtures hosts component tests through Vite and owns their generated manifest. The existing server remains a Bun application.

Every library exposes exactly one package entry:

```json
{
  "name": "@repo/example",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

Import supported values and types from the package root. There are no built library artifacts or public subpath aliases. The consuming application compiles its libraries. Root style imports accompany the interface library APIs so applications receive their required CSS cascade.

Declare a dependency in the workspace that imports it. Internal dependencies use `workspace:*`; shared third-party versions use the root [Bun catalog](https://bun.sh/docs/pm/catalogs). Run `bun install` after changing manifests and commit the resulting root lockfile with the manifests.

## Configuration and verification

Formatting, lint policy, editor settings, dependency versions, and task coordination live at the root. Compiler options live in `packages/typescript-configuration`. Local TypeScript configurations select their source files; tool-required application and test configurations remain beside their owners.

Turbo hashes upstream library source through transit tasks, so changing a provider invalidates its consumers' checks without building the libraries. Root tool configuration and shared scripts also participate in cache keys. Chat-room, Weft Console, and Cinder Browser Fixtures share the grammar-asset Vite plugin in `scripts/shiki-grammar-assets.ts`; its outputs belong to those applications. Chat-room checks generate and cache their SvelteKit configuration and types; Cinder fixture tests generate and cache their manifest.

`bun run test:self` checks the workspace architecture, including source exports, dependency cycles, declared imports, catalog use, cache invalidation, build ownership, and the absence of publishing and hook installation. These checks keep the consolidation rules executable.

The [migration inventory](./MIGRATION.md) records source revisions, package mappings, dependency edges, removal decisions, and validation evidence. It is the completion record for this consolidation.
