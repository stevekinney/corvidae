# Cinder playground

The component playground and documentation site for Cinder, Chat, and Editor. A Bun dev server renders one documentation page per component, compiles each page and example with `Bun.build`, and serves the result. `bun run build` drives the same request handler at build time and writes every route to `build/` as a static site.

This is a private application. Nothing in it is published to npm, and it is excluded from the public mirror (`scripts/mirror/package-map.json`).

## Commands

Run every command from the repository root.

```bash
bun run --filter=@lostgradient/playground dev
bun run --filter=@lostgradient/playground build
bun run --filter=@lostgradient/playground test
bun run --filter=@lostgradient/playground lint
bun run --filter=@lostgradient/playground typecheck
bun run --filter=@lostgradient/playground validate
```

- `dev` starts the server with `bun --watch`. It prefers port 5555 (or `PORT`) and scans upward when that port is busy.
- `build` writes the static export to `build/` and needs no flags. The script supplies the one setting the exporter requires, `PLAYGROUND_BASE_URL=https://cinder.website`, because the exporter refuses to run without an HTTPS origin and `turbo run build` supplies no environment. That origin is a deployment constant; change it in `package.json` if the site moves.
- `test` runs `scripts/run-tests.ts`, which starts one fresh `bun test` process for each test file that drives a build, so one file's compiled state cannot corrupt another's.
- `lint` runs oxlint, then `scripts/check-raw-native-controls.ts --strict` and `scripts/check-source-temp.ts`.
- `validate` starts the server in-process and crawls every documentation route. It is a manual gate, not part of the root `validate` graph.

## What lives here

- `src/` holds the server, the documentation page, the shell app, and every example under `src/examples/`.
- `scripts/` holds the static exporter, the test runner, and the example audits.
- `src/landing.md` is a copy of the public Cinder repository's README, which the home page renders. It is owner-maintained content and can drift from the README in `stevekinney/cinder`; refresh it from there when the public README changes.

## Decisions to know about

- Displayed package versions come from `scripts/mirror/package-map.json` (`lastPublishedVersion`), read by path from the repository root. Corvidae packages carry no version, and the `components.json` files carry an absent or stale one, so they are never consulted.
- Every component import goes through its package root (`@lostgradient/cinder`, `@lostgradient/chat`, `@lostgradient/editor`, `@lostgradient/markdown`), the single entry point each package exports. A dynamic import of a package root keeps every export, so `src/page-bundle.ts` writes a small per-page module that re-exports only the documented component, and the Playground tab loads that instead.
- Filesystem roots resolve from the package name with `import.meta.resolve`, never from a spelled-out layout. The GitHub links the pages build point at the public mirror's layout (`packages/components`, `packages/chat`, `packages/editor` in `stevekinney/cinder`) on purpose, so those strings do not follow the move.
- The playground keeps its own copies of the example-harness strip, the source fingerprint, the fixture loader wrapper, and the token introspection helpers rather than reaching into another workspace.
- Process environment is read only through `src/environment-configuration.ts`.

## Deployment

The live cinder.website deployment is still served from the public Cinder repository's copy of the playground until the Vercel project is repointed at this application. `vercel.json` is intentionally not part of this application yet; the deployment issue owns adapting it to `build/` and `bun run build`.
