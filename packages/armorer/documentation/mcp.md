# MCP Server

## Overview

Expose a Toolbox registry as a [Model Context Protocol](https://modelcontextprotocol.io/) server, with tools, resources, and prompts. Toolbox handles tool registration; MCP handles transport and protocol details.

## Prerequisites

- `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (2.1 or later) are `armorer` dependencies; nothing else to install.
- Have a registry created with `createToolbox()` and tools registered into it.

## Protocol versions

`createMCP` serves MCP protocol revision **2026-07-28** (`MCP_PROTOCOL_VERSION`) and, through the SDK's stateless legacy lane, **2025-11-25** (`MCP_LEGACY_PROTOCOL_VERSION`) — from one server factory, so both eras see the same tools, resources, and prompts. It returns an endpoint, not a single SDK server instance:

| Member | What it is |
| --- | --- |
| `fetch(request)` | The web-standard HTTP entry (`createMcpHandler(factory, { legacy: 'stateless' })`). Serves both eras on one URL. |
| `handler` | The full SDK handler (`fetch`, `close`, `notify`, `bus`). |
| `serveStdio(options?)` | Serves stdio through the SDK's `serveStdio`, pinning each connection to the era its opening message selects. |
| `createServer(ctx?)` | Builds one SDK `McpServer` instance. Connect it to a transport of your own for 2025-era serving (`await mcp.createServer().connect(t)`). |
| `executionLifecycle` | Inspects and controls the executions this endpoint owns, across every per-request instance. |
| `shutdown()` | Closes admission, aborts and settles executions (including ones waiting for client input), and returns cleanup evidence. |
| `close()` | `shutdown()`, then closes the HTTP entry, stdio entries, and instances built with `createServer`. |

The SDK builds a fresh server instance per HTTP request (and per stdio connection), so resource and prompt registrars run many times. They receive the instance and the request context (`{ era }`); keep them free of state.

## Quick start (stdio)

```typescript
import { createMCP, createTool, createToolbox } from 'armorer';
import { z } from 'zod';

const toolbox = createToolbox([
  createTool({
    name: 'sum',
    description: 'adds two numbers',
    input: z.object({ a: z.number(), b: z.number() }),
    async execute({ a, b }) {
      return a + b;
    },
  }),
]);

const mcp = await createMCP(toolbox, {
  serverInfo: { name: 'toolbox-tools', version: '0.1.0' },
});

await mcp.serveStdio();
```

## Streamable HTTP

`mcp.fetch` is a web-standard `(Request) => Promise<Response>` handler, so it plugs straight into Bun, Deno, and Workers. On Node frameworks, wrap `mcp.handler` with `toNodeHandler` from `@modelcontextprotocol/node`.

```typescript
import { createMCP, type AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

const mcp = await createMCP(toolbox, {
  serverInfo: { name: 'toolbox-tools', version: '0.1.0' },
});

Bun.serve({ port: 3000, fetch: (request) => mcp.fetch(request) });
```

Pass `http` to configure the entry (`responseMode`, `maxRequestBodySize`, `onerror`, and so on); `legacy` is always `'stateless'`. Cache hints for `tools/list` and other cacheable results go in the ordinary SDK `cacheHints` server option; the SDK client honors them, so Armorer keeps no tool-list cache of its own.

The stateless 2025 lane has limits that come from the lane, not from Armorer: it never sees the `initialize` handshake, so tools there get no client information or capabilities and no `context.elicit`, and a `notifications/cancelled` lands on a fresh instance that does not own the running call. Serve 2025 clients over stdio (`serveStdio`) when they need elicitation or cancellation.

## What a tool sees

Each call runs under an execution the endpoint owns. The tool receives:

- `context.signal` — aborted when the client cancels (on 2026-07-28, by closing the request's response stream; on a sessionful 2025 connection, by `notifications/cancelled`), on shutdown, or when an unanswered input round expires.
- `context.executionContext.mcp` — an `MCPRequestExecutionContext`: `era`, `method`, `requestId`, and, where the protocol supplies them, `protocolVersion`, `clientInfo`, `clientCapabilities`, and the W3C `trace` carrier (`traceparent`, `tracestate`, `baggage`) from the request's `_meta`. MCP defines no request deadline, so none is reported.
- `context.traceContext` — an OpenTelemetry `Context` extracted from that carrier with the globally registered propagator, when the request carried a `traceparent`.
- `context.elicit` — present when the client declared the `elicitation` capability (see below).
- `context.progress(...)` — forwarded to the client as MCP progress when the client asked for it (see below).

## Progress

When a request carries a `progressToken` (the SDK client adds one when you pass `onprogress`), each `context.progress({ percent, message })` the tool reports is sent as `notifications/progress`: a percent becomes `{ progress: percent, total: 100 }`. MCP requires progress to increase, so a percent that does not advance is dropped; message-only updates count up until the tool first reports a percent. A request without a token gets no progress notifications.

In the client direction, `fromMcpTools` passes an `onprogress` callback to `callTool` and turns each notification into an Armorer progress event (`percent` from `progress / total`, the raw notification as `checkpoint`). Pass `progress: false` to request none. During a 2026-07-28 `input_required` exchange the SDK client also reports its own "fulfilling input" progress through the same callback, and those updates reach the tool too.

## Elicitation and multi-round input

On a **2025-11-25** connection, `context.elicit(...)` sends a push-style `elicitation/create` to the client and awaits its answer within the same call.

On **2026-07-28** the protocol has no server-to-client request channel: a handler that needs input returns an `input_required` result and the client retries the call with the answer. Armorer keeps tools written the same way for both eras by suspending the execution: when the tool calls `context.elicit(...)`, the endpoint answers the round with `input_required` while the tool keeps waiting, and the retry hands the answer to that same execution. The tool body runs once, so nothing before or after the question is repeated.

- The retry is matched by a `requestState` sealed with HMAC under a per-endpoint key and bound to the tool, the round, and the authenticated client (`authInfo.clientId`) when there is one. A tampered or expired state is rejected by the SDK before the tool runs.
- Each round is claimed once. A duplicate or stale retry gets an error result and does not touch the execution; a retry that carries no answer re-issues the same round.
- An unanswered round expires after `inputRounds.ttlMs` (ten minutes by default), which aborts the execution.
- Because the execution lives in memory, every round of a flow must reach the same process.
- A tool can wait for one elicitation at a time.

Accepted form answers are validated against the requested schema in both eras before the tool sees them. The schema is converted as JSON Schema 2020-12, so constraints such as `pattern`, `minimum`, `format` and `enum` are enforced, and a schema that cannot be enforced (a remote `$ref`, for example) rejects the answer instead of letting it through.

## MCP tasks

A tool can run as an *MCP task*, the 2026-07-28 Tasks extension (`io.modelcontextprotocol/tasks`): `tools/call` returns a handle right away and the client polls `tasks/get` until the result is ready, answers questions with `tasks/update`, and stops the work with `tasks/cancel`. An MCP task is unrelated to Armorer's own execution tasks (`createExecutionTask`); the name always carries the "MCP".

Opting in is per tool, with `taskBacked: true` in `metadata.mcp` or in what the `toolConfiguration()` callback returns. The default stays synchronous, and `createMCP` needs a durable store for the records:

```typescript
import { createMCP, createTool, createToolbox, type MCPTaskStore } from 'armorer';
import { z } from 'zod';

declare const taskStore: MCPTaskStore;

const report = createTool({
  name: 'render-report',
  description: 'renders a long report',
  input: z.object({ title: z.string() }),
  metadata: { mcp: { taskBacked: true } },
  async execute({ title }, context) {
    context.progress({ message: 'rendering' });
    return `report: ${title}`;
  },
});

const mcp = await createMCP(createToolbox([report]), {
  taskStore,
  tasks: { ttlMs: 600_000, pollIntervalMs: 1_000 },
});
```

What a client sees:

- `createMCP` rejects at construction, naming the tool, when a tool opts in and no `taskStore` is given. There is no in-memory default.
- `server/discover` lists the extension only when at least one tool opts in, merged with any `capabilities.extensions` you supply. A 2025-11-25 `initialize` never lists it.
- Only a 2026-07-28 client that declares the extension gets a handle. A 2025-11-25 client, a 2026-07-28 client that does not declare it, and a tool that did not opt in all get the synchronous result, and `tasks/get` is method-not-found on 2025-11-25. `toMcpTools` never serves MCP tasks, so it runs an opted-in tool synchronously.
- The handle is returned only after the record has been committed to the store. If the store fails or refuses the create, `tools/call` answers `-32603` and the tool never starts.
- A tool that returns or throws ends `completed`, with the same `result` the synchronous path sends (a throw is `isError: true`). `failed` is reserved for JSON-RPC errors: a shutdown or an orphan.
- `context.progress({ message })` becomes the record's `statusMessage`; no notifications are sent.
- `context.elicit(...)` moves the MCP task to `input_required` with one `elicitation` input request. `tasks/update` with that key delivers the answer into the same suspended execution, so the tool body runs once. A `tasks/update` without the key leaves the MCP task `input_required`.
- `tasks/cancel` aborts `context.signal` and ends `cancelled`. Cancelling a finished MCP task is an empty acknowledgement.
- `ttlMs` (default ten minutes) counts from creation. When it passes, the execution is aborted, the record is deleted, and the id reads as unknown. `pollIntervalMs` (default one second) is the interval advertised to clients. `tasks.now` replaces the clock used for `createdAt` and `lastUpdatedAt`.
- Ids are random bearer tokens and each record is bound to the creating `authInfo.clientId` (or the empty string). An unknown, expired, or other-client id answers `-32602` with the same message on all three methods.
- The extension defines no `tasks/list`, and `notifications/tasks` over `subscriptions/listen` is not implemented.

#### One live instance per store

The store is durable but the executions are not: they run in the process that created them. A store therefore belongs to **one live `createMCP` instance**. Every record carries an `ownerId` that is random per instance. After a restart (or when a second instance reads the store), a non-terminal record owned by another id is an orphan: nothing can finish, cancel, or answer it, so the first `tasks/get`, `tasks/update`, or `tasks/cancel` that reads it records it as `failed` with `-32603`. `tasks/get` returns that record; `tasks/update` and `tasks/cancel` acknowledge with an empty result. An interrupted execution is never re-run, and a late settle from an old instance loses its compare-and-set.

Records are JSON at `mcp-task:<taskId>` with `version: 1`; a record with any other version makes `tasks/get`, `tasks/update`, and `tasks/cancel` answer `-32603`. Every write is a `conditionalBatch` on the value last read, so a terminal status is written once.

`MCPTaskStore` is a subset of Weft's `ConditionalTextValueStore` (`get`, `set`, `delete`, `list(prefix)`, `conditionalBatch`), so `textValueStore(...)` from `@lostgradient/weft` is assignable to it with no adapter.

#### Consuming MCP tasks

The SDK 2.4 client rejects a task handle, so `fromMcpEndpointTools` sends raw 2026-07-28 JSON-RPC through an authenticated `fetch`. It lists the tools and returns Armorer tools whose calls declare the extension:

```typescript
import { fromMcpEndpointTools } from 'armorer';

declare const authenticatedFetch: (input: string, init: RequestInit) => Promise<Response>;

const tools = await fromMcpEndpointTools({
  url: 'https://tools.example.com/mcp',
  fetch: authenticatedFetch,
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
});
```

A `complete` answer passes through. A task handle is polled with `tasks/get`, waiting `delay(pollIntervalMs)` between polls, until it resolves to the final result, so the caller just awaits `execute`. An `input_required` MCP task is answered through the calling tool's `context.elicit`. Aborting the call's signal sends `tasks/cancel`. A remote `failed` or `cancelled` status, or a JSON-RPC error such as `-32602` mid-poll, rejects with a message naming the status or code. A synchronous `input_required` answer throws `MCPInputRequiredUnsupportedError`; use `fromMcpClientTools` for those tools.

### Tool metadata mapping

You can declare MCP-specific metadata on tools. `createMCP` reads `metadata.mcp` by default.

```typescript
import { createTool } from 'armorer';
import { z } from 'zod';

const status = createTool({
  name: 'status',
  description: 'reports status',
  input: z.object({}),
  metadata: {
    mcp: {
      title: 'Status Tool',
      annotations: { readOnlyHint: true },
      meta: { source: 'toolbox' },
    },
  },
  async execute() {
    return { ok: true };
  },
});
```

You can override or extend this with `toolConfiguration`:

```typescript
import { createMCP, type AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

const mcp = await createMCP(toolbox, {
  toolConfiguration: (tool) => ({
    title: tool.name.toUpperCase(),
  }),
});
```

#### Tool configuration precedence

`toolConfigurationFromMetadata` reads `tool.metadata.mcp`, then `toolConfiguration` overrides any overlapping fields. The effective MCP tool configuration is:

1. `metadata.mcp` (if present and valid)
2. `toolConfiguration(tool)` (overrides any fields from metadata)
3. Runtime defaults: `description` and `input` fall back to the tool definition

If `meta` is set by either configuration, it is exposed as `_meta`. When no `meta` is set, the tool's `metadata` object is used as `_meta` (if it's a plain object).

### Result formatting

By default, tool results are returned as:

- `content`: text (stringified result)
- `structuredContent`: only when the tool returns a plain object

You can customize this with `formatResult`:

```typescript
import { createMCP, type AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

const mcp = await createMCP(toolbox, {
  formatResult: (result) => {
    if (result.outcome === 'error') {
      const message = typeof result.error === 'string' ? result.error : result.error?.message;
      return {
        content: [{ type: 'text', text: message ?? 'Error' }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { data: result.result },
    };
  },
});
```

A tool that returns `toolContent(parts, { value })` has each part sent as the matching MCP block, in order, with `value` as `structuredContent`: a text part as `text`; an inline base64 image or audio part as `image` or `audio`; any other inline part, and any part that arrived as an embedded `resource` (even an image or audio one), as an embedded `resource` under the URI it arrived with, when it came from MCP; and an `mcp-resource` or `remote-url` part as a `resource_link`. A part MCP cannot carry, such as a managed asset, fails the call rather than sending a placeholder. A tool that returns MCP content blocks directly (an array of `text`, `image`, `audio`, `resource`, or `resource_link` blocks, or a `{ content, structuredContent }` object) has them sent as blocks, in order, instead of serialized into text.

Thrown exceptions from tool execution are converted into MCP errors with a text payload.

### Resources and prompts

Register additional MCP resources and prompts via registrars. Each runs once per server instance the SDK builds and receives the request context as a second argument:

```typescript
import { createMCP, type AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

const mcp = await createMCP(toolbox, {
  resources: (server, { era }) => {
    server.registerResource('readme', 'toolbox://readme', { title: 'README' }, async () => ({
      contents: [{ uri: 'toolbox://readme', text: 'hello' }],
    }));
  },
  prompts: (server) => {
    server.registerPrompt('hello', { description: 'say hello' }, async () => ({
      messages: [{ role: 'assistant', content: { type: 'text', text: 'hello' } }],
    }));
  },
});
```

You can pass a single registrar or an array of registrars:

```typescript
import {
  createMCP,
  type AnyToolbox,
  type MCPPromptRegistrar,
  type MCPResourceRegistrar,
} from 'armorer';

declare const toolbox: AnyToolbox;
declare const registerDocs: MCPResourceRegistrar, registerSchemas: MCPResourceRegistrar;
declare const registerAssistantPrompts: MCPPromptRegistrar;

const mcp = await createMCP(toolbox, {
  resources: [registerDocs, registerSchemas],
  prompts: [registerAssistantPrompts],
});
```

### Tool updates

`createMCP` reads the toolbox's available tools once, when it is created. Create a new endpoint after building a toolbox with a different set of tools.

## Conversion helpers

- `toMcpTools(input, options?)` converts Toolbox tools to MCP tool definitions with handlers. A caller that owns its own SDK server passes `clientSession` (capabilities, client information, negotiated version) so 2025-era requests know whether the client can elicit; without it, a 2025-era request keeps exposing `context.elicit`. `executeTool(tool, request)` receives an `MCPToolExecutionRequest`.
- `fromMcpTools(tools, options?)` converts MCP tool definitions back into executable Toolbox tools. `callTool(request, { signal, onprogress })` performs each call. `fromMcpClientTools(client, options?)` wires that to a connected SDK `Client`, so tool-list caching, `Mcp-Method`/`Mcp-Name` headers, and `input_required` retries stay with the SDK.

Results keep their content blocks in both directions: a remote result with any non-text block reaches the caller as `toolContent`, one ordered part per block (an image or audio block becomes an inline base64 part, an embedded resource an inline part typed by its MIME type, and a `resource_link` an `mcp-resource` part that references the `serverId` you pass to `fromMcpTools` or `fromMcpClientTools`; without a `serverId` such a result is rejected), with any structured content as its value. A `resource_link`'s `title`, `description`, `size`, `annotations`, `icons`, and `_meta` ride on the part's `metadata` and come back out on the link. A text-only result with structured content returns the structured value, and plain text is parsed as JSON when it holds JSON.

An `isError` result throws. When it holds only text, the thrown error carries the text. When it also holds a non-text block, the throw is a `ToolResultError` (exported from `armorer/protocol`) whose `content` has every block as an ordered part: the settled error result then has those parts on `parts` and any `structuredContent` as `content`, and serving it back over MCP sends the same blocks flagged `isError`.

A remote tool's JSON `inputSchema` is converted strictly (JSON Schema 2020-12, `MCP_JSON_SCHEMA_DIALECT`): local `$ref`/`$defs` resolve, while a remote reference, a missing definition, another `$schema` dialect, or a keyword the validator cannot enforce throws `McpToolSchemaError` instead of falling back to a schema that accepts anything. Outbound schemas are published by the SDK as JSON Schema 2020-12 and every call's arguments are validated against them.

## MCP Apps

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) lets a tool point at an interactive page. A server declares the page as a `ui://` resource and links a tool to it with `_meta.ui.resourceUri`; a host that understands MCP Apps fetches the resource and renders it in a sandbox. Armorer carries that metadata and reads the resource; it renders nothing. Rendering is the host's job (in this repository, `McpApp` in [`@lostgradient/chat`](../../../components/chat/README.md#mcp-apps)).

- **Importing keeps `_meta` whole.** `fromMcpTools` and `fromMcpClientTools` preserve a remote tool's `_meta`, including `_meta.ui`, unchanged under `tool.metadata.mcp.meta`. `toMcpTools` and `createMCP` write it back out as the tool's `_meta`, so a tool imported from one server and served from another still points at its page.
- **`mcpUiResourceUri(source)`** returns the `ui://` URI a tool declares, from an imported `Tool` or a raw `_meta` record: `_meta.ui.resourceUri` first, then the deprecated `_meta["ui/resourceUri"]`. It returns `undefined` when there is none or when the value is not a `ui://` URI.
- **`readUiResource(client, uri)`** reads a `ui://` resource through any client with `readResource` (an SDK `Client` qualifies). It rejects a URI that is not `ui://` before any request goes out, a response without a content item for that URI, and a content item whose MIME type is not `text/html;profile=mcp-app`. The result carries the `html`, the resource's `_meta.ui` (declared CSP and permissions) as `ui`, and the whole `_meta` as `meta`. When the client also offers `listResources`, the listing entry's `_meta.ui` is merged under the content item's, field by field, with the content item winning, as the MCP Apps specification orders them.

```typescript
import { Client } from '@modelcontextprotocol/client';
import { fromMcpTools, mcpUiResourceUri, readUiResource } from 'armorer';

declare const client: Client;

const { tools } = await client.listTools();
const imported = fromMcpTools(tools, { callTool: (request) => client.callTool(request) });

for (const tool of imported) {
  const uri = mcpUiResourceUri(tool);
  if (uri === undefined) continue;
  const app = await readUiResource(client, uri);
  console.log(tool.name, app.mimeType, app.ui?.csp, app.html.length);
}
```

What Armorer does not do for MCP Apps: it does not render a page, enforce the declared CSP or permissions (the host's sandbox does), proxy an app's `tools/call`, or serve `ui://` resources from `createMCP` (an application registers those through the `resources` registrar described under [Resources and prompts](#resources-and-prompts)). `readUiResource` reads only `ui://` URIs and only the MCP Apps media type.

## OAuth client support

When connecting to an MCP server that requires authorization, `armorer` provides an `OAuthClientProvider` implementation and thin connection orchestration on top of `@modelcontextprotocol/client` (PKCE, RFC 9728/8414 discovery, dynamic client registration, token refresh, and `StreamableHTTPClientTransport`). This module never persists anything itself—you supply a `McpOAuthTokenStorage` hook (in-memory, a database row, an encrypted session, and so on) and it reads/writes exclusively through that interface.

```typescript
import {
  completeMcpOAuthAuthorization,
  connectMcpClientWithOAuth,
  createInMemoryMcpOAuthTokenStorage,
  createMcpOAuthProvider,
  fromMcpClientTools,
  isMcpUnauthorizedError,
} from 'armorer';

declare const receivedCallbackUrl: string; // the URL your OAuth callback route received

const tokenStorage = createInMemoryMcpOAuthTokenStorage(); // swap for durable storage in production

const provider = createMcpOAuthProvider({
  redirectUrl: 'https://my-app.example.com/oauth/callback',
  clientMetadata: {
    client_name: 'my-app',
    redirect_uris: ['https://my-app.example.com/oauth/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  tokenStorage,
  onAuthorizationRequired(authorizationUrl) {
    // Send the resource owner here (redirect an HTTP response, open a webview, ...).
    // This module never navigates or opens a browser itself.
  },
});

try {
  const client = await connectMcpClientWithOAuth({
    serverUrl: 'https://mcp.example.com',
    provider,
  });
  const tools = await fromMcpClientTools(client);
} catch (error) {
  if (!isMcpUnauthorizedError(error)) throw error;
  // Authorization is required — onAuthorizationRequired already fired above.
}

// After the resource owner is redirected back to `redirectUrl?code=...&state=...&iss=...`:
await completeMcpOAuthAuthorization(provider, {
  serverUrl: 'https://mcp.example.com',
  callbackUrl: receivedCallbackUrl, // the full redirect URL
  tokenStorage,
});
// Now retry connectMcpClientWithOAuth(...) — it will use the newly saved tokens.
```

`connectMcpClientWithOAuth` negotiates with `versionNegotiation: { mode: 'auto' }` by default: it probes for 2026-07-28 with `server/discover` and falls back to the 2025-11-25 `initialize` handshake against a server that does not offer it. Pass `clientOptions.versionNegotiation` to pin (`{ mode: { pin: '2026-07-28' } }`) or to skip the probe (`{ mode: 'legacy' }`). The OAuth flow itself is the SDK's and applies on both eras.

`completeMcpOAuthAuthorization` validates the redirect's `iss` parameter per [RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207) against the issuer recorded during discovery — guarding against authorization-server mix-up attacks — before ever exchanging the authorization code for tokens. This is implemented against the MCP Authorization spec base revision [2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), plus the RFC 9207 issuer-validation requirement from the [current draft revision](https://modelcontextprotocol.io/specification/draft/basic/authorization#authorization-response-validation).

## Agent SDK integrations

Agent SDK integration examples are documented in [Agent SDK Integrations](./agent-sdk-integrations.md), including:

- OpenAI Agents SDK via MCP (`stdio` and Streamable HTTP)
- Guidance on when to use MCP vs direct OpenAI Agents adapter

## No dependence on MCP sampling or roots

`createMCP` only exposes Toolbox tools (and, optionally, resources/prompts) as an MCP server — it never establishes an MCP client session against a host and never requests `sampling/createMessage` or `roots/list`. `fromMcpTools` does interoperate with MCP tool definitions (turning them into executable Toolbox tools via a caller-supplied `callTool`), but that's a one-shot `tools/call` invocation, not a client session that could negotiate sampling or roots capabilities — those two capabilities are never used anywhere in `armorer`. This is intentional, not an oversight:

- **Sampling** (`sampling/createMessage`) lets an MCP server ask the connected client's host to run an LLM completion on its behalf. Armorer's tools call out to LLM providers directly (via `conversationalist`/provider adapters) rather than routing through a host's sampling capability — there's no reason for a tool to depend on whether the MCP client it's connected to happens to support sampling.
- **Roots** (`roots/list`) lets a server ask the client which filesystem/workspace roots it should operate within. Armorer's filesystem-touching tools (e.g. the coding toolbox) take paths as explicit tool input or configuration, validated by the tool itself, instead of discovering them through an MCP root negotiation.

Both capabilities are on a deprecation path in the MCP specification's draft revision (tracked upstream via SEP-2577). If you need an agent to call an LLM, use a provider SDK or `conversationalist`'s adapters directly — do not build a dependency on MCP sampling. If a tool needs to know which paths it may touch, pass that in as tool input/configuration — do not build a dependency on MCP roots.
