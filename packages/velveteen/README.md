# Velveteen

Velveteen is a private Bun-native Svelte compiler and application framework. Corvidae consumers can depend on `@lostgradient/velveteen` with `workspace:*` and import `@lostgradient/velveteen/compiler` to use its Bun build plugin.

From this directory, run `bun run test` for the workspace tests and `bun run test:package-consumer` to verify the packed compiler and TypeScript starter in independent applications. Run `bun run prepare:reference` before `bun run typecheck:reference` or `bun run test:batch-j`, which includes the pinned SvelteKit comparisons.

Production builds write `velveteen-manifest.js` and `velveteen-registry.js` alongside `manifest.json`. A host can import both modules and pass their `manifest` and `registry` values to `createApplication`, avoiding a runtime filesystem import of the generation. Supply an `assets` source when the host owns static assets. `fetchAssetSource(env.ASSETS)` adapts a Fetch binding such as a Cloudflare Workers `ASSETS` binding and delegates asset responses without Velveteen compression.

The original prototype plan and evidence summaries are in [FEASIBILITY.md](./FEASIBILITY.md) and [EXECUTION.md](./EXECUTION.md).
