# A2A (`@lostgradient/weft/a2a`)

`@lostgradient/weft/a2a` serves an agent over the [A2A protocol](https://a2a-protocol.org/) 1.0.1 on top of the official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js). `createA2AHandler(options)` returns a fetch-style `(request: Request) => Promise<Response>` that serves JSON-RPC (unary and streaming) and the public Agent Card for an `A2ARequestHandler` you supply, typically the SDK's `DefaultRequestHandler`.

The kit owns the HTTP edge: routing, authentication, protocol-version and tenant checks, body limits, Server-Sent Events, the Agent Card's interface list, its caching, and its signature. The SDK owns the protocol: its `JsonRpcTransportHandler` decodes each request and calls your request handler.

The subpath does not use the `Bun` global, so it runs anywhere `Request`, `Response`, `ReadableStream`, and WebCrypto exist.

## Installation

`@a2a-js/sdk` is an optional peer dependency of Weft, pinned to exactly `1.3.0`. Install that version beside Weft to use this subpath; nothing else in Weft loads it.

```sh
bun add @a2a-js/sdk@1.3.0
```

## Serving an agent

```ts partial
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { createA2AHandler, securitySchemesFromAuthConfig } from '@lostgradient/weft/a2a';

declare const executor: AgentExecutor;

const agentCard: AgentCard = {
  name: 'Support Agent',
  description: 'Answers questions about orders.',
  supportedInterfaces: [],
  provider: undefined,
  version: '1.0.0',
  capabilities: { streaming: true, pushNotifications: false, extensions: [] },
  ...securitySchemesFromAuthConfig({ apiKeys: [process.env['A2A_API_KEY'] ?? ''] }),
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [],
  signatures: [],
};

const handler = createA2AHandler({
  requestHandler: new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor),
  agentCard,
  publicUrl: 'https://agents.example.com/support',
});

Bun.serve({ fetch: handler });
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `requestHandler` | required | The SDK `A2ARequestHandler` that serves every JSON-RPC method. |
| `agentCard` | required | The public Agent Card. The kit replaces its `supportedInterfaces` and `signatures`. |
| `publicUrl` | required | The JSON-RPC endpoint's public URL, and the only source of the card's interface URL. Nothing is derived from the request, matching Weft's `publicOrigin` rule. |
| `discoveryUrl` | `publicUrl` | The base of the discovery URLs: the card's `jku` is `${discoveryUrl}/.well-known/jwks.json`. Set it when discovery is served from another listener, such as one that requests no client certificate in an mTLS deployment. |
| `tenant` | unset | A deployment identifier, published as the card interface's `tenant` and set as `ServerCallContext.tenant`. |
| `authenticate` | anonymous | `(request) => User \| Response` (or a promise of either). The returned SDK `User` becomes `context.user`; a returned `Response`, such as a `401`, is sent unchanged. Without it every JSON-RPC request is served as the SDK's `UnauthenticatedUser`. |
| `signing` | unset | `{ privateKey: CryptoKey, kid: string, alg: 'ES256' \| 'EdDSA' }`. Signs the card and serves the public key. |
| `maxRequestBodyBytes` | 1 MiB | The largest JSON-RPC body accepted, as in Weft's REST and JSON-RPC transports. A larger body gets `413`. |
| `maxStreamDurationMs` | 900000 | How long an SSE response stays open (fifteen minutes). |

## Routes

Routes are relative to the mount. The handler matches the two discovery documents by their path suffix and treats every other path as the JSON-RPC endpoint, so it works whether or not the host strips its mount prefix.

| Route | Credentials | Serves |
| --- | --- | --- |
| `GET /.well-known/agent-card.json` | none | The public Agent Card. |
| `GET /.well-known/jwks.json` | none | The card-signing public key as a JWKS, only when `signing` is set. |
| `POST /` (and every other route) | `authenticate` | JSON-RPC. Any method other than `POST` gets `405` after authentication. |

## JSON-RPC

A request passes through these steps in order, and the first that fails answers it:

1. `authenticate`. A returned `Response` is sent unchanged.
2. The HTTP method: anything other than `POST` gets `405` with `Allow: POST`.
3. `Content-Type`. A request without one is accepted; one naming any media type other than `application/json` gets a JSON-RPC `ContentTypeNotSupportedError` (`-32005`) with a `null` id, as the SDK's own HTTP adapter answers.
4. The body, read up to `maxRequestBodyBytes`: a declared or streamed body beyond it gets `413`; a body stream that fails gets `400`. A body that is not JSON gets the JSON-RPC parse error (`-32700`) with a `null` id.
5. `A2A-Version`. Only `1.0` is served. Any other value, including an empty or absent header, gets a JSON-RPC `VersionNotSupportedError` (`-32009`).
6. The request's `params.tenant`, described below.
7. The SDK's `JsonRpcTransportHandler`, with a `ServerCallContext` built by the SDK's `defaultServerCallContextBuilder`. Its `user` is the result of `authenticate`, its `state` holds every request header under `STATE_HEADERS_KEY` (so a request handler can read `last-event-id` and `traceparent`), and its requested extensions come from the `A2A-Extensions` request header.

A unary result is a `200` `application/json` response. JSON-RPC errors, including the ones the kit raises in steps 3 through 6, are also `200` responses carrying an `error` envelope, as JSON-RPC prescribes. The response's `A2A-Extensions` header lists the extensions the request handler activated with `context.addActivatedExtension(uri)`.

### Tenant

The mount the handler is served at selects the agent; `tenant` only identifies the deployment. The kit sets `ServerCallContext.tenant` from the option, never from the request:

- A request without `params.tenant` (or with the protobuf default, an empty string) is served.
- A request naming the configured tenant is served.
- A request naming any other tenant gets `RequestMalformedError`, and so does any request that names a tenant when the option is unset.

## Streaming

`SendStreamingMessage` and `SubscribeToTask` answer with `text/event-stream`. Each event's `data:` is exactly one JSON-RPC response object, written with Weft's `formatServerSentEvent`. The kit waits for the stream's first event before committing to SSE, so an error raised before it (for example, streaming against a card without `capabilities.streaming`) is answered as an ordinary JSON-RPC error response, and extensions the first event activates still reach the response header. An error raised later ends the stream with one final event holding the error response.

### Durable cursors

To let a client resume with `Last-Event-ID`, tag each event your request handler yields with its durable cursor:

```ts partial
import type { StreamResponse } from '@a2a-js/sdk';
import { withStreamEventCursor } from '@lostgradient/weft/a2a';

async function* replay(events: AsyncIterable<{ cursor: string; event: StreamResponse }>) {
  for await (const { cursor, event } of events) yield withStreamEventCursor(event, cursor);
}
```

A cursor containing a carriage return, line feed, or NUL cannot be an SSE `id`, so `withStreamEventCursor` throws a `TypeError` for one. The kit writes a tagged event's cursor as its SSE `id:` and writes no `id:` for an untagged one. The SDK's transport handler converts each yielded event into a new JSON-RPC response object, so the tag cannot ride on the event itself. Instead the kit wraps your request handler's streaming methods: the wrapper records one entry per yielded event, holding its cursor or none, and the SSE writer takes one entry per response, in order. The conversion is one response per event, in order, in `@a2a-js/sdk@1.3.0`.

### Stream duration

Every SSE response closes after `maxStreamDurationMs` with a final comment line (`: stream closed after … ms; reconnect to continue`). A client that wants to keep following the task must reconnect, with `SubscribeToTask` and the last cursor it saw as `Last-Event-ID`, and that request goes through `authenticate` again, so a revoked credential stops receiving events within that bound. The close is not a terminal task event, and the `@a2a-js/sdk@1.3.0` client does not reconnect on its own: its `sendMessageStream` and `resubscribeTask` iterators simply end, so the caller resubscribes. Raise `maxStreamDurationMs` for tasks whose subscriptions should outlast the default. When the client disconnects, or the duration runs out, the kit returns the request handler's stream, which stops at its next event.

## Agent Card

The served card is your `agentCard` with exactly one interface: `{ url: publicUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant }`, with `tenant` omitted when the option is unset. It is built (and signed) once per handler and served with:

- `ETag`: a strong validator, the SHA-256 digest of the card's [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) serialization (signatures included).
- `Cache-Control: public, max-age=300`.
- `304 Not Modified` for a matching `If-None-Match`.

### Signing

With `signing`, the card carries one signature from the SDK's `generateAgentCardSignature`. Its protected header holds `alg`, `kid`, `typ: "JOSE"`, and `jku: ${discoveryUrl}/.well-known/jwks.json`, and that route serves the public key as a JWKS (`kid`, `alg`, and `use: "sig"`, no private members). A client can verify the card with the SDK's `verifyAgentCardSignature` using only that JWKS.

WebCrypto derives the public key only by exporting the private one, so `privateKey` must be created with `extractable: true`. It must also be the private key `alg` names: an ECDSA P-256 key for `ES256`, an Ed25519 key for `EdDSA`. `createA2AHandler` throws for a key that is not, so no other key's members can reach the JWKS, which publishes only `kty`, `crv`, `x`, and (for P-256) `y`.

```ts partial
const { privateKey } = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);
const handler = createA2AHandler({
  requestHandler,
  agentCard,
  publicUrl: 'https://agents.example.com/support',
  signing: { privateKey, kid: 'card-2026-10', alg: 'ES256' },
});
```

## Security schemes

`securitySchemesFromAuthConfig(authConfig)` maps a Weft `AuthConfig` onto the card's `securitySchemes` and `securityRequirements` (the A2A 1.0.1 `AgentCard` field names), so the card advertises the credentials a Weft server accepts:

| `AuthConfig` | Schemes |
| --- | --- |
| `apiKeys` or `resolveApiKeyPrincipal` | `apiKeyHeader` (`apiKey` in the `X-API-Key` header) and `bearer` (`http`, scheme `bearer`) |
| `jwt` | `bearer`, with `bearerFormat: "JWT"` |
| `mtls` | `mutualTLS` |

With `mtls.rejectUnauthorized: false` and no `verifyClientCertificate`, Weft's authenticator admits no one by certificate, so the card offers no `mutualTLS` scheme for that configuration.

API keys and `jwt` together share the single `bearer` scheme. `securityRequirements` lists each scheme as its own alternative.

## Durable stores

`createWeftA2ATaskStore` and `createWeftPushNotificationStore` implement the SDK's `TaskStore` and `PushNotificationStore` over any Weft storage adapter that reports `conditionalBatch` (memory, SQLite, LMDB, PostgreSQL, and the others that do). Each factory throws for an adapter that does not. Pass them to `DefaultRequestHandler` in place of the SDK's in-memory stores:

```ts
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, type AgentExecutor } from '@a2a-js/sdk/server';
import { LMDBStorage } from '@lostgradient/weft';
import {
  createA2AHandler,
  createWeftA2ATaskStore,
  createWeftPushNotificationStore,
  withRedactedPushConfigurations,
} from '@lostgradient/weft/a2a';

declare const agentCard: AgentCard;
declare const executor: AgentExecutor;
declare const pushNotificationSender: ConstructorParameters<typeof DefaultRequestHandler>[5];

const storage = new LMDBStorage('./data/agents');
const taskStore = createWeftA2ATaskStore({ storage, namespace: 'support-agent' });
const pushNotificationStore = createWeftPushNotificationStore({
  storage,
  namespace: 'support-agent',
});

const handler = createA2AHandler({
  requestHandler: withRedactedPushConfigurations(
    new DefaultRequestHandler(
      agentCard,
      taskStore,
      executor,
      undefined,
      pushNotificationStore,
      pushNotificationSender,
    ),
  ),
  agentCard,
  publicUrl: 'https://agents.example.com/support',
});

// Run on a schedule of your choosing.
await taskStore.prune();
```

### Scoping

Every record is keyed by the store's `namespace` (one per published agent), the call's `ServerCallContext.tenant` (the empty string when absent), and its owner: the `userName` of an authenticated `user`, or one shared anonymous owner for every unauthenticated call. A task or configuration saved in one scope is invisible to every other: `load` and `get` return `undefined`, and `list` omits it. Keys live under the reserved `a2a:` prefix, with every component percent-encoded.

### Records

Every record is JSON carrying `recordVersion: 1`, and tasks and configurations are serialized with the SDK's own `Task.toJSON` and `TaskPushNotificationConfig.toJSON`, so the stored shape is the A2A wire shape. Reading a record with any other `recordVersion` throws `A2AStoreRecordVersionError` (with the record's `key` and `recordVersion`); a task `save` over such a record throws too, rather than overwrite a newer format with an older one.

Every write is a compare-and-swap. A write that loses one is retried up to five times, then throws `A2AStoreConflictError` (with `attempts: 6`).

### Tasks

`createWeftA2ATaskStore({ storage, namespace, terminalRetentionMs?, now? })` returns the SDK `TaskStore` plus `prune()`.

`list` follows these rules:

- It filters by `contextId` and `status` (the empty string and `TASK_STATE_UNSPECIFIED` mean no filter), and by `statusTimestampAfter`, which keeps tasks whose status timestamp is at or after the given instant (inclusive, as the A2A field's definition says; the SDK's in-memory store is exclusive). A task without a status timestamp never passes that filter.
- It applies `historyLength` (the last _n_ messages; `0` or less means none; absent means all) and `includeArtifacts` (absent or `false` leaves `artifacts` empty).
- It sorts by status timestamp, newest first, with tasks lacking one last, and breaks ties by task identifier in ascending order.
- `pageSize` defaults to 50; anything outside 1–100, including `0`, throws `A2AStorePageSizeError`.
- `nextPageToken` is an opaque token carrying the last task's status timestamp and identifier, and is `""` on the last page. A page continues strictly after that position, so a task saved or removed between pages never makes another appear twice. A token is bound to the caller and the filter set: one minted for another user, tenant, or filter set, or a malformed one, throws `A2AStorePageTokenError`.
- `totalSize` counts every matching task, before pagination.

`prune()` removes every terminal task (completed, failed, canceled, or rejected) of the namespace, in every tenant and for every owner, whose last save is older than `terminalRetentionMs` (default `DEFAULT_A2A_TERMINAL_RETENTION_MS`, thirty days) by the store's clock (`now`, default `Date.now`), and resolves with how many it removed. A task saved again while the prune runs is kept. Nothing prunes on its own; call it on a schedule.

### Push configurations

`createWeftPushNotificationStore({ storage, namespace, now? })` returns the SDK `PushNotificationStore` (`save`, `load`, `loadWithMetadata`, and `delete`) plus `create`, `get`, and a paginated `list`. Every method returns credentials unredacted, because the sender needs them.

`create` (which `save` calls, writing the stored identifier back into the configuration it was passed, as the SDK expects) is idempotent, because A2A 1.0.1 does not make it so. A create returns the existing configuration instead of storing a second when it:

- names an existing configuration `id` of the same task and caller, with the same webhook URL, `token`, and authentication; or
- names no `id`, with the same webhook URL, `token`, and authentication as a live configuration of that task and caller.

Authentication scheme names compare case-insensitively (`Bearer` and `bearer` match). A different URL or a rotated `token` stores a second configuration. A create naming an existing `id` with a different URL, `token`, or authentication, or naming a deleted configuration's `id`, throws `A2APushConfigurationConflictError` (`conflict` is `different` or `deleted`).

`delete(taskId, context, configId?)` defaults `configId` to `taskId`, as the SDK's own store does. It replaces the configuration with a tombstone that holds only its identifier and a deletion fence (the task's mutation sequence at deletion), so no stored record keeps its URL, `token`, or credentials. `get` returns `undefined` for a deleted configuration, `load` and `list` omit it, and a deleted configuration never matches either idempotency rule.

`list({ taskId, pageSize?, pageToken? }, context)` orders a task's live configurations by creation time, then identifier. `pageSize` defaults to 50 (absent or `0`, the protobuf default for this required field) and must otherwise be 1–100. The opaque `nextPageToken` is bound to the caller and the task, so a token minted for another caller or task throws `A2AStorePageTokenError`, and it is `""` on the last page. The SDK's `DefaultRequestHandler` lists configurations through `load` and does not page them; `list` is for a request handler that does.

### Redacting reads

`withRedactedPushConfigurations(requestHandler)` wraps an `A2ARequestHandler` so the `GetTaskPushNotificationConfig` and `ListTaskPushNotificationConfigs` responses carry `authentication.credentials` as `REDACTED_PUSH_CREDENTIALS` (`[REDACTED]`). Every other method passes through unchanged, including `CreateTaskPushNotificationConfig`, whose response echoes the configuration the caller just sent.

### Errors

The three errors a caller causes, `A2AStorePageSizeError`, `A2AStorePageTokenError`, and `A2APushConfigurationConflictError`, are the SDK's `RequestMalformedError`, so the JSON-RPC transport answers them as `-32602` (invalid params). Tell them apart by `code`. `A2AStoreRecordVersionError` and `A2AStoreConflictError` are server faults and answer as `-32603`.

## Not covered

The kit serves the JSON-RPC binding only. Push delivery, a Weft workflow backend for the request handler, the `openIdConnect` scheme, the HTTP+JSON and gRPC bindings, and the authenticated extended card are outside this subpath.
