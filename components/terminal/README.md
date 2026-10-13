# @lostgradient/terminal

`@lostgradient/terminal` is the browser terminal component for Corvidae. It renders terminal sessions with the engine the [terminal contract](../../documentation/terminal/contract.md) selected, `@xterm/xterm`, composed with [Cinder](../cinder/README.md) components. The package is a workspace foundation today: the component, controller, and transport arrive in later issues. Its entry exports only the engine identity until then.

## Workspace usage

Declare `"@lostgradient/terminal": "workspace:*"` in the consuming workspace's dependencies and run `bun install` from the Corvidae root. The package is private and exports TypeScript and Svelte source directly, so the consuming application compiles it and there is no build step. Shared external versions come from the root Bun catalog.

## Boundaries

This package is browser-only and is checked by `tsconfig.browser.json`, which has the DOM library, no ambient types, and the `browser` condition. It depends on [`@lostgradient/ventriloquist`](../../packages/ventriloquist/README.md) and may import only that package's platform-neutral root export. It never imports `@lostgradient/ventriloquist/bun`, `@lostgradient/ventriloquist/websocket`, `bun:*`, or Node modules.

`bun run test:boundaries` enforces this. It fails when browser source (test files and test scaffolding excluded) imports any of those, when the root catalog does not pin `@xterm/xterm` at the contract version or any manifest in the workspace declares a rejected comparison engine, and when importing the package under plain Bun constructs the engine, reads a DOM global, defines a global, fetches, compiles WebAssembly, creates a worker or socket, or loads a Bun-only ventriloquist entry.

## Commands

- `bun run typecheck`: `svelte-check` against the browser program and then the Bun-typed program that also covers tests and scripts.
- `bun run test`: the colocated `*.test.ts` files under `src/`, plus the boundary tests, with the `browser` and `svelte` conditions.
- `bun run test:boundaries`: the boundary tests and the boundary check described above.
- `bun run test:coverage`: the tests with LCOV output, then the ratchet in `coverage-ratchet.json` through `@lostgradient/testing/coverage-ratchet`. TypeScript lines and functions are held at 100 percent. The `svelte` ratchet is absent until the first `.svelte` source module lands and seeds it from its first measurement, after which it is never lowered.

## Testing

`src/test/mount-harness.ts` mounts a Svelte component into its own container, flushes reactive updates, and tears it down, so a test can prove that a component renders, reacts, and leaves nothing behind. It is test-only and excluded from the browser program and from coverage.
