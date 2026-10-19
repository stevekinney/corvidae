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

```ts
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { createAuthenticator, type AuthConfig } from '@lostgradient/weft';
import { createA2AHandler, securitySchemesFromAuthConfig } from '@lostgradient/weft/a2a';

declare const executor: AgentExecutor;

const authConfig: AuthConfig = { apiKeys: [process.env['A2A_API_KEY'] ?? ''] };
const authenticateWithWeft = await createAuthenticator(authConfig);

const agentCard: AgentCard = {
  name: 'Support Agent',
  description: 'Answers questions about orders.',
  supportedInterfaces: [],
  provider: undefined,
  version: '1.0.0',
  capabilities: { streaming: true, pushNotifications: false, extensions: [] },
  ...securitySchemesFromAuthConfig(authConfig),
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [],
  signatures: [],
};

const handler = createA2AHandler({
  requestHandler: new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor),
  agentCard,
  publicUrl: 'https://agents.example.com/support',
  // The card advertises API keys, so every JSON-RPC request must present one.
  async authenticate(request) {
    const result = await authenticateWithWeft(request);
    if (!result.authenticated) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      });
    }
    return { isAuthenticated: true, userName: result.principal?.subject ?? 'api-key' };
  },
});

Bun.serve({ fetch: handler });
```

A card that advertises `apiKey` or `bearer` schemes needs an `authenticate` that accepts those credentials, as above: without one, the handler serves every request anonymously while the card tells clients a credential is required. The SDK `User` that `authenticate` returns scopes each caller's tasks and push configurations by its `userName`, so give each principal a distinct one.

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
- `Last-Modified`: when the handler built the card, which never changes after that.
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
| `mtls`, with evidence that a client certificate is verified | `mutualTLS` |

Weft's authenticator admits a caller by certificate only on evidence that the certificate was verified: a `verifyClientCertificate` callback, or the `transportVerifiesClientCertificates` option the authenticator was created with, which says the listener refuses every connection without a verified certificate. `securitySchemesFromAuthConfig(authConfig, { transportVerifiesClientCertificates })` takes the same option and offers `mutualTLS` only on the same evidence, so with TLS terminated outside `serve()` and no callback the card offers no scheme that could never admit anyone. Pass the value your authenticator was created with; `serve()` derives it from its own TLS options.

API keys and `jwt` together share the single `bearer` scheme. `securityRequirements` lists each scheme as its own alternative.

## Durable stores

`createWeftA2ATaskStore` and `createWeftPushNotificationStore` implement the SDK's `TaskStore` and `PushNotificationStore` over Weft storage. The task store accepts any adapter that reports `conditionalBatch`. The push store also requires `linearizable` read-after-write and `snapshot` scans, because a create decides whether a webhook is new by scanning the task's configurations: memory, SQLite, LMDB, and PostgreSQL qualify, while Turso (`session` reads), `HttpStorage` (`eventual` reads), and IndexedDB (`best-effort` scans) do not. Each factory throws for an adapter that falls short. Pass them to `DefaultRequestHandler` in place of the SDK's in-memory stores:

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

`prune()` removes every terminal task (completed, failed, canceled, or rejected) of the namespace, in every tenant and for every owner, whose last save is older than `terminalRetentionMs` (default `DEFAULT_A2A_TERMINAL_RETENTION_MS`, thirty days) by the store's clock (`now`, default `Date.now`), and resolves with how many it removed. It also removes every push configuration, live or deleted, that a push store over the same storage and namespace holds for a pruned task, because once the task is gone no request reaches them and their credentials must not outlive it. A task saved again while the prune runs is kept, and a configuration created while it runs is removed with its task. A workflow agent's task loses its durable events with it but keeps its owner record, which holds no task content (see "Messages" under "Serving a workflow"). Nothing prunes on its own; call it on a schedule.

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

## Push delivery

Push notifications go through a Weft `Outbox`, so a notification survives a restart, is retried with backoff, and is never sent twice under different identities. Four pieces fit together:

- `createEgressPolicy(options)` decides whether a webhook URL may be contacted at all.
- `createHttpDeliveryAdapter(options)` is the outbox's transport: it POSTs each delivery to an egress-checked URL, with A2A authentication and Standard Webhooks signatures.
- `createOutboxPushNotificationSender({ outbox, pushStore })` is the SDK's `PushNotificationSender`. It enqueues one outbox delivery per push configuration instead of POSTing inline, and its `pushStore` deletes a configuration's pending deliveries with the configuration.
- `startPushDelivery({ outbox, intervalMs, signal })` drains the outbox until `signal` aborts.

```ts
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, type AgentExecutor } from '@a2a-js/sdk/server';
import { LMDBStorage, Outbox } from '@lostgradient/weft';
import {
  createA2AHandler,
  createEgressPolicy,
  createHttpDeliveryAdapter,
  createOutboxPushNotificationSender,
  createWeftA2ATaskStore,
  createWeftPushNotificationStore,
  pushNotificationResolvers,
  startPushDelivery,
  withRedactedPushConfigurations,
} from '@lostgradient/weft/a2a';

declare const agentCard: AgentCard;
declare const executor: AgentExecutor;

const storage = new LMDBStorage('./data/agents');
const taskStore = createWeftA2ATaskStore({ storage, namespace: 'support-agent' });
const pushStore = createWeftPushNotificationStore({ storage, namespace: 'support-agent' });

const outbox = new Outbox({
  storage,
  namespace: 'support-agent',
  ownerId: 'push-notifications',
  adapter: createHttpDeliveryAdapter({
    ...pushNotificationResolvers(pushStore),
    signingSecrets: [process.env['A2A_WEBHOOK_SECRET'] ?? ''],
    egressPolicy: createEgressPolicy(),
  }),
});
const sender = createOutboxPushNotificationSender({ outbox, pushStore });

const handler = createA2AHandler({
  requestHandler: withRedactedPushConfigurations(
    new DefaultRequestHandler(agentCard, taskStore, executor, undefined, sender.pushStore, sender),
  ),
  agentCard,
  publicUrl: 'https://agents.example.com/support',
});

const shutdown = new AbortController();
const delivering = startPushDelivery({ outbox, signal: shutdown.signal });
```

Pass `sender.pushStore`, not the store itself, to the request handler: its `delete` is what stops a deleted configuration's deliveries. Use one outbox for push delivery alone.

### Egress policy

`createEgressPolicy({ allowInsecureHttp?, allowlist?, resolveHost? })` returns `{ check(url) }`, which the adapter calls before every request. It rejects:

- a URL whose scheme is not `https`, unless `allowInsecureHttp` is set (then `http` is accepted too; nothing else ever is);
- a host whose address is in a range the IANA special-purpose address registries mark as not globally reachable, or in multicast: loopback (`127.0.0.0/8`, `::1`), `0.0.0.0/8`, RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`, `fe80::/10`), unique-local (`fc00::/7`), carrier-grade NAT (`100.64.0.0/10`), IETF protocol assignments (`192.0.0.0/24`, `2001::/23`), documentation (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`, `3fff::/20`), benchmarking (`198.18.0.0/15`), discard-only (`100::/64`), 6to4 (`2002::/16`), SRv6 SIDs (`5f00::/16`), local-use NAT64 (`64:ff9b:1::/48`), multicast (`224.0.0.0/4`, `ff00::/8`), reserved (`240.0.0.0/4`), or unspecified (`::`). Each block is rejected whole, including the few globally reachable addresses the registries carve out of `192.0.0.0/24` and `2001::/23`. An IPv6 address that embeds an IPv4 one (IPv4-mapped `::ffff:0:0/96`, IPv4-translated `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96`, or IPv4-compatible `::/96`) is checked as that IPv4 address.

An IP literal in the URL is checked directly (the URL parser has already normalized forms such as `0x7f.1` and `2130706433` to `127.0.0.1`). A hostname is resolved with `resolveHost`, which defaults to `node:dns` `lookup` where the runtime has it, and is rejected when any one of its addresses is non-public. With no resolver (`resolveHost: null`, or a runtime without `node:dns`), a hostname is rejected. A resolver that fails is not a rejection: the attempt is retried later.

`allowlist` entries are exact `host:port` pairs, such as `127.0.0.1:8080` or `[::1]:8443`, that bypass the range check (not the scheme check), for loopback receivers in tests and development.

The check cannot pin the connection. `fetch` resolves the name again when it connects, so a DNS-rebinding window remains between the check and the connection: a name that answered with a public address for the check can answer with a private one for the connection. Strict egress control needs an egress proxy that enforces the same ranges on the connection it makes.

### HTTP delivery adapter

`createHttpDeliveryAdapter({ resolveDestination, resolveCredential, signingSecrets?, egressPolicy, timeoutMs? })`:

| Option | Default | Meaning |
| --- | --- | --- |
| `resolveDestination` | required | `(destinationRef) => url`, called on every attempt. `undefined` means the destination no longer exists. |
| `resolveCredential` | required | `(credentialRef) => { scheme?, credentials?, notificationToken? }`, called on every attempt for a delivery with a `credentialRef`. `{}` means no authentication; `undefined` means the credential no longer exists. |
| `signingSecrets` | unset | A non-empty list of Standard Webhooks secrets (`whsec_` followed by base64). |
| `egressPolicy` | required | The policy every request passes first. |
| `timeoutMs` | 10000 | How long one request may take, 10000–30000. Anything else throws at construction. |

`pushNotificationResolvers(pushStore)` returns the two resolvers for push delivery: they read the configuration a delivery names from the push store on every attempt, so a delivery stores only a locator (tenant, owner, task, and configuration identifier) and never the configuration's URL, `token`, or credentials.

Each delivery is a `POST` of the A2A `StreamResponse` JSON with `Content-Type: application/a2a+json`, and:

- `Authorization: <scheme> <credentials>` when the configuration has authentication;
- `X-A2A-Notification-Token: <token>` when it has a `token`, beside `Authorization` and any signature (the header name `@a2a-js/sdk` 1.3.0's own sender uses; A2A 1.0.1 names none);
- `webhook-id`: the delivery's external idempotency key, or its delivery identifier when it has none. It is the receiver's idempotency evidence, so it is sent with or without `signingSecrets`;
- with `signingSecrets`, `webhook-timestamp` and `webhook-signature`, with one `v1,` HMAC-SHA256 signature per secret, space-delimited, so a receiver holding any one secret verifies while secrets rotate;
- `traceparent`, when the request that enqueued the delivery carried a valid one.

Redirects are not followed. The outcome the outbox settles on:

| What happened | Outcome |
| --- | --- |
| `2xx` | `acknowledged` |
| Connection refused, a DNS failure, or a destination or credential resolver that failed, before anything was sent | `retryable` |
| `408`, `429`, `5xx` | `retryable`, honoring `Retry-After` in delta-seconds or HTTP-date form, capped at 3600 seconds |
| `3xx`, any other `4xx`, a URL the egress policy blocks, or a destination or credential that no longer exists | `rejected` |
| A timeout, reset, or abort after the request began | `unknown` |

### Sender

`createOutboxPushNotificationSender({ outbox, pushStore })` throws unless the outbox's adapter came from `createHttpDeliveryAdapter` and its `timeoutMs` is lower than the outbox's `attemptTimeoutMs`. The adapter then always aborts its own request before the outbox stops waiting for it, so every attempt settles. `startPushDelivery` checks the same.

For each event with a task, `send` enqueues one delivery per live configuration of that task in the caller's scope:

- The idempotency key is `${tenant}:${owner}:${configId}:${taskId}:${digest}`, each identifier percent-encoded, where `tenant` and `owner` are the caller's scope as the push store keys it and `digest` is the SHA-256 of the event's [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) serialization, taken when `send` is called. The same event sent twice is one delivery per configuration; distinct events never share a key, and neither do two callers whose task and configuration identifiers coincide, since those are unique only within a scope.
- `unknownOutcomePolicy` is `retry-with-idempotency` and `maxAttempts` is 8, because A2A requires receivers to process notifications idempotently. The `externalIdempotencyKey`, `msg_` and the SHA-256 of the idempotency key, is sent as `webhook-id`, so every attempt of one delivery carries the same `webhook-id`.
- The enqueueing request's `traceparent` header, when it is a valid W3C trace context, is stored as the delivery's `causation.traceparent`.

A full outbox backlog, or an idempotency key already bound to another delivery, makes `send` throw after it has enqueued what it could; `DefaultRequestHandler` logs the error.

### Deleting a configuration

`sender.pushStore.delete(taskId, context, configId?)` (what `DeleteTaskPushNotificationConfig` calls) deletes the configuration, which stops new enqueues for it, then cancels every queued or retry-scheduled delivery to it and aborts every claimed or attempting one. It returns once each of those deliveries is terminal (`acknowledged`, `rejected`, `cancelled`, `unknown-outcome`, or `dead-lettered`) with its attempt settled; `cancellation-requested` is waited through, for at most the adapter's `timeoutMs` plus one second. An attempt still unsettled by then, as one running in a process that died would be, makes `delete` throw, after the configuration itself is gone. A pending delivery the cancellation misses (one enqueued by a `send` racing the delete) resolves no destination when its attempt runs, and is rejected without a request.

The deliveries are found by scanning every record the outbox retains, terminal ones included, so a delete costs time in proportion to the outbox's terminal retention.

### Driving delivery

`startPushDelivery({ outbox, intervalMs = 1000, signal, onError? })` calls `outbox.drain()` for everything due, waits `intervalMs`, and repeats until `signal` aborts, resolving once it has stopped. A drain that throws is reported to `onError` (default `console.error`) and the loop continues, even when `onError` itself throws. Because deliveries are durable, a delivery pending when the process stops is sent by the next process's loop over the same storage.

## Serving a workflow

`createWorkflowAgentExecutor(options)` serves one registered Weft workflow as an A2A agent. Each A2A task is one workflow run, and its task identifier is the workflow identifier. It returns `{ agentCard, requestHandler, taskStore, idle, [Symbol.dispose] }`: pass the card and the request handler to `createA2AHandler`, call `taskStore.prune()` on a schedule, and dispose the agent when you stop serving it.

```ts
import { Engine, LMDBStorage, Outbox, workflow, type WorkflowContext } from '@lostgradient/weft';
import {
  createA2AHandler,
  createEgressPolicy,
  createHttpDeliveryAdapter,
  createOutboxPushNotificationSender,
  createWeftPushNotificationStore,
  createWorkflowAgentExecutor,
  pushNotificationResolvers,
  startPushDelivery,
  withRedactedPushConfigurations,
} from '@lostgradient/weft/a2a';

const storage = new LMDBStorage('./data/agents');
const engine = new Engine({ storage });
engine.register(
  workflow({
    name: 'refund-request',
    description: 'Reviews a refund request.',
    version: '1.2.0',
  }).execute(async function* (ctx: WorkflowContext, request: string) {
    const decision = yield* ctx.waitForSignal<string>('input');
    return { request, decision };
  }),
);

const pushStore = createWeftPushNotificationStore({ storage, namespace: 'refund-request' });
const outbox = new Outbox({
  storage,
  namespace: 'refund-request',
  ownerId: 'push-notifications',
  adapter: createHttpDeliveryAdapter({
    ...pushNotificationResolvers(pushStore),
    egressPolicy: createEgressPolicy(),
  }),
});
const agent = createWorkflowAgentExecutor({
  engine,
  workflowType: 'refund-request',
  inputMode: 'text',
  card: { name: 'Refund Desk' },
  pushNotificationSender: createOutboxPushNotificationSender({ outbox, pushStore }),
});

const handler = createA2AHandler({
  requestHandler: withRedactedPushConfigurations(agent.requestHandler),
  agentCard: agent.agentCard,
  publicUrl: 'https://agents.example.com/refunds',
});
const delivering = startPushDelivery({ outbox, signal: new AbortController().signal });
```

| Option | Default | Meaning |
| --- | --- | --- |
| `engine` | required | The engine the workflow is registered with. |
| `workflowType` | required | The registered workflow type. Construction throws for a type the engine does not know. |
| `inputMode` | required | `'data'`: a message's first data part is the workflow input or signal payload. `'text'`: its text parts, concatenated. A message with no such part gets `RequestMalformedError`. |
| `input` | what `inputMode` reads | `(payload, message) => unknown`: turns what `inputMode` reads into the workflow input or signal payload, with the whole message at hand (its `messageId`, `metadata`, and every part). |
| `respond` | none | `(message, context) => Part[] \| undefined`, possibly async: answers a message that names no task with a bare agent `Message` holding these parts instead of starting the workflow. `undefined` starts the workflow. |
| `artifacts` | one data-part artifact | `(result) => Artifact[]`: the artifacts a completed workflow's result is published as. |
| `card` | required | `{ name, description?, security? }`, the card fields the workflow's definition cannot supply. |
| `pushNotificationSender` | required | From `createOutboxPushNotificationSender`, whose push store must use the agent's storage and namespace. |
| `namespace` | `workflowType` | Separates the agent's records in shared storage. |
| `storage` | `engine.storage` | Where tasks and their events are kept: any adapter the task store accepts. |
| `terminalRetentionMs` | thirty days | How long `taskStore.prune()` keeps a terminal task. |
| `now` | `Date.now` | The clock that stamps status timestamps and records. |
| `onError` | `console.error` | Receives errors no request waits on: a failed push enqueue, or a failed reconciliation after an engine event. |

### The workflow's card

The card's `name` is `card.name`; its `description` is the definition's `description`, else `card.description`, and construction throws when neither exists; its `version` is the definition's `version`. `createA2AHandler` gives it one interface at its `publicUrl`. Its default input and output modes are `application/json`, plus `text/plain` input for `inputMode: 'text'`, and a message part naming any other media type gets `ContentTypeNotSupportedError`. It has one skill, whose `id` is the workflow type, whose `name` and `description` are the card's, and whose `tags` are the definition's. `capabilities.streaming` and `capabilities.pushNotifications` are `true`. `card.security`, typically from `securitySchemesFromAuthConfig`, becomes its `securitySchemes` and `securityRequirements`.

### Messages

`SendMessage` without a `taskId` starts the workflow with the message's input, passing `idempotencyKey: ${user}:${messageId}` (the caller's `userName`, percent-encoded where it holds `:` or `%`) to `engine.start`, so a retried message from the same caller returns the same task instead of starting a second run. The task's `contextId` is the client's when it supplies one, otherwise the task identifier. A `configuration.taskPushNotificationConfig` is stored in the same conditional batch as the new task, its first event, and its owner record, so it is notified of every change from the first, and a message that loses the race to create the task to another caller, or whose create fails or never commits because the process stops, leaves no configuration (and no credentials) behind. This relies on the push store using the agent's storage and namespace, as the executor already requires. A message whose key names a run that another agent's workflow type or another caller's task holds gets `RequestMalformedError`, and so does one whose key names a run another caller's task held before it was pruned: pruning keeps each task's owner record, because the engine keeps its start idempotency mapping. The owner sending the same message again after the prune gets the task back, rebuilt from its workflow.

Every message that reaches a task saves its `configuration.taskPushNotificationConfig` for that task, not only the one that created it: a retried message saves it for the task the retry returns, and an accepted continuation saves it before its signal is delivered, so it is notified of the changes that signal causes. A continuation the checks below refuse saves nothing; one the engine itself rejects after they pass (a workflow that ends just before the signal lands, for instance) keeps the configuration it saved, which is pruned with its task. A message refused because its idempotency key names another caller's run saves nothing either. The configuration is scoped like any other, and `save` applies the push store's create rules: one that repeats a stored configuration is not stored twice, and one naming a deleted configuration's `id`, or an existing `id` with a different webhook, gets `A2APushConfigurationConflictError` (`-32602`), with no signal delivered.

`SendMessage` with a `taskId` continues the task, after two checks that run before any signal is delivered and apply to `SendStreamingMessage` too: a `contextId` other than the task's gets `RequestMalformedError` (`-32602`), and a task that is `COMPLETED`, `FAILED`, `CANCELED`, or `REJECTED` gets `UnsupportedOperationError`. Then the message's input is delivered as the payload of the signal the workflow waits for (`ctx.waitForSignal`). A workflow waiting for several signals at once (in `ctx.race`, for instance) needs the message to name one in `metadata.signalName` (`SIGNAL_NAME_METADATA_KEY`); the `INPUT_REQUIRED` status message lists the names in its `metadata.signalNames` (`SIGNAL_NAMES_METADATA_KEY`). A continuation to a task that waits for no signal gets `RequestMalformedError`.

A `SendMessage` returns once the task is terminal or waits for its caller (`INPUT_REQUIRED`), or at once with `configuration.returnImmediately`, and applies `configuration.historyLength` to the task it returns.

The agent answers with a bare `Message` only when the `respond` option returns parts for a message that names no task. `SendMessage` then returns an agent message holding them, whose `contextId` is the client's or a new one, and `SendStreamingMessage` sends it as its one event. No workflow run, task, or push configuration comes of it, and `respond` is never asked about a continuation.

### Task state

| Workflow | Task |
| --- | --- |
| `pending` | `SUBMITTED` |
| `running`, waiting for no signal | `WORKING` |
| `running`, waiting for any signal | `INPUT_REQUIRED` |
| `suspended` | `WORKING` |
| `completed` | `COMPLETED`, with the result's artifacts: by default one (`artifactId: 'result'`, `resultArtifact(result)`) holding the result as one data part |
| `failed`, `timed-out` | `FAILED`, with the reason in the status message |
| `cancelled` | `CANCELED` |

The task follows the workflow by reconciliation: the agent reads the workflow with `engine.get`, and commits any difference as a status update (preceded, on completion, by one artifact update per artifact). It reconciles a task whenever a request reads it and whenever the engine reports a lifecycle or signal event for its workflow, so a workflow that changes while no handler runs, completing during a restart for instance, reads correctly on its next request. `Task.history` holds only the messages exchanged on the task through A2A: the caller's messages and the agent's status messages, never anything else the workflow does.

`CancelTask` on a running task calls `engine.cancel` and returns the canceled task; on a `CANCELED` task it returns the task again (A2A 1.0.1 §3.3.1), and on a `COMPLETED`, `FAILED`, or `REJECTED` one, or one whose workflow finishes before the cancel lands, it gets `TaskNotCancelableError`.

`ListTasks` reconciles every one of the caller's tasks that matches its `contextId` before the task store applies the `status` and `statusTimestampAfter` filters, the sort, `totalSize`, and paging, so a status filter sees a task whose workflow finished while no handler ran. Its cost is linear in the caller's tasks in that context.

### Streams

Every status and artifact change is one durable event, committed in the same conditional batch as the task record, which records the sequence of the last event it reflects: its cursor. The events are kept beside the task, under the task store's keys, and `prune()` removes them with it. It keeps the task's owner record, for the reason "Messages" gives.

`SendStreamingMessage` and `SubscribeToTask` send the task first, tagged with its cursor, then each later event tagged with its own, and end at the first status update to `INPUT_REQUIRED` or a terminal state, where the SDK's `DefaultRequestHandler` ends its streams (owner ruling of 2026-10-19, which the A2A TCK's streaming tests require). The caller's answer opens a new stream that follows the task to its next wait or its end. A `SendStreamingMessage` whose task already waits for input when its first event is sent ends with that event. A `SubscribeToTask` on a task waiting for input follows it past the snapshot to the next such update, as the TCK's STREAM-SUB-002 requires, where the SDK, with no executor running, would end at once. `SubscribeToTask` on a terminal task gets `UnsupportedOperationError` before any event (§3.1.6). A client that resumes with `Last-Event-ID` gets the current task, which already holds every change up to its cursor, then only the events after that cursor, so nothing older than the task it was just sent ever reaches it. A stream carries only these `StreamResponse` kinds: the workflow's own progress (token streams, activities, step and tool events) never reaches A2A. Live delivery is in-process, so a subscriber follows the changes that its own agent commits.

The agent reads a signal wait from the workflow's persisted `waitingForSignals`. Right after it delivers a signal the persisted list still names it, so the agent treats that name as answered until the engine reports a new wait; this record is in memory, and after a restart the persisted list is read as it stands.

`examples/a2a-workflow-agent.ts` serves a workflow that streams progress, waits for an `input` signal, sleeps thirty seconds unless it is cancelled, and completes, with push delivery to a loopback receiver on the egress allowlist. It is also the TCK's system under test, and acts on the `messageId` prefixes the TCK's scenarios use, which its `input` option hands the workflow: `tck-complete-task` completes at once, the `tck-artifact-*` scenarios complete with the artifact each names (through `artifacts`), `tck-message-response` gets a bare message (through `respond`), and an answer starting `tck-input-required` asks for input again. Any other answer whose `messageId` starts with `tck-` completes without the sleep, because the TCK gives each blocking call thirty seconds, which the sleep would race. `bun run --filter=@lostgradient/weft test:a2a-tck` runs the official [A2A TCK](https://github.com/a2aproject/a2a-tck), at the commit `scripts/run-a2a-tck.ts` pins, against it at the `must`, `should`, and `may` levels over JSON-RPC, and keeps each level's JUnit report in `packages/weft/.cache/a2a-tck/reports/`. It deselects the tests `A2A_TCK_EXCLUSIONS` names, each a TCK defect recorded by owner ruling: CORE-SEND-003, whose requirement declares no expected error at the pinned commit, so the TCK fails the `ContentTypeNotSupportedError` it asks for. `--sut-host <url>` runs the same levels against an agent that is already running. It needs Python 3.11 or later, `uv`, and network access to clone the TCK.

## Not covered

The kit serves the JSON-RPC binding only. Several workflows behind one card, the `openIdConnect` scheme, the HTTP+JSON and gRPC bindings, and the authenticated extended card are outside this subpath, and so are certificate pinning, DNS-rebinding protection, and an egress proxy for push delivery.
