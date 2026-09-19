# @corvidae/weft-ui

Private [Svelte](https://svelte.dev/) components and client helpers for the [Weft](../../packages/weft/README.md) operator console. The library owns the interface for workflows, human reviews, workers, schedules, storage, and system diagnostics. Browser tooling and the seeded test host live under `scripts/browser`.

## Workspace usage

Declare `"@corvidae/weft-ui": "workspace:*"` in the consuming workspace's dependencies. Install from the Corvidae root with `bun install --frozen-lockfile`; shared external versions come from the root Bun catalog.

The only package entry point exports the console and its client configuration helpers:

```ts
import {
  WeftConsole,
  createClient,
  readRuntimeConfig,
  provideClient,
  getClient,
  setApiKey,
} from '@corvidae/weft-ui';
```

`WeftConsole` is the browser application shell. It reads runtime configuration, creates the HTTP client, resolves the current principal, and presents API-key entry when authentication is required. Its root import includes the shared interface styles. Application tooling compiles the TypeScript and Svelte source directly.

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

From `components/weft-ui`, run:

```bash
bun run lint
bun run typecheck
bun run test
bun run test:deployment
bun run test:browser
```

`bun run dev:server` starts the seeded Weft API. `bun run dev:browser` builds the real Svelte source with Bun and serves it with API, JSON-RPC, SSE, and WebSocket forwarding. The browser build is a development artifact; the library remains direct-source and has no publishing contract.

From the Corvidae root, use `bunx turbo run lint typecheck test --filter=@corvidae/weft-ui` for this library or `bun run validate` for all workspaces.
