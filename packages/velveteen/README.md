# Velveteen

Velveteen is a private Bun-native Svelte compiler and application framework. Corvidae consumers can depend on `@lostgradient/velveteen` with `workspace:*` and import `@lostgradient/velveteen/compiler` to use its Bun build plugin.

From this directory, run `bun run test` for the workspace tests and `bun run test:package-consumer` to verify the packed compiler and TypeScript starter in independent applications. Run `bun run prepare:reference` before `bun run typecheck:reference` or `bun run test:batch-j`, which includes the pinned SvelteKit comparisons.

The original prototype plan and evidence summaries are in [FEASIBILITY.md](./FEASIBILITY.md) and [EXECUTION.md](./EXECUTION.md).
