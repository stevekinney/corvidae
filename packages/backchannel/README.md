# Backchannel

`@lostgradient/backchannel` is the transport-neutral operation layer that Weft, Bureau and Interborough share. An operation is defined once, with its input and output schemas, its access policy and the faults it can raise. The layer then serves it over REST, JSON-RPC (HTTP, WebSocket and stdio) and Server-Sent Events, and generates its OpenAPI, OpenRPC and AsyncAPI documents from the catalog. It imports no Bun or Node API, so any host that can hand it a `Request`, a socket or a pair of streams can serve a catalog.

## Workspace usage

Declare `"@lostgradient/backchannel": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install`. The package exports TypeScript source directly and has no build or publication step.

## Entries

- `@lostgradient/backchannel` is the public surface: `defineOperation`, `createOperationHandler`, the fault model, principals and authorization scopes, the authentication helpers, the replay-and-live feed and the document generators.
- `@lostgradient/backchannel/internals` is the plumbing a host needs: the dispatch pipeline, the transport sessions and the route model. It is unstable. A name there may change or move without notice.
- `@lostgradient/backchannel/testing` is test support shared with the packages that build on the layer.

## How It Works

`defineOperation` builds an operation from a Zod input and output schema. `createOperationHandler` takes a list of operations and the `host` they read, and returns a fetch handler with `upgrade` and `websocket` properties for a host that can accept a WebSocket. The handler owns authentication, access policy, fault mapping, cursor replay, CORS and the discovery documents. The host supplies what the layer does not know: a `FaultPolicy` for its own error classes and its strict-fault setting, the title and version of its documents, and an encoder if it serves MessagePack.

Weft hosts its engine's operations on the layer, and Bureau serves its own through `createBureauHandler`.
