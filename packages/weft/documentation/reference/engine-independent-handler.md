# Engine-Independent Operation Handler

Status: **accepted** (owner approval, 2026-10-15). It records the options for each decision COR-1298 asks for, the tradeoffs found in the code at `96de0bdc`, and a recommendation. The implementation lands in COR-1299 (the Weft handler and the typed host context) and COR-1300 (`createBureauHandler`), which build on these decisions.

This document fixes how Bureau is exposed over HTTP by reusing Weft's transport plumbing and operation catalog without a Weft `Engine`, and where protocol adapters (A2A, AG-UI, Bureau MCP) mount. The settled architecture it builds on: Weft's transport plumbing and native operation catalog are shared; protocol adapters are not catalog operations; Bureau is exposed by `createBureauHandler(bureau, options): (request: Request) => Promise<Response>`.

## At a glance

| Decision | Proposed answer |
| --- | --- |
| 1. Engine-independent handler | `createOperationHandler<Host>(options)` from `@lostgradient/weft`'s `.` entry point, returning `(request: Request) => Promise<Response>`. It owns the catalog, authentication, access policy, fault mapping, SSE cursor replay, and CORS, and it never reads an `Engine`. |
| 2. Typed host context | `OperationContext<Input, Host = unknown>` and `DispatchContext<Host = unknown>` carry `readonly host: Host` in place of `readonly engine: unknown`. Weft's own operations keep `Host = unknown` and receive the `Engine` exactly as they do today. The rename is the one point that needs an owner ruling (see [Open questions](#open-questions-for-the-owner)). |
| 3. Placement | `createBureauHandler` is exported from `@lostgradient/bureau`'s existing `"."` entry point. Bureau's `exports` map is unchanged. |
| 4. Adapter mounts | An ordered `mounts` option: each adapter claims a path prefix and receives the resolved principal and a `dispatch` function into the catalog. Mounts are not catalog operations and do not appear in OpenAPI, OpenRPC, or AsyncAPI. |
| 5. A2A opt-in | For a code-defined agent, `createBureauHandler`'s `a2aAgents` allowlist (deployment-owned) decides whether it is served over A2A; for a persisted agent (an agent file), its own `a2a: true\|false` frontmatter key does, defaulting to `false`. `description` and `skills` on the agent definition (agent-owned) describe either. Neither source can override the other. |

## Context: where `engine` is required today

Two public entry points require an `Engine`:

- `handleRequest(request, engine: RegistryAgnosticEngine, options?)` — `packages/weft/src/server/handler/index.ts:229-233`. It registry-erases the value to `Engine` once at `:241` and threads it through the whole dispatch chain.
- `serve(options: ServeOptions)` — `packages/weft/src/server/index.ts:603`, with `ServeOptions.engine: RegistryAgnosticEngine` at `:219`.

The catalog itself does not need one. `OperationContext<Input>` (`packages/weft/src/server/operation-catalog/types.ts:167-172`) and `DispatchContext` (`:373-379`) type the slot as `readonly engine: unknown` (`:170` and `:375`). Every operation that needs something from it narrows it itself:

- Weft's own operations call `assertOperationEngineMethods` (`packages/weft/src/server/operations/operation-helpers.ts:104-116`) or `runtimeWorkflowEngine` (`packages/weft/src/server/operation-catalog/workflow-adapter.ts:111-115`). 41 operation files under `packages/weft/src/server/` use the first, besides the helper itself.
- Bureau casts: `(engine as BureauEventsOperationEngine).bureauFeeds` and `.runtime` at `packages/bureau/src/bureau-events-operation.ts:107-109`, against the shape declared at `:83-86`.
- Operative casts the same way: `(engine as RunEventsOperationEngine).runFeeds` at `packages/operative/src/run-events-operation.ts:146`, against `:120`.

The slot is already used as a host bag rather than as an engine. Three call sites pass something that is not an `Engine`:

- `packages/weft/src/server/handler/sse-route-dispatch.ts:55` passes `options.liveEventStreamContext ?? {}` — the workflow and fleet feeds, not the engine.
- `packages/weft/src/server/json-rpc-websocket.ts:159` passes `{ feed }` and `:177` passes `{ fleetFeed }`.
- `packages/weft/src/server/json-rpc-dispatch.ts:180-188` duck-types the slot for `listWorkflowDefinitions`, so `rpc.discover` already works without an engine.

`ServeOptions.operations` (`packages/weft/src/server/index.ts:233`) is the existing mount point for foreign operations, documented at `:221-232` as what "a gateway serving all three" passes. `serve()` folds them into the live registry through `additionalOperations` (`packages/weft/src/server/serve-internals.ts:314`, `packages/weft/src/server/rest-bindings.ts:333`).

Two findings shape the decisions below.

**No transport reaches a foreign subscription operation today.** `executeOperation` rejects every `subscription`-kind operation with `Unprocessable` (`packages/weft/src/server/operation-catalog/pipeline.ts:25-33`). The only callers of `executeSubscription` (`packages/weft/src/server/operation-catalog/stream-pipeline.ts:59`) are the two hard-coded WebSocket session primitives for workflow and fleet events (`packages/weft/src/server/json-rpc-websocket.ts:77-84`, `:150`, `:175`). Every other JSON-RPC WebSocket method goes through `dispatchJsonRpc` (`:352-357`) and so through `executeOperation`. `bureau.events` declares `transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false }` (`packages/bureau/src/bureau-events-operation.ts:103`), so passing it to `serve({ operations })` registers it, lists it in AsyncAPI, and leaves it unreachable. `operative.runs.events` is in the same position (`packages/operative/src/run-events-operation.ts:140`).

**A `(Request) => Promise<Response>` handler cannot accept a WebSocket.** Completing an upgrade needs Bun's `server.upgrade()`, which `serve()` reaches through the bound server (`packages/weft/src/server/runtime/authentication-bridge.ts:172-179`). A fetch handler has no server. Whatever transport carries `bureau.events` through `createBureauHandler` has to be plain HTTP, which means Server-Sent Events.

## Every `engine` read on the `handleRequest` and `serve()` paths

"Catalog-generic" means the read only threads the value into `DispatchContext`/`OperationContext`, or substitutes a host bag, and the engine-independent handler keeps it with `host` in place of `engine`. "Weft-specific" means the read needs a real `Engine` (its storage, its events, its workflow registry), and the engine-independent handler does not have it.

### `handleRequest`

| Location | Read | Class |
| --- | --- | --- |
| `server/handler/index.ts:229-233` | `handleRequest(request, engine: RegistryAgnosticEngine, options?)` parameter | Catalog-generic (threading) |
| `server/handler/index.ts:241` | `engine as Engine` passed to `dispatchMatchedRouteBoundary` | Catalog-generic (threading) |
| `server/handler/index.ts:187-194` | `dispatchMatchedRouteBoundary` → `dispatchMatchedRoute` | Catalog-generic (threading) |
| `server/handler/index.ts:151-163`, `:173-181` | `dispatchMatchedRoute` → `dispatchDirectRoute` or `dispatchRestBinding` | Catalog-generic (threading) |
| `server/handler/index.ts:99-120` | `dispatchRestBinding` → `dispatchViaExecuteOperation(request, engine, …)` | Catalog-generic (threading) |
| `server/handler/route-dispatch.ts:291-293`, `:324-330` | `dispatchViaExecuteOperation` puts `engine` into `executeOperation`'s `DispatchContext` | Catalog-generic (the host slot) |
| `server/handler/sse-route-dispatch.ts:53-59` | SSE bindings put `liveEventStreamContext ?? {}` in the slot instead of the engine | Catalog-generic (already engine-free) |
| `server/handler/index.ts:131-140` | `dispatchDirectRoute` builds `RouteExecutionContext { request, engine, options }` | Catalog-generic (threading) |
| `server/handler/route-dispatch.ts:226-230` | `RouteExecutionContext.engine: Engine` | Catalog-generic (threading) |
| `server/handler/route-dispatch.ts:272-280` | `openRpcDocument` calls `listMcpTools(engine)` to list the engine's workflows as MCP tools | **Weft-specific** — the only real read on this path |
| `server/operation-catalog/operation-dispatch.ts:110-117` | `operationContext()` copies `context.engine` into `OperationContext` for `invoke` | Catalog-generic (the host slot) |
| `server/operation-catalog/pipeline-stages.ts:85-90` | `checkAuthorization` copies `context.engine` into the `authorize` hook's context | Catalog-generic (the host slot) |

Downstream of the slot, each Weft operation that narrows it to an `Engine` (`assertOperationEngineMethods`, `runtimeWorkflowEngine`) is Weft-specific, but that is the operation's requirement, not the handler's. The handler only has to deliver whatever host the operation was registered against.

The other direct routes (`healthCheck`, `getMetrics`, `apiCatalog`, `mcpDiscovery`, `openApiDocument`, `asyncApiDocument` at `server/handler/route-dispatch.ts:234-288`) ignore `engine`. `apiCatalog` and `mcpDiscovery` are still Weft-specific in content: they advertise Weft's own `/mcp` endpoint and service descriptions.

### `serve()`

| Location | Read | Class |
| --- | --- | --- |
| `server/index.ts:219` | `ServeOptions.engine` | Weft-specific (input) |
| `server/index.ts:610-614` | `requireStorageCapability(options.engine.storage, 'conditionalBatch', …)` | Weft-specific |
| `server/index.ts:667` | `wireEventBroadcasting(options.engine as Engine, …)` | Weft-specific |
| `server/index.ts:709`, `:711` | `getTaskResult` and `adoptTaskResult` read `options.engine.storage` | Weft-specific |
| `server/serve-internals.ts:264` | `new WorkerDeploymentCatalog(options.engine.storage)` | Weft-specific |
| `server/serve-internals.ts:269-270` | `createEngineEventFeedBackend(engine)` | Weft-specific |
| `server/serve-internals.ts:310` | live operation registry gets `storage: options.engine.storage` | Weft-specific |
| `server/serve-internals.ts:325` | `createFleetEventFeed(options.engine.storage)` | Weft-specific |
| `server/serve-internals.ts:397` | `createMcpEndpoint(engine)` | Weft-specific |
| `server/serve-internals.ts:337` | `getEnginePayloadSizeMaxBytes(engine)` | Weft-specific |
| `server/serve-internals.ts:455` | `registerWorkflowEventLifecycle(options.engine as Engine, …)` | Weft-specific |
| `server/runtime/authentication-bridge.ts:43` | `ServerFetchOptions.engine` | Weft-specific (input) |
| `server/runtime/authentication-bridge.ts:184-193` | `/mcp` → `handleMcpHttpRequest({ endpoint: context.mcpEndpoint, … })` | Weft-specific |
| `server/runtime/authentication-bridge.ts:253-262` | `/jsonrpc` → `handleJsonRpcHttpRequestSafely({ engine, … })`, which reaches `DispatchContext` through `server/json-rpc-transport-helpers.ts:28-35` and `server/json-rpc-http.ts:38`, `:92` | Catalog-generic (the host slot) |
| `server/json-rpc-dispatch.ts:155`, `:180-188` | `rpc.discover` duck-types the slot for MCP tools | Catalog-generic (already optional) |
| `server/runtime/authentication-bridge.ts:265-269` | REST and direct routes → `handleRequest(request, options.engine, …)` | See the `handleRequest` table |
| `server/runtime/authentication-bridge.ts:324` | `replayWatchEvents(context, options.engine as Engine, …)` | Weft-specific |
| `server/runtime/authentication-bridge.ts:347` | `replayTokenStream(context, options.engine as Engine, …)` | Weft-specific |
| `server/runtime/authentication-bridge.ts:351-358` | `openJsonRpcWebSocketSession({ engine, … })` | Catalog-generic (threading) |
| `server/json-rpc-websocket-runtime.ts:54`, `:62` | the session runtime options carry `engine: unknown` into `createJsonRpcWebSocketSession` | Catalog-generic (threading) |
| `server/json-rpc-websocket-types.ts:12` | `JsonRpcWebSocketSessionOptions.engine: unknown` | Catalog-generic (threading) |
| `server/json-rpc-websocket.ts:89`, `:352-357` | the session destructures `engine` and passes it to `dispatchJsonRpc` | Catalog-generic (the host slot) |
| `server/runtime/websocket-stream.ts:57`, `:64`, `:81`, `:315-321`, `:367`, `:372` | stored stream and watch replay | Weft-specific |
| `server/runtime/event-broadcasting.ts:113`, `:128`, `:235`, `:264`, `:276`, `:317`, `:364`, `:380` | engine event listeners and stream storage | Weft-specific |
| `server/runtime/task-dispatch.ts:271`, `:324-325`, `:390`, `:565`, `:589` | remote task ledger and attempt events | Weft-specific |
| `server/runtime/task-polling.ts:67`, `:128-129`, `:318`, `:355`, `:376`, `:385` | long-poll task ledger | Weft-specific |
| `server/runtime/websocket-worker.ts:230`, `:514`, `:536` | worker task ledger | Weft-specific |
| `server/runtime/websocket-worker-registration.ts:287` | `engine.dispatchEvent` on registration | Weft-specific |
| `server/runtime/worker-disconnect-requeue.ts:64`, `:93` | requeue on disconnect | Weft-specific |
| `server/runtime/task-ledger-completion.ts:274` | completion event | Weft-specific |
| `server/runtime/task-ledger-recovery.ts:194` | startup ledger scan | Weft-specific |
| `server/runtime/task-result-application.ts:60`, `:93` | result commit | Weft-specific |
| `server/runtime/task-result-submission.ts:346` | result submission | Weft-specific |
| `server/runtime/task-dispatch-revision.ts:40` | persisted workflow state | Weft-specific |
| `server/runtime/long-poll-drain.ts:103` | drain ledger read | Weft-specific |
| `server/runtime/remote-activity-event-bridges.ts:56`, `:73-74`, `:93`, `:95` | remote activity event listeners | Weft-specific |
| `server/runtime/activity-heartbeat-test-hooks.ts:96`, `:124` | test hook keyed by engine | Weft-specific |

Paths are relative to `packages/weft/src/`. The split is clean: everything that touches storage, engine events, workflow streams, the remote-worker task ledger, or Weft's MCP server is Weft-specific and stays behind `serve()`. Everything the engine-independent handler needs (catalog dispatch, JSON-RPC HTTP, discovery documents from a registry, SSE) is already generic except for the `listMcpTools(engine)` read in `openRpcDocument`, which the new handler omits.

## Decision 1: the engine-independent handler signature

### Options

**A. Make `handleRequest`'s `engine` optional.** Smallest diff, but `handleRequest` serves Weft's whole REST surface (`defaultRestBindings()`, `defaultOperationRegistry()` at `server/handler/route-dispatch.ts:454-486`), whose operations require an `Engine`. An optional engine would turn a type error into a runtime `TypeError` from `assertOperationEngineMethods` on most routes. It also leaves authentication and CORS outside, in `serve()`'s `authentication-bridge.ts`, so a Bureau host would rebuild both. COR-1299 requires `handleRequest`'s behavior to stay unchanged, which this option strains.

**B. A new `createOperationHandler(options)` factory beside `handleRequest`.** A factory, not a per-request function, so that registry construction, CORS validation, and authenticator construction fail once, synchronously, before the first request, the way `serve()` fails before binding a port (`server/index.ts:229-232`, `:604-614`). It serves only the registry it is given, owns authentication and CORS itself, and has no Weft-only routes.

**C. Extract a transport kernel package.** A new workspace for the shared plumbing. COR-1298 and the workspace rules both rule out a new workspace without a packaging need, and nothing here needs one.

### Proposed: option B

```ts
// packages/weft/src/server/handler/operation-handler.ts (new, COR-1299)
// Exported from @lostgradient/weft's "." entry point through
// src/server/handler/index.ts → src/server/handler.ts → src/index.ts.
import {
  createOperationHandler,
  getPrincipalOperation,
  unauthenticatedLocalAuthContext,
  type OperationHandler,
  type OperationHandlerOptions,
} from '@lostgradient/weft';

// The fields this decision proposes, picked from the shipped options type:
// - operations: the whole catalog this handler serves; Weft's own operations are not added.
// - host: delivered as `host` to every `invoke` and `authorize` call.
// - authenticate: `(request) => Promise<AuthContext | Response>`. Omitted, every
//   request is anonymous and only `public` operations pass.
// - cors: same validation and defaults as `ServeOptions.cors`; omitted means no CORS headers.
// - mounts: adapters that claim a path prefix ahead of catalog routing. See decision 4.
type ProposedOperationHandlerOptions<Host> = Pick<
  OperationHandlerOptions<Host>,
  | 'operations'
  | 'host'
  | 'authenticate'
  | 'cors'
  | 'mounts'
  | 'discoveryInfo'
  | 'maxRequestBodyBytes'
>;

const create: <Host>(options: ProposedOperationHandlerOptions<Host>) => OperationHandler =
  createOperationHandler;

// A single-user host admits every request as the local principal.
const handler = create({
  operations: [getPrincipalOperation],
  host: {},
  authenticate: async () => unauthenticatedLocalAuthContext(),
});
const response = await handler(new Request('http://localhost/v1/health'));
console.log(response.status); // 200
```

`NoInfer` makes `Host` come from `host` alone. Because `RegistrableOperation.dispatch` is a function-typed property (`server/operation-catalog/types.ts:349-352`), an operation is checked contravariantly: one that needs `{ bureauFeeds }` is accepted by a handler whose host is `{ bureauFeeds, runFeeds }`, and rejected by a handler whose host lacks `bureauFeeds`. A missing host capability becomes a compile error at the call to `createOperationHandler`, not a runtime cast failure.

What the handler owns, and which existing code it reuses:

| Concern | Behavior | Reused from |
| --- | --- | --- |
| Catalog | `createOperationRegistry(options.operations)`; duplicate names throw at construction. | `server/operation-catalog/registry.ts:105-117` |
| Authentication | `authenticate(request)` runs before any route except CORS preflight and the public paths below. A `Response` result is returned as-is (the 401). A thin wrapper over `createAuthenticator(authConfig)` (exported at `src/index.ts:70`) gives a host Weft's API-key and JWT schemes, mapping a rejection to the same 401 `serve()` returns. | `server/runtime/request-gate.ts:40-79`, `server/handler/auth-context-principal.ts:26` |
| Access policy | Unchanged: lookup, transport check, access check, parse, unknown-key policy, `authorize`, `invoke`, output validation. | `server/operation-catalog/pipeline.ts`, `pipeline-stages.ts` |
| Fault mapping | `faultToHttpResponse` for REST and SSE, `faultToJsonRpcError` for JSON-RPC. | `server/fault-to-http.ts:12`, `server/fault-to-json-rpc.ts:31` |
| JSON-RPC HTTP | `POST /jsonrpc` over the supplied registry. `rpc.discover` lists no MCP tools (no engine to list). | `server/json-rpc-http.ts`, `server/json-rpc-dispatch.ts` |
| SSE cursor replay | `GET /v1/subscriptions/:operationName` for every `subscription` operation with `transports.http: true`. Query parameters are the operation input; `Last-Event-ID` overrides `fromCursor`; the request must accept `text/event-stream`. Runs `executeSubscription` and streams the iterable. | `server/operation-catalog/stream-pipeline.ts:59`, `server/operations/sse-stream.ts:49`, `:61`, `:136` |
| CORS | Preflight before authentication; actual responses decorated for allowed origins; options validated at construction. | `server/runtime/cors.ts:164`, `:225`, `:240`, `:285`, `:346` |
| Discovery | `GET /openapi.json`, `/openrpc.json`, `/asyncapi.json`, and `/v1/health`, generated from the supplied registry only. All four are public paths. | `server/openapi.ts:397`, `server/openrpc.ts:115`, `server/asyncapi.ts:52` |

Not served, because each is Weft-specific: `/mcp`, `/.well-known/mcp.json`, `/.well-known/api-catalog`, `/v1/metrics`, the workflow and token WebSocket streams, and every remote-worker route. Rate limiting stays in `serve()`: its key falls back to the client address (`server.requestIP`), which a fetch handler cannot see. A host that needs it puts a limiter in front of the handler.

The generic SSE route is the piece COR-1299 adds to Weft's transport plumbing. It replaces nothing: the existing `/v1/workflows/:id/events/sse` and `/v1/events/sse` bindings (`server/handler/sse-route-dispatch.ts:36-41`) keep their own routes in `handleRequest`. For `bureau.events` and `operative.runs.events` to be reachable through it, each operation's `transports.http` changes from `false` to `true`. That is a one-line change in each package, and it belongs to COR-1299 because COR-1299's acceptance criteria require serving both operations through the new handler.

`handleRequest` and `serve()` keep their signatures and behavior. COR-1299 may have `serve()`'s HTTP path call into the same internal modules, but it must not change what either returns.

## Decision 2: the typed host context

### Options

**A. Make the slot generic and keep the name `engine`.** `OperationContext<Input, Host = unknown>` with `readonly engine: Host`. Additive: every existing call site and test compiles unchanged, because the default is `unknown`. But the name keeps saying "engine" for a value that, for Bureau, Operative, and Weft's own SSE path, is not one. The confusion it causes is the reason the casts exist.

**B. Make the slot generic and rename it to `host`.** `OperationContext<Input, Host = unknown>` with `readonly host: Host`, and `DispatchContext<Host = unknown>` with `readonly host: Host`. The name matches what the three substitution sites above already pass. The cost is mechanical but wide: every operation that destructures `engine`, the `authorize` hook path, and the existing server tests that build a `DispatchContext` literal (58 test files under `packages/weft/src/server/` mention both `engine` and `executeOperation`, `dispatchJsonRpc`, or `invoke`; there are 108 `executeOperation(` calls in Weft's tests) all change `engine:` to `host:`. AGENTS.md rules out keeping both names as a compatibility layer.

**C. Keyed capabilities.** `host.get(bureauFeedsKey)` with typed keys, each operation declaring the keys it requires, checked at registry construction. It gives runtime verification as well as type checking, but it adds a new abstraction that the contravariant check in option B already provides at compile time, and it changes every operation's access pattern, not just its parameter name.

### Proposed: option B, subject to the owner's ruling on COR-1299's test criterion

```ts
// packages/weft/src/server/operation-catalog/types.ts (COR-1299)
import type { OperationContext, OperationHandlerOptions, Principal } from '@lostgradient/weft';

type TransportKind = OperationContext<unknown>['transport'];
// `DispatchContext` is not exported; it is the context every registrable operation's `dispatch` receives.
type RegistrableOperation<Host> = OperationHandlerOptions<Host>['operations'][number];
type DispatchContext<Host = unknown> = Parameters<RegistrableOperation<Host>['dispatch']>[1];

type FeedHost = { readonly bureauFeeds: ReadonlyMap<string, unknown> };

declare const principal: Principal;

// OperationContext<Input, Host = unknown>: `host` in place of `engine`.
const context: OperationContext<{ bureauId: string }, FeedHost> = {
  input: { bureauId: 'bureau-1' },
  principal,
  host: { bureauFeeds: new Map() },
  transport: 'http-rest',
};

// DispatchContext<Host = unknown>: the same `host` slot, plus the registry and an optional trace.
declare const dispatchContext: DispatchContext<FeedHost>;
const host: FeedHost = dispatchContext.host;
const transport: TransportKind = dispatchContext.transport;
console.log(context.host.bureauFeeds.size, host, transport, dispatchContext.registry);
console.log(dispatchContext.pipelineTrace); // optional
```

`defineOperation` gains a `Host` type parameter that flows into `invoke` and `authorize`, and `RegistrableOperation<Host = unknown>` carries it into `dispatch`. Weft's own operations keep `Host = unknown`, keep narrowing with `assertOperationEngineMethods`, and keep receiving the `Engine` from `handleRequest` and `serve()`, so their behavior does not change. Typing Weft's own catalog against a `WeftHost` is a possible follow-up, not part of COR-1299.

Bureau's operation then reads the host without a cast:

```ts
// packages/bureau/src/bureau-events-operation.ts (COR-1299), reduced to a unary
// operation: the real one is a subscription, and it reads `host` the same way.
import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

// Stand-ins for Bureau's own types, covering only what the operation reads.
interface BureauEventRegistry {
  get(bureauId: string): { readonly latestCursor: string } | undefined;
}

export type BureauEventsOperationHost = {
  readonly bureauFeeds: BureauEventRegistry;
};

const bureauEventsInput = z.object({ bureauId: z.string() });
const bureauEventsOutput = z.object({ latestCursor: z.string().nullable() });

export const bureauEventsOperation = defineOperation<
  typeof bureauEventsInput,
  typeof bureauEventsOutput,
  BureauEventsOperationHost
>({
  name: 'bureau.events.latest',
  mcpExposable: false,
  summary: 'Read the latest cursor of a Bureau event feed',
  destructive: false,
  inputSchema: bureauEventsInput,
  outputSchema: bureauEventsOutput,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input, host }) => {
    // `host` is typed as BureauEventsOperationHost: no cast.
    const bureauFeed = host.bureauFeeds.get(input.bureauId);
    return { latestCursor: bureauFeed?.latestCursor ?? null };
  },
});
```

This removes the cast at `bureau-events-operation.ts:107-109`, and the same change removes Operative's at `run-events-operation.ts:146`. It also changes what `serve({ operations })` accepts. `ServeOptions.operations` becomes `ReadonlyArray<RegistrableOperation<RegistryAgnosticEngine>>`, because `serve()` passes its `Engine` as the host. An operation that needs `{ bureauFeeds }` no longer type-checks there, which is correct: `serve()` would hand it an `Engine` that has no `bureauFeeds`.

## Decision 3: placement of `createBureauHandler`

Settled at intake and recorded here: **`createBureauHandler` is exported from `@lostgradient/bureau`'s existing `"."` entry point.** There is no new workspace and no new subpath, and `packages/bureau/package.json`'s `exports` stays `{ ".": "./src/index.ts" }`.

- Implementation: `packages/bureau/src/http/create-bureau-handler.ts` (COR-1300 names `packages/bureau/src/http/` as the directory).
- Public export: a re-export from `packages/bureau/src/index.ts`.
- Weft consumption: `import { createOperationHandler } from '@lostgradient/weft';` — the bare specifier, from Weft's `"."` entry point. Bureau already declares `"@lostgradient/weft": "workspace:*"` in `dependencies`, so no manifest change is needed.

What `scripts/workspace-imports.test.ts` checks, and why this placement passes it. The parameterized test `'%s source imports use declared dependencies and declared public entry points'` (`scripts/workspace-imports.test.ts:228-235`) runs once per workspace manifest. For each source import of an internal workspace it asserts three things:

1. `declaresImportSpecifier(name, importedRoot, exports)` (`:269-272`, implemented at `scripts/workspace-exports.ts:41-50`) is true: the specifier is the package name itself or a subpath its `exports` declares. `@lostgradient/weft` is the package name, so this returns true at `scripts/workspace-exports.ts:46` without consulting the subpaths.
2. A file under `src/` that is not a test or fixture does not import its own package's public barrel (`:273-282`). `create-bureau-handler.ts` imports Bureau's own modules by relative path, never `@lostgradient/bureau`.
3. A cross-workspace import is declared as `workspace:*` (`:283-288`). Bureau declares Weft that way.

The test does not limit a package to one entry point. `sourceExportViolations` (`scripts/workspace-exports.ts:12-38`) explicitly allows plain subpaths that point at an existing `./src/**/*.ts` file, and Weft declares four (`.`, `./worker`, `./worker/authoring`, `./worker/generated-authoring`). The single-entry placement is an architectural preference recorded at intake, not something the test compels.

On the Weft side, `operation-handler.ts` lives under `packages/weft/src/server/handler/`, is re-exported through `src/server/handler/index.ts` and `src/server/handler.ts`, and reaches the public surface through `export * from './server/handler.ts'` at `packages/weft/src/index.ts:83`. That is the same path `handleRequest` takes, so Weft's `exports` map does not change either.

## Decision 4: where protocol adapters mount

### Options

**A. Register adapters as catalog operations.** Rejected by the settled architecture. A2A's `message/send`, AG-UI's event stream, and MCP's `tools/call` have their own wire envelopes, method names, and discovery documents. As catalog operations they would appear in Weft's OpenAPI, OpenRPC, and AsyncAPI documents as if they were native operations, under names the catalog's naming pattern does not describe.

**B. Let the host compose: `createBureauHandler` returns the catalog handler, and the application routes adapter paths itself before calling it.** No new option, but each application would reimplement authentication, CORS, and the path-collision rules for every adapter, and the adapter would have no sanctioned way into the catalog's access policy.

**C. An ordered `mounts` option on the handler.** Each mount claims a path prefix and gets a fetch-shaped callback with the resolved principal and a `dispatch` into the same catalog.

### Proposed: option C

This is the pattern `serve()` already uses for its non-catalog protocols: `/mcp` and `/jsonrpc` are claimed in `server/runtime/authentication-bridge.ts:184-196` and `:253-263`, before `handleRequest` and outside the REST table.

```ts
import type { OperationHandlerMount, OperationHandlerMountContext } from '@lostgradient/weft';

const a2aMount: OperationHandlerMount = {
  // Path prefix this adapter owns, for example `/a2a` or `/ag-ui`.
  pathPrefix: '/a2a',
  // Exact paths under any prefix that skip `authenticate`.
  publicPaths: ['/.well-known/agent-card.json'],
  fetch: async (request: Request, context: OperationHandlerMountContext) => {
    // `context.principal` is the resolved caller. `context.dispatch` runs one catalog
    // operation through the full pipeline as that principal; `context.subscribe` does
    // the same for `subscription` operations.
    const result = await context.dispatch('weft.system.principal', {});
    return result.ok
      ? Response.json(result.value)
      : Response.json({ fault: result.fault.code }, { status: 403 });
  },
};
```

Request order inside the handler:

1. CORS preflight.
2. Authentication, unless the path is a handler public path, a mount's `publicPaths`, or a path under a mount's prefix that its `isPublicPath` predicate passes.
3. Mounts, in order: the first whose `pathPrefix` matches handles the request.
4. Catalog routes: `/jsonrpc`, `/v1/subscriptions/:operationName`, and the discovery documents. The handler serves no REST bindings: foreign operations declare none today, and an optional `restBindings` field can be added later without changing anything above it.
5. CORS decoration of the response.

Construction rejects a mount whose prefix overlaps a catalog route or another mount, so an adapter cannot shadow a native operation. This is the same rule `createOperationRegistry` applies to duplicate operation names.

Adapters stay out of the discovery documents by construction. `generateOpenApiDocument`, `generateOpenRpcDocument`, and `generateAsyncApiDocument` take only a registry and REST bindings (`server/handler/route-dispatch.ts:261-288`), and mounts are in neither. An adapter that publishes its own discovery document (an A2A agent card, MCP's `initialize` result) serves it from its own prefix or public path.

An adapter translates and the catalog executes. A2A `message/send` becomes `dispatch('bureau.run', …)`, so it passes the same access policy and `authorize` hook as a native call. An adapter that bypassed `dispatch` and called the `bureau` object directly would also bypass access policy; COR-1300 and the adapter issues (COR-903, COR-855, COR-839) should treat that as a defect.

`createBureauHandler` forwards a `mounts` option to `createOperationHandler` unchanged. The adapters themselves are out of scope for COR-1299 and COR-1300.

## Decision 5: publication configuration and descriptive metadata

Two different owners decide two different things:

- **The deployment decides which agents are served over A2A.** `createBureauHandler(bureau, { a2aAgents: ['support', 'triage'] })`. `a2aAgents` is an allowlist of code-defined agent names from `bureau.agents`, and it is the only deployment-side opt-in for a code-defined agent (COR-1300's acceptance criteria). An agent file, a Markdown file in `BureauOptions.agentDirectory` (COR-1524), opts in with `a2a: true` in its own frontmatter instead, which defaults to `false`; it is never named in `a2aAgents`, and a file cannot opt in a code-defined agent. Both are read on every request, so opting in or out takes effect without a restart. An agent that has not opted in has no card, starts no task through A2A, and reads as not found, so its existence is not disclosed over A2A. It is still listed and can still be chatted with over AG-UI. Omitting `a2aAgents` opts in nothing: the default fails closed. An unknown name in `a2aAgents` throws at construction.
- **The agent decides how it is described.** `description` and `skills` belong on the agent definition, next to `name` (`packages/operative/src/runnable-agent.ts:118` onward). An A2A agent card, an MCP tool description, or an AG-UI listing reads them from there. A deployment cannot rewrite them in handler options, and an agent cannot opt itself into A2A by declaring them.

`RunnableAgent` has neither field today, so they have to be added. Proposed shape: `readonly description?: string` and `readonly skills?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly description: string; readonly tags?: ReadonlyArray<string> }>`, accepted by `createAgent` and carried onto the `RunnableAgent`. The shape follows the A2A `AgentSkill` fields every adapter can project from. Which issue adds them is an [open question](#open-questions-for-the-owner).

The Weft handler has no notion of agents. `a2aAgents` is a `createBureauHandler` option that Bureau enforces itself. It is not an `OperationHandlerOptions` field.

## The test that proves a handler with no `Engine` serves `bureau.events`

Weft cannot import `@lostgradient/bureau`: Bureau depends on Weft, and `scripts/workspace-imports.test.ts:283-288` would reject the undeclared reverse dependency. The proof therefore lives in Bureau, which can import both Weft and Operative.

- **File:** `packages/bureau/src/bureau-events-operation.test.ts`
- **Describe block:** `describe('bureau.events through createOperationHandler with no Engine', …)`
- **Test:** `it('replays and follows a bureau feed over Server-Sent Events with no Engine constructed', …)`

The test builds a `BureauEventRegistry` with one feed, calls `createOperationHandler({ operations: [bureauEventsSubscriptionOperation, runEventsSubscriptionOperation], host: { bureauFeeds, runFeeds } })`, and sends a plain `Request` for `GET /v1/subscriptions/bureau.events?bureauId=…` with `Accept: text/event-stream`. It asserts that the response streams the events already in the feed, then a live event appended after the response opened, and that a second request carrying `Last-Event-ID` resumes after that cursor. A sibling `it` in the same describe block does the same for `operative.runs.events`, which covers COR-1299's acceptance criterion for both registrations. The test file imports nothing that constructs an `Engine` or `MemoryStorage`, which a reviewer can confirm by reading its imports.

Weft gets its own coverage of the generic route with a stand-in foreign subscription, the way `packages/weft/src/server/rest-bindings-additional-operations.test.ts` stands in for foreign operations today: `packages/weft/src/server/handler/operation-handler.test.ts`, `describe('createOperationHandler', …)`.

## Open questions for the owner

1. **Rename `engine` to `host`, or keep the name.** COR-1299's acceptance criteria say both that `engine: unknown` is replaced by the typed host context and that existing server tests pass unmodified. Option B satisfies the first and breaks the second by a mechanical rename in every test that builds a `DispatchContext` or calls `invoke`. Option A satisfies the second and keeps the misleading name. This document recommends B and asks the owner to amend COR-1299's criterion to "existing server tests pass with only the `engine:` → `host:` rename". If the owner prefers A, the rest of this document stands with `engine` in place of `host`.
2. **Which issue adds `description` and `skills` to the agent definition.** COR-1300 needs neither (its acceptance criteria cover the `a2aAgents` allowlist only). COR-903 (A2A profiles) is the first consumer. The proposal is a small Operative change ahead of COR-903, tracked by its own issue.
3. **Whether `bureau.events` and `operative.runs.events` turning on `transports.http` belongs in COR-1299.** This document puts it there because COR-1299 must serve both through the new handler, and without it they are unreachable from any fetch handler. It reverses a recorded stance: both packages have a test named `declares itself on the WebSocket transport only` (`packages/bureau/src/bureau-events-operation.test.ts:29-38`, `packages/operative/src/run-events-operation.test.ts:37`), and Operative's explains that a run feed is long-lived and resumable, "which a single HTTP response cannot express". A Server-Sent Events response is long-lived and resumes through `Last-Event-ID`, so this document treats that reason as answered, but the owner should confirm it. COR-1299 would update both tests.

## Consequences

- COR-1299 adds `createOperationHandler`, the generic SSE subscription route, the `Host` type parameter, and the `host` rename, and removes the casts in Bureau and Operative. `handleRequest` and `serve()` keep their behavior.
- COR-1300 builds `createBureauHandler` on `createOperationHandler`, adds the `a2aAgents` allowlist, and forwards `mounts`. It adds no Weft code.
- The adapter issues (COR-903, COR-855, COR-839) each deliver one `OperationHandlerMount` and reach Bureau only through `dispatch` and `subscribe`.
- `serve()` stops accepting operations whose host it cannot provide. Today such operations type-check and are unreachable; afterwards they are a compile error.
- `packages/weft/src/server/operation-catalog/kind-binding-parity.test.ts` pairs every `subscription` operation with a `websocket-subscription` binding and every `stream` operation with `sse`. It checks only Weft's own registry, so foreign subscriptions served over SSE do not trip it, but if a Weft subscription later opts into the generic SSE route, that pairing has to admit `sse` for subscriptions.

## As implemented in COR-1299

The handler follows the decisions above. The points where the shipped signature goes beyond or differs from the sketch are these.

- **Host rename**: `OperationContext<Input, Host = unknown>` and `DispatchContext<Host = unknown>` carry `host`, and `defineOperation` takes `Host` as its last type parameter (the fourth for a subscription or stream, the third for a unary operation). `createOperationRegistry<Host>` is the one place the host type is erased, because an operation's `dispatch` is contravariant in it. `handleRequest` and `serve()` still deliver the `Engine` as the host.
- **Authentication**: `authenticate` is the documented hook. `createOperationHandlerAuthenticator(authConfig, { additionalScopes })` builds one from Weft's API-key and JWT schemes on top of `createAuthenticator`, with the same principal forwarding and the same 401 as `serve()`. The handler takes no `additionalScopes` of its own; the scopes belong to the authenticator that retains them. What it returns also carries `ready`, a promise that rejects when a credential key cannot be imported, so a host can fail at startup the way `serve()` does instead of answering every request with a 500.
- **Public paths**: they are decided in exactly one place. `OperationHandlerOptions.publicPaths` (default `/v1/health` and the three discovery documents; `[]` authenticates all of them) governs the handler's own routes, and a mount's `publicPaths` governs the mount's. A mount whose public routes a fixed list cannot name (an Agent Card for an agent published after construction) supplies `isPublicPath(pathname)` instead; it is asked only about paths under its own prefix, so it cannot make another route public. `createOperationHandlerAuthenticator` has none: it passes `publicPaths: []` to `createAuthenticator` and throws on `config.publicPaths`, so `/v1/metrics`, `/.well-known/api-catalog`, and `/.well-known/mcp.json` are not unauthenticated at a mount that never declared them. An entry must be a path the handler serves, which a mount can never claim.
- **Streams**: `maxStreamDurationMs` (a positive integer no greater than 2147483647, default fifteen minutes) ends a subscription response cleanly so the client resumes with `Last-Event-ID`. `heartbeat` exposes `createEventEnvelopeSSEStream`'s interval, `schedule`, and `now` seam, and the deadline is armed through the same `schedule`.
- **Subscription route**: every query key is a string, a repeated key becomes an array of strings in order, nothing is coerced, and `Last-Event-ID` overrides a query `fromCursor`. The route does not decode the cursor; the operation's input schema and feed validate it, so the operation should reject a malformed one as `InvalidParams` (`bureau.events` and `operative.runs.events` do, and answer an unknown bureau or run as `NotFound`). Construction throws for a `transports.http` subscription whose input has no `fromCursor`, because `Last-Event-ID` could not resume it. Every element a subscription yields must carry `kind`, `cursor`, and `emittedAtMs`, and `kind` and `cursor` may not contain a line break, since they become the `id:` and `event:` lines. When the operation's iterable reports that replay finished (`createReplayAwareClosableIterable`), the route emits the same `ping` with `replayComplete: true` and no cursor that Weft's own SSE routes emit.
- **Mounts**: `OperationHandlerMount` and `OperationHandlerMountContext` take no `Host` parameter, because the context hands an adapter the principal, `dispatch`, and `subscribe` and deliberately not the host. A mount handles a request whose path equals its prefix or begins `<prefix>/` (a segment boundary, so `/a2a` and `/a2a-extra` do not overlap) or equals one of its `publicPaths`. Construction throws when a prefix overlaps a catalog route or another mount, and when a public path is a catalog route (or beneath one), another mount's public path, or beneath another mount's prefix. `dispatch` and `subscribe` run over the `http-rest` transport.
- **Discovery**: the three generators take the parameters that keep the handler's documents honest. OpenAPI takes `directRoutes` and the handler passes only health and the three documents, with no REST bindings. OpenRPC takes `includeMcpMetadata: false` and `transports: ['http', 'websocket']`, and `rpc.discover` answers with the same document over either JSON-RPC transport. AsyncAPI takes `subscriptionTransport: 'http-route'` and lists each `transports.http` subscription as a Server-Sent Events channel at `/v1/subscriptions/<operation name>`.
