# TypeScript Configuration

`@lostgradient/typescript` owns the shared [TypeScript](https://www.typescriptlang.org/) compiler presets for the Corvidae workspace. It is a private configuration package: consumers extend its JSON files directly, and it has no runtime entry point or build step.

## Presets

- `@lostgradient/typescript/library.json` configures TypeScript source libraries and includes the [Bun](https://bun.sh/) types used by their tests and tooling.
- `@lostgradient/typescript/browser.json` configures browser and [Svelte](https://svelte.dev/) source with DOM libraries and browser-specific resolution conditions. Component workspaces decide which production files it checks; their browser configurations exclude tests, fixtures, and scripts so production source cannot rely on Bun or Node globals.

Both public presets compose the package's private `base.json`. The base configuration is intentionally not exported.

## Workspace usage

Declare `"@lostgradient/typescript": "workspace:*"` in the consuming workspace's development dependencies, then extend the appropriate preset:

```json
{
  "extends": "@lostgradient/typescript/library.json"
}
```

Browser component workspaces use `browser.json` for their production source check and a separate inclusive configuration for tests and Bun tooling.

## Verification

Run `bun test scripts/workspace-contract.test.ts` from the repository root to verify the exported preset contract. Run `bun run validate` for the complete workspace validation graph.
