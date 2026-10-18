# Weft UI

[Svelte](https://svelte.dev/) components and client helpers for the [Weft](../../README.md) operator console. The UI owns the interface for workflows, human reviews, workers, schedules, storage, and system diagnostics. Its source lives in `src/ui`, its tests beside it and in `src/ui/tests`, its fixtures in `src/ui/fixtures`, its browser tooling and seeded test host in `scripts/ui-browser`, and its coverage ratchet in `scripts/ui-coverage`. Engine code never imports `src/ui`.

## Usage

Inside Corvidae the UI is Weft's `./ui` entry, which resolves to the TypeScript and Svelte source. It is not yet part of the published `@lostgradient/weft`; COR-1452 ships it. The entry exports exactly the names `documentation/weft-ui-public-surface.md` at the Corvidae root lists, and `src/ui/public-surface.test.ts` holds the two to each other: the whole application, one view per area, and the client, query, router, live-source, and runtime-configuration layers they share.

```ts partial
import {
  WeftDashboard,
  WorkflowsView,
  createClient,
  readRuntimeConfig,
  provideClient,
  getClient,
  setApiKey,
} from '@lostgradient/weft/ui';
```

`WeftDashboard` is the browser application shell. It reads runtime configuration, creates the HTTP client, resolves the current principal, and presents API-key entry when authentication is required. The entry imports the shared interface styles, so importing any name from it brings them. Application tooling compiles the TypeScript and Svelte source directly.

`DashboardView`, `WorkflowsView`, `ReviewsView`, `WorkersView`, `SchedulesView`, `StorageView`, and `SystemView` render one area each, inside `WeftDashboard` or on their own. On its own a view needs only a client from `provideClient`, a `QueryClientProvider` around `createQueryClient()`, and the location `router` reads; it resolves the principal itself and supplies its own fleet event source and toast region when no ancestor did. `router` reads `window` on first use rather than when the module loads, so the entry imports without a DOM.

`createClient(configuration, sameOriginBaseUrl?)` creates a Weft `HttpClient`. `provideClient` and `getClient` share that client through Svelte context. `setApiKey` creates a replacement client with the entered key and removes conflicting authorization headers; it does not persist the key.

## Runtime configuration

`readRuntimeConfig` reads the `weft-ui-config` JSON element from the host document. A missing or empty element defaults to same-origin requests and automatic transport. Invalid JSON or an invalid configuration shape throws.

```html
<script type="application/json" id="weft-ui-config">
  { "baseUrl": "/weft", "eventTransport": "sse" }
</script>
```

| Field | Meaning |
| --- | --- |
| `baseUrl` | Required string. An empty string uses the page origin, a root-relative path selects an API prefix, and an absolute URL selects another origin. |
| `eventTransport` | Optional `auto`, `websocket`, or `sse`; defaults to `auto`. A [Service Worker](https://developer.mozilla.org/docs/Web/API/Service_Worker_API) host requires `sse` because WebSocket upgrades do not reach its fetch listener. |
| `token` | Optional bearer token held in the client's memory. |
| `headers` | Optional string-valued request headers. An explicit authorization header takes precedence over `token`. |
| `assetBase` | Validated configuration data for host asset handling. The client does not use it to rewrite asset URLs. |

Dynamic-source diagnostics belong to the engine process answering the request. Pin the console to a stable engine endpoint or route its configured headers consistently when inspecting that process's loading state. An unpinned load balancer can return different engines' state, and the response does not identify the engine. Durable catalog installation and process-local load history have different lifetimes.

The interface enables controls according to the principal's scopes. The Weft server remains responsible for authorizing each operation; a disabled control is not an authorization boundary.

## Development

From `packages/weft`, run:

```bash
bun run lint
bun run typecheck
bun run test
bun run test:coverage
bun run test:ui-deployment
bun run test:ui-browser
```

Each of `lint`, `typecheck`, `test`, and `test:coverage` covers the engine and the UI together:

- `test` runs the engine's suite under `bunfig.toml`, then the UI's under `bunfig.ui.toml`, whose preload installs happy-dom and the Svelte compile plugin (`scripts/lib/svelte-plugin.ts`, a copy of `@lostgradient/testing`'s that a root drift check keeps identical).
- `test:coverage` runs the engine's 100% adjusted-coverage gate, then the UI's ratchet against the floors in `scripts/ui-coverage/coverage-baseline.ts`.
- `typecheck` runs `tsc` for the engine and `svelte-check` against `tsconfig.ui.browser.json` (browser source) and `tsconfig.ui.json` (source, tests, and tooling).
- `lint` runs oxlint for the engine under Weft's own configuration and for the UI under the root browser policy, then Weft's custom checks.

`bun run dev:ui-server` starts the seeded Weft API through Weft's `dashboard()`, so port 7233 also serves a snapshot of the console, compiled once into `scripts/ui-browser/build/dashboard/` (delete that directory to recompile it). `bun run dev:ui-browser` builds the real Svelte source with Bun and serves it with API, JSON-RPC, SSE, and WebSocket forwarding. The browser build is a development artifact.

From the Corvidae root, use `bunx turbo run lint typecheck test --filter=@lostgradient/weft` for Weft and its UI, or `bun run validate` for all workspaces.
