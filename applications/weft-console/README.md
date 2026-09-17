# Weft console application

The runnable browser application for the [Weft UI library](../../packages/weft-ui/README.md). Vite compiles the shared Svelte source and produces application assets in `build/`. All libraries remain direct-source workspaces.

## Local development

Install dependencies from the Corvidae root with `bun install --frozen-lockfile`. From `applications/weft-console`, start the seeded Weft server in one terminal:

```bash
bun run dev:server
```

In another terminal, start Vite:

```bash
bun run dev
```

The API server listens on port `7233`; Vite uses port `5173` by default. The Vite proxy forwards API, discovery, JSON-RPC, MCP, WebSocket, and SSE requests to the local server. `WEFT_API_BASE_URL` changes the development proxy target.

The local harness uses the development credential defined in `scripts/dev-credentials.ts`. The proxy supplies it when a request has no authorization header. That proxy runs only in development; production authentication comes from the runtime configuration and the console's API-key entry flow.

## Application output

From this application directory, build and preview the browser assets:

```bash
bun run build
bun --bun vite preview
```

Vite writes hashed assets, source maps, and its asset manifest under `build/`. Turbo caches that application output. Preview serves the static application; the configured Weft endpoint must be available for API operations.

The internal Weft CLI's `--console` option loads this application's built shell and assets. It accepts `--console-path` for an explicit build directory. Console mounting is an application responsibility; `@repo/weft-ui` does not read a library build directory or provide a package mount adapter.

The same runtime configuration supports a same-origin server, a cross-origin Weft API, or an API served by a browser Service Worker. The [library's runtime configuration contract](../../packages/weft-ui/README.md#runtime-configuration) describes the fields. Cross-origin use requires the API server to admit the page's origin. Service Worker hosts use the worker's path prefix as `baseUrl` and select SSE explicitly.

## Verification

Run the application checks from `applications/weft-console`:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:deployment
bun run test:e2e
```

`test:deployment` exercises runtime configuration, cross-origin requests, and Service Worker hosting against the source Weft implementation. `test:e2e` builds the application before Playwright starts its browser scenarios. From the Corvidae root, `bun run validate` checks the complete workspace graph.
