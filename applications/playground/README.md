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
bun run --filter=@lostgradient/playground test:production
bun run --filter=@lostgradient/playground test:lifecycle
bun applications/playground/scripts/run-linux-lifecycle.ts
```

- `dev` starts the server with `bun --watch`. It prefers port 5555 (or `PORT`) and scans upward when that port is busy.
- `build` writes the static export to `build/` and needs no flags. The script supplies the two settings the exporter requires: `PLAYGROUND_BASE_URL=https://cinder.website`, because the exporter refuses to run without an HTTPS origin and `turbo run build` supplies no environment, and `NODE_ENV=production`, so a local build compiles the same production Svelte output that Vercel deploys rather than the development variant with its diagnostics. That origin is a deployment constant; change it in `package.json` if the site moves. The build also writes `build-report/export-report.json` beside `build/` (never inside it): the canonical routes, the source SHA (`VERCEL_GIT_COMMIT_SHA`, else `git rev-parse HEAD`) and whether the tree was dirty, `NODE_ENV`, the export duration, the peak resident set in bytes, and the build digest.
- `test` runs `scripts/run-tests.ts`, which starts one fresh `bun test` process for each test file that drives a build, so one file's compiled state cannot corrupt another's.
- `lint` runs oxlint, then `scripts/check-raw-native-controls.ts --strict` and `scripts/check-source-temp.ts`.
- `validate` starts the server in-process and crawls every documentation route. It is a manual gate, not part of the root `validate` graph.
- `test:production` is the static production gate (`scripts/check-static-playground.ts`). It verifies an existing `build/` exactly as the static host serves it, needs no credentials, and never starts the development server or compiler. It is not part of `test` or the root `validate` graph, because it launches Chromium. Options: `--directory <dir>` (default `build/`), `--export-report <file>` (default `build-report/export-report.json`), `--output <dir>` (default `test-results/static-production/`, or a `shard-<i>-of-<n>/` directory beneath it for a shard), `--shard <index>/<count>` (default `1/1`), `--workers <n>` (default 4), and `--allow-source-mismatch` (fixtures and smoke runs only). Pass options after `--`, as in `bun run --filter=@lostgradient/playground test:production -- --shard 1/8`.
- `test:lifecycle` proves the gate's runner leaves no process behind on any exit path: the stand-in cases (also part of `test`) and one case that interrupts a real Chromium run. `scripts/run-linux-lifecycle.ts` runs the same command from `git archive HEAD` in `mcr.microsoft.com/playwright:v1.63.0-noble`, once with `docker run --init` and once without.

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

## The static production gate

The gate runs in two layers. First the runner starts the static server (`scripts/static-playground-server.ts`, which applies `vercel.json`'s `cleanUrls`, `rewrites`, `redirects`, and `headers` by reading that file) and runs every check that needs no browser (`scripts/static-playground-preflight.ts`): the export report exists, its build digest matches the served bytes, its route count matches `sitemap.xml` and the route HTML files, `NODE_ENV` was `production`, and its source SHA is the clean `HEAD`; every canonical route answers 200 with prerendered content, a distinct title and description, canonical metadata, exactly one `h1`, and (for `/page/<name>`) the inline `__CINDER_EXAMPLES__` payload; required assets resolve and the initial payload budgets hold; `/c/<name>` answers the configured 301, configured headers are present, and an unknown path is a 404; and no served file contains a credential-shaped environment value or is a test file or fixture. Any failure ends the run before Chromium starts. Then Playwright runs `tests/playground-production.playwright.ts` over one case per route, view, and viewport: every component route in its Documentation and Playground views and every other route, each at 1440px and 390px. A case fails on a page error, a console error or warning, a failed same-origin request, any axe violation for WCAG 2.0 and 2.1 A and AA, horizontal overflow at 390px, or a Playground without a positive mounted signal. Timeouts are Playwright's defaults and retries are zero.

The build digest is the SHA-256 of the served directory's manifest: one `<sha256>  <path>` line per file, keyed by its POSIX path relative to that directory and sorted by path. `test-results/static-production/` holds `report.json` (each failing case with its diagnostics and screenshot path, the case count, worker count, source SHA, build digest, export duration, and peak resident set), the manifest as `manifest.sha256`, and failure screenshots. Run the gate after a direct `bun run --filter=@lostgradient/playground build`, not a `turbo run build` restored from cache: a cached `build/` without its matching report fails the digest or source check, on purpose.

This is a manual practice; nothing runs it automatically, and this workspace has no CI. Before merging a pull request that changes a path in `scripts/ignore-build.sh`, run `bun run --filter=@lostgradient/playground build` and then `test:production` on the pull request's head, and record the case count, the build digest, and the exit status in the pull request body. Comparing the deployed site's digest with that report is likewise a manual verification step after the deployment.

## Deployment

cinder.website is served by the existing Vercel project through its Git integration, with this directory as the project's Root Directory. `vercel.json` here configures it: the install command runs from the workspace root with the repository's pinned Bun, the build command is `bun run build` (the static export) with output in `build/`, and an ignore command skips deployments for commits that cannot change the playground. It also carries the site's response headers, clean URLs, the `/` rewrite, and the `/c/:name` redirect, which project settings cannot express.
