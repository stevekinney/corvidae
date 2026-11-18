# Backchannel

`@lostgradient/backchannel` is the transport-neutral operation layer that Weft, Bureau and Interborough share. An operation is defined once, with its input and output schemas, its access policy and the faults it can raise. The layer then serves it over REST, JSON-RPC (HTTP, WebSocket and stdio) and Server-Sent Events, and generates its OpenAPI, OpenRPC and AsyncAPI documents from the catalog. It imports no Bun or Node API, so any host that can hand it a `Request`, a socket or a pair of streams can serve a catalog.

## Workspace usage

Declare `"@lostgradient/backchannel": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install`. The package exports TypeScript source directly and has no build or publication step.

## Entries

- `@lostgradient/backchannel` is the public surface: `defineOperation`, `createOperationHandler`, the fault model, principals and authorization scopes, the authentication helpers, the replay-and-live feed and the document generators.
- `@lostgradient/backchannel/client` is the browser-safe client: `createCatalogClient`, the `CatalogTransport` seam and `CatalogClientError`, the JSON-RPC HTTP transport (`httpJsonRpcTransport`), the subscription client (`createSubscriptionClient`) with its Server-Sent Events transport (`sseSubscriptionTransport`), and the chunk parser. Every call takes an optional `{ signal, fetch }` second argument. A subscription method returns an `AsyncIterable` of `{ type: 'event', id, data }` and one `{ type: 'replay-complete' }`, and takes `lastEventId` to resume.
- `@lostgradient/backchannel/generator` generates a typed client for any operation catalog: `createOperationClientSources(snapshot, options)` returns the files as a map from file name to source, and the caller passes its own formatter. It may import `node:` modules; the other entries may not.
- `@lostgradient/backchannel/internals` is the plumbing a host needs: the dispatch pipeline, the transport sessions and the route model. It is unstable. A name there may change or move without notice.
- `@lostgradient/backchannel/testing` is test support shared with the packages that build on the layer.

## How It Works

`defineOperation` builds an operation from a Zod input and output schema. `createOperationHandler` takes a list of operations and the `host` they read, and returns a fetch handler with `upgrade` and `websocket` properties for a host that can accept a WebSocket. The handler owns authentication, access policy, fault mapping, cursor replay, CORS and the discovery documents. The host supplies what the layer does not know: a `FaultPolicy` for its own error classes and its strict-fault setting, the title and version of its documents, and an encoder if it serves MessagePack.

## Example

This defines one operation and serves it with `createOperationHandler`. The handler is a function from `Request` to `Response`, so the example calls it directly over JSON-RPC at `/jsonrpc`; a host would pass the same function to its server.

```ts
import { createOperationHandler, defineOperation } from '@lostgradient/backchannel';
import { z } from 'zod';

const echo = defineOperation({
  name: 'probe.echo',
  mcpExposable: false,
  summary: 'Echo a message',
  destructive: false,
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  access: { kind: 'public' },
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input }) => ({ message: input.message }),
});

const handler = createOperationHandler({ operations: [echo], host: {} });

const response = await handler(
  new Request('http://localhost/jsonrpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'probe.echo',
      params: { message: 'hello' },
    }),
  }),
);
console.log(await response.json()); // { jsonrpc: '2.0', result: { message: 'hello' }, id: 1 }
```

Weft hosts its engine's operations on the layer, and Bureau serves its own through `createBureauHandler`.
