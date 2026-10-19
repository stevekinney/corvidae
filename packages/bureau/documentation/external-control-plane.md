# External control plane

Status: accepted on 2026-10-13. The owner ruled on every open choice in this document during the COR-901 review; the rulings are recorded in [Rulings](#rulings) and each later section applies them. This is a decision document, not an implementation: nothing here exists in the code yet unless it cites a file. Implementation lands in the issues named under [Consequences](#consequences).

This document defines how an authenticated outside process discovers, addresses, commands, observes, awaits, cancels, and cleans up the Bureau resources it may see. It supersedes the earlier framing of the External Control Plane project, in which Bureau would own a transport-neutral native contract and treat A2A as one projection of it. Under the rulings below, A2A 1.0.1 is Bureau's agent-facing contract, Bureau's own guarantees ride optional A2A extensions, and a small native management plane covers what A2A has no vocabulary for.

## Rulings

| Question | Ruling |
| --- | --- |
| External contract | A2A-native. The agent-facing surface is [A2A 1.0.1](https://a2a-protocol.org/v1.0.1/specification/) plus optional, versioned Bureau extensions. A native management plane, served as Weft catalog operations, covers operator work A2A cannot express. |
| First consumer | A new Interborough application. Its live chat surface speaks AG-UI; discovery, task lifecycle, and peer agents use A2A; operator screens use the management plane. It is the application at `applications/interborough` and is tracked in its own Linear project. |
| Agent coordination | Parent-owned work keeps the typed in-process child API. Peer agents communicate over A2A, addressing each other by Agent Card whether the peer is in this Bureau or another. |
| Tenancy | Tenant is the deployment. One Bureau instance serves one tenant; isolation comes from separate stores and feed registries. |
| Authorization | Owner of record plus operator scopes, with not-found-shaped denial. |
| A2A protocol layer | Lives in Weft at a new `@lostgradient/weft/a2a` subpath, so anyone with Weft can implement A2A. Weft workflows are served as A2A agents through a reference backend that doubles as the conformance fixture. |
| Extension URIs | Rooted at the public Weft mirror's documentation: `https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/<name>-v<major>.md`. |
| Management plane in v1 | Reviews, deliveries, cross-owner tasks, audit, and schedules and goals. |
| Weft UI reuse | Weft ships no UI; the client provider, query helpers, router, and live-source plumbing that once came from `@lostgradient/weft/ui` now live in `applications/interborough` (COR-1488). |
| Assets | Written now against COR-794's Ready specification; COR-901 no longer waits on COR-794, and COR-794 conforms to this document. |

These follow from the rulings and from the code, so they were decided rather than asked:

- **Wire projections.** This document consumes [COR-1298](https://github.com/stevekinney/corvidae/pull/183)'s handler boundary as given: `createBureauHandler(bureau, options)` over Weft's engine-independent handler, JSON-RPC over HTTP plus one generic subscription route over Server-Sent Events, no REST bindings, and protocol adapters attached as path-prefix `mounts`. The A2A adapter is the primary mount.
- **Disconnects never cancel work.** A2A states that a task's lifecycle is independent of any one stream. A dropped stream or connection leaves the task running, and the caller reattaches with `SubscribeToTask` or `GetTask`. There is no attached mode in v1. The AG-UI mount ends a stream of its own accord in only two cases, and both leave the run running and tell the client to attach again: `RUN_ERROR` `STREAM_DEADLINE` when the stream has been open for `agUi.maxStreamDurationMs`, and `RUN_ERROR` `STREAM_OVERFLOW` when its reader falls behind `agUi.liveBufferSize`. A client treats both as reconnect signals, not failures.
- **One event authority.** Bureau's durable event history, a filter over one Weft `FleetEventFeed`, is the only source of resumable cursors. The in-memory `bureau.events` and `operative.runs.events` feeds are live frames: they feed the A2A and AG-UI streams and are served over the generic Server-Sent Events route, but their cursors do not survive a restart and are not a resumable contract.
- **Errors.** Weft's `FaultCode` gains the categories this contract needs instead of Bureau inventing a second code space. A2A's own error codes apply on the A2A surface.
- **Versioning.** The Weft catalog keeps its `/v1` namespace and each management operation declares a schema version. A2A carries its own protocol version through `A2A-Version`; each extension carries a major version in its URI.
- **The kit builds on the official SDK** (owner ruling, recorded while scoping the kit). `@lostgradient/weft/a2a` depends on `@a2a-js/sdk`, pinned exactly to `1.3.0` and published as an optional peer dependency. It reuses the SDK's types, its transport-agnostic `JsonRpcTransportHandler`, its `A2ARequestHandler`, `TaskStore`, and `PushNotificationStore` interfaces, its Agent Card signing, and its client, rather than defining Weft-owned A2A schemas.
- **No `required` extensions.** Every Bureau extension is optional. A required extension would reject every plain A2A client, which defeats the reason for being A2A-native.
- **Run creation receipts follow COR-424.** The ledger COR-424 is building keys on the authenticated caller, a caller-supplied request identifier, and the operation version. On the A2A surface the request identifier is the published agent's name with the message's `messageId`, so one `messageId` sent to two agents creates two tasks.

## What exists today

Bureau has no external surface. `createBureauHandler` (COR-1300) and Weft's engine-independent handler (COR-1299) do not exist yet, and no application imports `@lostgradient/bureau`. The pieces this contract builds on do exist:

- **Weft's operation catalog.** `defineOperation` operations with zod input, output, and event schemas, an access policy, an optional `authorize` hook, and a transports matrix (`packages/weft/src/server/operation-catalog/types.ts:178-303`). One pipeline, `executeOperation`, serves every transport (`packages/weft/src/server/operation-catalog/pipeline.ts:14-43`), and discovery documents are generated from the registry (`packages/weft/src/server/openapi.ts`, `openrpc.ts`, `asyncapi.ts`).
- **Weft's authentication plumbing.** API keys compared in constant time, JWT, mTLS, a principal with a closed set of 21 scopes (`packages/weft/src/server/authorization-scope.ts`), audit of authentication decisions, redaction, opt-in CORS, and body limits. There is no tenant concept anywhere in Weft.
- **Weft's command mailbox.** Durable FIFO admission with receipts, an idempotency binding over caller, target, kind, and payload digest, and a `conflict` outcome that leaves the original command untouched (`packages/weft/src/core/mailbox-contract.ts`, `mailbox-admission.ts`). Terminal receipts are retired after `terminalRetentionMs`, 24 hours by default, which also releases the idempotency key.
- **Weft's delivery outbox.** At-least-once delivery with `attempting` persisted before the transport call and an explicit `unknown-outcome` state (`packages/weft/src/core/outbox-types.ts:74-115`), plus `drain()`.
- **Weft's fleet event feed.** Opaque decimal cursors, an in-band `fleet:gap` envelope below the retention floor, and a snapshot-then-tail handoff (`packages/weft/src/server/fleet-event-feed.ts`, `workflow-event-feed.ts:255-261`). Nothing in production calls `retain()`, so the floor never advances today.
- **Bureau's durable event history.** A filter over one fleet feed by owner (`run`, `session`, `schedule`, `goal`), with `page` returning `{ outcome: 'gap', requestedCursor, firstRetainedSequence }` and `subscribeEventHistory` skipping gaps silently (`packages/bureau/src/durable-event-history.ts:355-401`).
- **The started-work floor.** `LivenessSnapshot` (`packages/operative/src/liveness/types.ts:173-235`) and `CleanupAcknowledgement` (`packages/operative/src/types.ts:175-195`, statuses `not-required`, `completed`, `failed`, `unresolved`) give every resource identity, revision, status, ownership, durability, and cleanup evidence. The ownership matrix in [runtime contracts](../../../documentation/runtime-contracts.md#ownership-and-cleanup) is the in-process version of the resource table below.
- **Principal attribution.** Runs, children, goals, and event-history reads carry an optional principal string, session input, steering, and review resolution require one, and a mismatch already answers `not-found` rather than `forbidden`.

## Consumers and use cases

| Use case | v1 consumer | Surface | Operations it needs |
| --- | --- | --- | --- |
| Application control | Interborough | AG-UI for the live chat surface; A2A for discovery and task lifecycle | Agent Card discovery, `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`; the AG-UI run stream (COR-855) |
| Operator administration | Interborough operator screens | Management plane | Reviews, deliveries, cross-owner tasks, audit, schedules and goals |
| Remote-agent interoperability | Any A2A client, including another Bureau | A2A | Every core A2A operation; streaming and push when declared |
| Agent-to-agent coordination | Operatives calling peers | A2A client (COR-905) | Card discovery, `SendMessage`, `GetTask`, `SubscribeToTask`, `CancelTask` against the peer |
| AI-host integration | None in v1 | Bureau MCP adapter (COR-839) when a consumer is named | A projection of the same tasks and management operations, generated from catalog operations marked `mcpExposable` through Weft's SDK-based MCP path (COR-1311); absent from v1 discovery |
| Chat compatibility | None in v1 | None | An OpenAI-compatible chat endpoint is not served; it has no consumer, and AG-UI covers interactive chat |
| Event ingress | None in v1 | None | Inbound webhooks that start or signal work are not served; external events reach Bureau as A2A messages or management commands |
| Outbound notification | Webhook receivers and A2A push subscribers | Delivery outbox (COR-841) | A2A push notification configs; the four existing webhook triggers; management delivery operations |

The use cases with no v1 consumer are absent from every capability document rather than half-served.

## Architecture

Three surfaces sit over one set of native Bureau resources. Each is a projection: it translates its wire format into dispatches against the same catalog operations, the same authorization predicate, and the same durable history, so none of them can disagree about a resource's state.

| Surface | Mounted as | Audience | Wire |
| --- | --- | --- | --- |
| A2A | A `mounts` entry claiming one path prefix per published agent, plus the public Agent Card path | External agents, peer Bureaus, the Interborough's task views | A2A 1.0.1 JSON-RPC binding; streaming over Server-Sent Events |
| AG-UI | A `mounts` entry (COR-855) | The Interborough's chat surface | AG-UI 1.0 event stream |
| Management plane | Catalog operations in the shared Weft registry | Operators, through the Interborough | JSON-RPC over HTTP; subscriptions over the generic Server-Sent Events route |

Adapters reach Bureau only through the mount context's `dispatch` and `subscribe`, never by calling the `bureau` object directly, so every request passes the catalog's access policy and `authorize` hook ([COR-1298, decision 4](https://github.com/stevekinney/corvidae/pull/183)). An adapter that bypasses `dispatch` is a defect.

The protocol mechanics live in Weft and the Bureau semantics live in Bureau. `@lostgradient/weft/a2a` wraps the official `@a2a-js/sdk` in a fetch handler, with streaming over Server-Sent Events, version and extension negotiation, the public Agent Card and its signing keys, durable stores over Weft storage, and outbox-backed push delivery. Bureau implements the SDK's `A2ARequestHandler` over its runs; Weft's reference backend implements the SDK's executor over workflows. See [Changes to Weft](#changes-to-weft).

## Resource taxonomy

Every resource below declares the started-work floor: stable identity, owner, optional parent, immutable kind, revision, current state, timestamps, retention, durability, result, cancellation, cleanup, and event history. The table records how each kind supplies them and how it is reached from outside. "Internal" means the kind exists in the runtime but has no external address in v1; it is absent from every capability document.

| Kind | Identity | Owner and parent | Revision or fence | States | Result | Cancellation and cleanup | Durable events | External surface in v1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deployment | `BureauOptions.id`, which must be set explicitly whenever `createBureauHandler` serves persistent storage (construction throws otherwise), because a generated identifier changes on every restart and would orphan persisted tasks | Service principal | Catalog revision | `ready`, `draining`, `stopped`, derived from `ready` and `shutdown()` | None | `shutdown({ policy })` report | None | Management `bureau.deployment.get`; the A2A `tenant` value |
| Published agent | Agent name plus `definitionRevision` | Deployment | `definitionRevision` | `published`, `withdrawn` | None | Withdrawn by removing it from `publish` | None | Agent Card; management listing |
| Task (agent run) | `agent-run-…` minted by Bureau; A2A `taskId`. Every task has a `contextId` before it is returned: the client's, preserved exactly, when supplied, otherwise a context Bureau mints and persists | Requesting principal; optional parent task or context | Liveness `revision` and `attempt` | A2A task states, mapped below | Artifacts and final status message | `CancelTask`; cleanup through the cleanup extension | `run` owner | A2A; management cross-owner tasks. Terminal tasks stay addressable for `BureauOptions.taskRetention` (default 30 days, and never shorter than the idempotency-binding retention, which construction enforces, so an exact retry always finds its task and mount), after which Bureau maintenance deletes them, only once the task's creation binding is confirmed absent from the ledger (so an exact retry always finds its task), first deleting each of the task's push configurations through the push-configuration `Delete` path (fencing and cancelling its deliveries), then purging those configurations' settled outbox delivery records, which carry the task's payload, and then its projector checkpoints, so no webhook credential or delivery outlives its task |
| Context (session) | Caller-supplied or minted session identifier, which is the A2A `contextId` unchanged. Bureau tracks the session's `incarnation` separately: each task records the incarnation it ran in, a context deleted and recreated under the same identifier is a new incarnation, and `ListTasks` filtering by `contextId` and continuation checks match only the current incarnation, so old retained tasks never appear to share it | Creating principal | `incarnation` plus `revision` | `active`, `deleted` | None | Delete; live run cleanup only | `session` owner | A2A `contextId`; management delete |
| Child run | Caller-supplied or minted `childRunId` | Parent run's principal; parent task | Record `revision` | `running`, `completed`, `failed`, `aborted` | Child outcome | `children.cancel`; `cascade` or `detach` | `child.*` audit entries | Internal; visible as task status detail on the parent |
| Goal and attempt | `goalRunId`; attempt `${goalRunId}:a${n}` | Creating principal | `revision` and `transitionSeq` | Goal: `pending`, `running`, `evaluating`, `retrying`, `succeeded`, `exhausted`, `failed`, `canceled` | Goal outcome | `goals.cancel`; `close` returns cleanup | `goal` owner | Management goals |
| Scheduler task | `scheduler-task-…` | Service principal | None | `in-progress`, `terminal`, `expired`, `not-found` | Callback result | `cancel` | None | Internal (process-local) |
| Schedule and fire | Engine-assigned schedule identifier; each fire's workflow identifier is its run identifier | Creating principal; each fire is a task owned by the schedule's owner, with the scheduler's service principal recorded as the actor, so the owner can list, read, observe, and cancel it | None today; the management plane adds a definition revision for `expectedRevision` | `active`, `paused`, `cancelled` | None (fires produce tasks) | `cancelSchedule` moves it to `cancelled` and keeps the record; `closed()` covers the handle only | `schedule` owner | Management schedules; fires appear as tasks |
| Review | `approval:<runId>:<callId>` or `human-wait:<runId>:<signalName>:<ordinal>` | The run's principal; resolved by a reviewer | Status transition | `pending`, `approved`, `denied`, `rejected`, `expired`, `revoked`, `canceled`, `superseded` | Decision | Expiry sweep | `review.*` | Management reviews; `INPUT_REQUIRED` on the task when the requester resolves it |
| Compaction attempt | `attemptId` | The conversation's run | `baseRevision` | `idle`, `pending`, `running`, `committed`, `no-op`, `discarded`, `cancelled`, `failed` | Committed revision | `cancel` awaits the candidate | None | Internal |
| Evaluation | Online eval sample | Deployment | None | Sampled, flushed | Threshold breach | `dispose` | `eval.threshold-breached` delivery | Internal; breaches reach operators as deliveries |
| Long-running tool execution | `executionId` | The run's `ownerId` | `revision` | `queued`, `active`, `waiting`, `streaming`, `abort-requested`, `cleanup-pending`, `terminal`, `unknown-effect` | Tool result | `abort`; `whenSettled` | Tool events | Internal; visible as task status detail |
| Delivery | `<subjectId>:<targetIndex>` today; an outbox delivery identifier after COR-841 | The subscriber's principal | Outbox attempt | Outbox states, including `unknown-outcome` and `dead-lettered` | Acknowledgement evidence | Cancel; operator retry; `drain` | `outbox:delivery-*` | Management deliveries; A2A push configs |
| Asset | Asset identifier and revision (COR-794) | Admitting principal | Monotonic revision | COR-794 lifecycle states | Resolved locator | Abort, delete, expire; cleanup acknowledgement | Asset events (COR-794) | A2A file parts reference assets; management asset inspection is not in v1 |
| Interactive surface | Surface identifier (COR-962) | The task's owner; audience recorded per surface; parent task | `revision` and `baseRevision` on every update | COR-962's surface states, ending in closed or deleted | Final surface state | Close, owner abort, detachment; cleanup acknowledgement | Surface updates in the task's durable history | A2UI over AG-UI (Interborough) and over A2A through A2UI's A2A extension |
| Approval grant | Grant identifier | Issuing principal | Revocation | `issued`, `consumed`, `revoked` | None | `revokeGrant` | Audit | Internal |
| Audit record | Audit `sequence` | The owner of the run, session, or schedule the record is about, or its attributed `principal` where the record carries one (`packages/bureau/src/audit-trail.ts`); records about no owned resource belong to the deployment | Append-only | None | None | Retention pruning | Is itself the record | Management audit |

### Task states

A task is the external face of one agent run. Bureau maps its run and review states onto A2A's task states and keeps the finer detail in the cleanup extension:

| Bureau condition | A2A task state |
| --- | --- |
| Admitted, not yet started | `TASK_STATE_SUBMITTED` |
| Running, aborting, or cleaning up before a terminal result | `TASK_STATE_WORKING` |
| Waiting on a human-wait signal or an elicitation the requester answers | `TASK_STATE_INPUT_REQUIRED` |
| Waiting on an approval the requester decides | `TASK_STATE_INPUT_REQUIRED` |
| Waiting on a credential the requester must grant | `TASK_STATE_AUTH_REQUIRED`, with an out-of-band authorization URL in the status message (A2A 1.0.1 §7.6.1); a message answering it may negotiate or decline but never carries the credential |
| Waiting on a review an operator resolves | `TASK_STATE_WORKING`, with the review identifier in the cleanup extension's status detail |
| Finished with `stop-condition` | `TASK_STATE_COMPLETED` |
| Finished with `elicitation-denied` (the requester declined to answer) | `TASK_STATE_FAILED`, with the finish reason in the status message |
| Finished with `maximum-steps`, `error`, `tripwire`, or `budget-exceeded`, matching `isRunFailureFinishReason` (`packages/bureau/src/runtime-composition.ts`) | `TASK_STATE_FAILED` |
| Finished with `aborted` | `TASK_STATE_CANCELED` |
| Refused at admission | `TASK_STATE_REJECTED` |

`TASK_STATE_CANCELED` is terminal in A2A, but cleanup may still be pending when the result settles. The cleanup extension carries the `CleanupAcknowledgement` separately, so a client that cares can wait for `completed` and one that does not can stop at the terminal state.

### Tasks and contexts in code

A task is one top-level Bureau run. Its identifier is the run identifier, verbatim: a `createRun` session run is `run-<n>-<uuid>`, and a `bureau.run` catalog dispatch is `agent-run-<n>-<uuid>`. The `agent-run-…` shape in the taxonomy above names the catalog family; session runs keep their own prefix, and there is no second namespace and no mapping table. Schedule fires, child runs, and goal attempts are not tasks in v1: each belongs to its own operations, and the `bureau.tasks.*` operations answer one as a missing task.

A task's `contextId` is its session identifier for a session run. A catalog run owns no Bureau session, so its `contextId` is the `sessionId` its caller named, or else its own run identifier; `bureau.contexts.get` and `bureau.contexts.delete` answer that identifier as a missing context.

`RunRef.runId`, the `${sessionId}:${sequence}` identifier, is not a task identifier and does not relate to one. It belongs to Operative's `SessionHandle`, which Bureau uses only inside a goal's conversation. Two turns in one Bureau session are two `createRun` runs, so they are two tasks with different identifiers and one `contextId`, and `bureau.tasks.list({ contextId })` returns exactly those two.

Bureau keeps one durable record per task, written before the run starts and removed when the run is deleted: the owner, the context and the session incarnation it ran in, the originating user message, and how the run settled and how its cleanup ended. The record is how a settled task keeps its owner and its history across a restart, and it is where a task's own message history lives, apart from the internal session transcript. Deleting a context empties the history of its tasks, so a user's message text does not outlive the context it belonged to; their status and cleanup facts remain. The management plane serves the history to no one in v1: it exists for the A2A `GetTask` that follows.

A context's summary comes from Operative's session summary index, format version 2. Every summary there records `title`, `lastMessagePreview`, and `owner` (the owner recorded in the session's metadata when it was created, the local owner for a session that records none, and none at all for a malformed record, which no owner filter matches), computed when the session is saved. A store holding a version 1 index rebuilds it once from the session bodies, the path that already repairs a corrupt index, so no migration step exists. `list` applies the owner filter to the index before `offset` and `limit`, and reads one body per visited row as its existence check, as before.

The management plane shows a task's state as `submitted`, `working`, `input-required`, `completed`, `failed`, or `canceled`. A task whose run finished successfully while a review is still open is `input-required`, and answering that review is what finishes it; a failed or canceled task is that whatever is open. `rejected` and `auth-required` cannot arise in v1.

### Assets

The asset entries follow COR-794's specification. An asset is admitted from bounded inline bytes, an upload completion, an authorized URL, a provider file identifier, or an existing asset reference, and admission returns a handle or durable locator immediately when work continues asynchronously. Its `AssetDescriptor` carries identity, monotonic revision, digest, media type, byte length, owner, authorization, provenance, lifecycle state, creation time, expiry, retention, and a general-versus-privileged projection distinction, consistent with `ContentSource`, `Modality`, and `MediaLimits` in `packages/conversationalist/src/multi-modal.ts:214-270`.

A peer's artifact enters as the `a2a-reference` content source, which must carry the peer's `taskId` as well as `agentCardUrl` and `artifactId`, because an artifact identifier is unique only within its task (A2A 1.0.1 §4.1.7); COR-1303 extends `ContentSource` (`packages/conversationalist/src/multi-modal.ts`) accordingly.

Externally, an asset appears as an A2A file part whose `url` is Bureau's authenticated asset route, `/assets/<assetId>/<revision>` on `createBureauHandler`. Browser media elements cannot attach the `Authorization` header, so a browser client fetches the route with its token and renders the bytes through a `blob:` object URL that it revokes when the view unmounts; Interborough's renderer does this through a host-supplied asset resolver. Fetching it requires the same credentials as the A2A call and applies the same owner predicate, so the URL is an address, not a credential: it is never a reusable signed URL, and bytes are never inlined after admission. Resolving an asset reference applies the same owner predicate as the task that produced it; a caller who cannot see the task cannot resolve its assets. Asset admission, deletion, and cleanup are started work with targeted abort and a cleanup acknowledgement, exactly as COR-794 specifies. Asset events and audit records never carry raw bytes, secrets, or signed URLs. Inbound file parts, whether bytes or URLs, go through COR-794's admission pipeline, and a peer's artifact enters as the existing `a2a-reference` content source. The asset route is the only asset operation in v1; inspection and deletion through the management plane are not. COR-788 owns projecting multimodal content through the A2A, AG-UI, and MCP surfaces.

## Capability profile

Discovery has two levels. Each published agent has an Agent Card; the deployment has a profile, served as a management operation, that lists everything the deployment serves. Both derive from the same deployment configuration, so a card cannot advertise what the deployment does not serve.

| Profile element | Agent Card | Deployment profile (`bureau.deployment.get`) |
| --- | --- | --- |
| Stable identity | The catalog agent name and `definitionRevision`, carried by the interface URL (each published agent's mount path ends in its catalog name) and by `version`; `AgentCard.name` is never the identity. A published name must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, checked when `publish` is validated, so it is a path segment without encoding. Every generated absolute URL derives from configured base URLs (COR-1300), never from the request's `Host` header: interface and asset URLs from the required `publicUrl`, and card and JWKS URLs (including `jku`) from `discoveryUrl`, which defaults to `publicUrl` and is set to the discovery listener's origin in an mTLS deployment | `BureauOptions.id` |
| Mutable human names | `AgentCard.name` is the agent definition's display name (COR-1301), falling back to the catalog name when none is set; `description` and skills come from the same definition | Deployment display name |
| Default media modes | `defaultInputModes` and `defaultOutputModes`, both required, derived from the agent definition's accepted and produced modalities (COR-1301), never guessed | The same per agent |
| Resources | Implicit: tasks and contexts | The served resource kinds from the taxonomy |
| Services and operations | Core A2A operations | Management operations, each with its schema version |
| Capabilities | `capabilities.streaming`, `capabilities.pushNotifications`, `capabilities.extendedAgentCard`, `capabilities.extensions` | The same flags per published agent |
| Transports | `supportedInterfaces` (`url`, `protocolBinding`, `protocolVersion`, `tenant`) | Catalog transports and the subscription route |
| Protocol and schema versions | `protocolVersion: "1.0"` | A2A version, catalog `/v1`, per-operation schema versions |
| Authentication schemes | `securitySchemes` and `securityRequirements`, derived from the handler's Weft authentication configuration | The same derivation |
| Extensions | `AgentExtension` entries, all `required: false` | The extension URIs and versions |
| Signing keys | `AgentCardSignature` (JWS over the RFC 8785 canonical card, `kid`, optional `jku`) | The signing key set |
| Status and expiry | Card served only while published | Agent publication status |
| Cache validators | `ETag` and `Cache-Control` on the card response | The same |

The card's security declaration is generated from the authentication configuration the handler actually enforces, never written by hand, so the two cannot drift (COR-718). The extended card is not declared in v1: it has no consumer, and `capabilities.extendedAgentCard` stays false.

Publication is the deployment's choice and description is the agent's. `createBureauHandler`'s `publish` allowlist is the only source of external visibility; an agent absent from it has no card, cannot start new tasks, and reads as not found. Withdrawing an agent that still has any addressable task, non-terminal or terminal within `taskRetention`, keeps a tombstone mount at its path: its owners can still `GetTask`, `SubscribeToTask`, and `CancelTask` those tasks, continue a task in `INPUT_REQUIRED` or `AUTH_REQUIRED` with a `SendMessage` carrying its `taskId`, `Get`, `List`, and `Delete` their push configurations, and `Create` one for a non-terminal task (with `Create`'s idempotency, so a retry of one committed before withdrawal returns it), while a genuinely new `SendMessage` without a `taskId` returns not-found and no card is served; an exact retry of a creation command whose binding is still retained resolves to its original task and receipt, as the retry-first rule requires. The tombstone ends only when the agent's last task has passed its terminal retention and is no longer addressable, so a client that disconnected before completion can still `GetTask` the final status and artifacts. The card's identity fields come from Bureau's immutable catalog, and its descriptive fields from the agent definition. A request cannot change either.

## Operation taxonomy

Operations are commands (mutate state and return a receipt), queries (read state), subscriptions (stream events), terminal-result waits, or background notifications. An operation a deployment does not serve is absent from its capability documents; a call to it anyway returns one typed unsupported result: on the A2A surface, `UnsupportedOperationError`, except that push notification configuration operations return `PushNotificationNotSupportedError` (`-32003`) when push is not declared (A2A 1.0.1 §3.3.4); on the management plane, the `NotImplemented` fault. `ExtendedAgentCardNotConfiguredError` (`-32007`) applies only to an agent that declares the extended card without configuring one, which v1 never does.

### A2A operations

| A2A operation | Kind | Bureau behavior | v1 |
| --- | --- | --- | --- |
| `SendMessage` | Command | The returned task applies `configuration.historyLength`. Without `taskId`, admits a new run of the published agent through the COR-424 ledger and returns the task; a `configuration.taskPushNotificationConfig` is rejected with `PushNotificationNotSupportedError` (`-32003`) before admission when the card does not declare push, and otherwise is installed in the push-configuration store as part of that admission, recorded on the ledger entry so an exact retry or a restart after a crash installs it exactly once, and before the run's first event is projected. With `taskId`, a `configuration.taskPushNotificationConfig` passes the same push-capability check and is installed for that task atomically with admitting the continuation; the request then delivers the message to that task: an answer to `INPUT_REQUIRED` or `AUTH_REQUIRED`, or session input to a live task. A continuation whose `contextId` differs from the task's recorded context is rejected with JSON-RPC `-32602`; a continuation to a `COMPLETED`, `FAILED`, `CANCELED`, or `REJECTED` task returns `UnsupportedOperationError` (A2A 1.0.1 §3.1.1, §3.4.3). Both checks run before admission and apply to `SendStreamingMessage` too. Before any of these eligibility checks, and before the publication and `expectedRevision` checks, Bureau resolves the caller, agent, and `messageId` binding within its retention: an exact retry returns the original receipt and task even if the task has since become terminal, the revision has moved, or the agent has been withdrawn, and only a genuinely new command is checked for eligibility. A new task whose `contextId` names a context the caller does not own returns not-found before anything loads that context, so a context identifier never exposes another owner's transcript | Served |
| `SendStreamingMessage` | Command plus subscription | As `SendMessage`, then streams the task; the stream stays open through interrupted states (`INPUT_REQUIRED`, `AUTH_REQUIRED`) and closes when the task reaches a terminal state (A2A 1.0.1 §3.1.2; `returnImmediately` has no effect on streaming). The initial task applies `configuration.historyLength` | Served |
| `GetTask` | Query | The task snapshot, with `historyLength` applied to the task's own A2A history: the messages exchanged on that task through A2A (the caller's messages and the agent's A2A replies), persisted per task. `Task.history` is never derived from Bureau's internal session transcript, which also holds system prompts, tool data, and memory | Served |
| `ListTasks` | Query | The caller's own tasks with the mounted agent, filtered by `contextId`, `status`, and `statusTimestampAfter`, sorted by status timestamp descending with the task identifier as a tie-breaker, paginated with `pageSize` (1–100, 50 when omitted, as A2A 1.0.1 §3.1.4 requires) and an opaque `pageToken`. The first page records a snapshot of the whole listing as of that moment, each matching task's projection (with the listing's `historyLength` and `includeArtifacts` applied) in order, and the token names it, so every later page returns the tasks exactly as they matched the filters then; every later page reads that snapshot, so a task updated mid-enumeration keeps its original position instead of disappearing or repeating. The snapshot records its principal, mounted agent, filters, and, for a `contextId` filter, the context incarnation it resolved to; a token presented by another principal, on another mount, with other filters, or after that context's incarnation changed is rejected with `-32602`. A snapshot holds at most 1,000 entries and 4 MiB, with `historyLength` capped at 100 in listings; a listing beyond either bound stores its first window, and the token after the window's last entry starts the next window keyed after that entry's status timestamp and task identifier, so the guarantees above hold within each window and storage per listing stays bounded. Neither history retention nor a transition outside durable history can change it; a task deleted before its page is read is skipped, so a page may hold fewer entries. A token expires after fifteen minutes and the client restarts the listing. With persistent storage the snapshot is stored there until expiry and survives a restart; without it, the snapshot is held in memory and a token presented after a restart is rejected, so the client restarts the listing. Applies `historyLength` to each task's A2A history and omits artifacts unless `includeArtifacts` is true (COR-1304) | Served |
| `CancelTask` | Command | Requests cancellation of the run; returns the task in its current state | Served |
| `SubscribeToTask` | Subscription and terminal-result wait | For a non-terminal task, sends the current task first, then follows it; the durable-history extension makes it resumable through `Last-Event-ID`. For a terminal task it returns `UnsupportedOperationError` before any snapshot (A2A 1.0.1 §3.1.6) | Served |
| Push notification config `Create`, `Get`, `List`, `Delete` | Command and query | Registers webhook delivery for a task through the delivery outbox. `Delete` removes the configuration's credentials and keeps only a secret-free tombstone (its identifier and deletion fence), which `Get` reports as not found and `List` omits. `List` orders a task's configurations by creation time, then identifier; honors `pageSize` (1–100, default 50) and an opaque `pageToken` bound to the caller and task; and returns `nextPageToken` empty on the last page. `Delete` first stops new enqueues for the configuration, then cancels every queued or retry-scheduled outbox delivery for it, aborts every claimed or attempting one, and returns success once each of its outbox records is in a terminal state (`acknowledged`, `rejected`, `cancelled`, `unknown-outcome`, or `dead-lettered`) with `cleanupPending` false, meaning its attempt has settled. Push delivery uses only COR-1471's HTTP adapter, which runs each request under its own abort timeout (10–30 seconds) below the outbox's attempt timeout, and construction rejects any other adapter for push, so every attempt settles within that bound and no record ends with `cleanupPending` true. So no delivery attempt is in progress when `Delete` returns and none begins afterwards (A2A 1.0.1 §3.1.10). A request the webhook had already received before the abort may still be processed there; nothing local can retract it, and A2A §13.2's idempotent-receiver requirement covers it | Served (COR-841) |
| `GetExtendedAgentCard` | Query | Not declared | Absent |

A terminal-result wait is `SubscribeToTask` until the stream closes at a terminal state, or `GetTask` polling. There is no separate blocking wait operation.

### Management operations

Management operations are Weft catalog operations named under `bureau.*`, served over JSON-RPC and, for subscriptions, the generic Server-Sent Events route. Each declares a schema version, an access policy, and an `authorize` hook that applies the predicate in [Authorization](#authorization).

| Operation | Kind | Purpose |
| --- | --- | --- |
| `weft.system.principal` | Query | The caller's resolved principal and scopes; Weft's own operation, registered beside Bureau's |
| `bureau.deployment.get` | Query | The deployment profile: identity, state, published agents, served operations with schema versions, and recovery status; any authenticated principal |
| `bureau.agents.list` | Query | Published agents with their `name` (the catalog key every other operation calls `agentName`), display name, description, `definitionRevision`, and publish state. The Agent Card URL is not carried until A2A arrives; any authenticated principal |
| `bureau.tasks.list`, `bureau.tasks.get` | Query | The caller's own tasks, with cleanup status; any owner's for `bureau.tasks:read`. `list` filters by `contextId` (the context's current incarnation), `agentName`, and `status` |
| `bureau.tasks.cancel` | Command | Cancellation of the caller's own task, or any task for `bureau.tasks:write` |
| `bureau.tasks.respond` | Command | Answer a task's open human-input or approval wait, as an A2A continuation does: answer text (parts joined with a newline), an optional `signalName` or `callId` when several waits are open, or a `decision` (`reject` requires a `reason`), plus a caller-supplied `messageId` that makes it idempotent through the COR-424 ledger. The task's owner answers anything; `bureau.tasks:write` answers human-input waits only, and a non-owner's approval decision is answered as a missing task. It answers through `Bureau.resolveReview` |
| `bureau.tasks.events` | Subscription | A task's durable history with a resumable cursor, as an allowlisted projection: each event carries only the fields its A2A counterpart carries (status, status message, artifact, cursor, and timestamps), never the raw durable payload, whose run-completion detail keeps step content, tool calls, and tool results |
| `bureau.contexts.list`, `bureau.contexts.get` | Query | Sessions as the chat screens show them: identifier, owner, `agentName`, `title` (the first user message, at most 80 characters), `lastMessagePreview` (the latest message, at most 120), message count, created and updated times, and `activity` (`running` when the context's latest task is working, `awaiting-input` when it waits on human input or an approval, `idle` otherwise). `list` returns the caller's own, newest update first, filtered by `agentName`, paged with `limit` and `offset` with `nextOffset` (`null` on the last page); `allOwners` requires `bureau.contexts:read`. `get` reads one. Neither returns a transcript or Bureau's internal session metadata (request authorities, skill snapshots); `title` and `lastMessagePreview` are the only message text served, and they come from Operative's summary index. A denied lookup answers as a missing one |
| `bureau.contexts.delete` | Command | Delete a context (a Bureau session): fence its incarnation against new tasks and continuations, cancel and await every live task in it (not only the latest), and report the aggregate of their cleanup acknowledgements, the least settled state winning; A2A has no core context deletion |
| `bureau.reviews.list`, `bureau.reviews.get` | Query | `list` returns pending reviews; resolved reviews are reached by id through `get` |
| `bureau.reviews.resolve` | Command | Approve, deny, or reject a review as the reviewing principal |
| `bureau.deliveries.list`, `bureau.deliveries.get`, `bureau.deliveries.tail` | Query and subscription | Outbound deliveries and attempts |
| `bureau.deliveries.retry`, `bureau.deliveries.cancel` | Command | Operator retry and cancellation. A retry of a push delivery is rejected with `Conflict` when its configuration has been deleted (deletion persists a fence on the configuration) or when a later delivery for the same configuration has been enqueued, so a retry never reaches a deleted webhook or reorders a configuration's updates; an accepted retry re-enters the projector's per-configuration queue |
| `bureau.audit.query` | Query | The audit trail, always redacted to metadata: no record returned through any v1 operation carries a secret, transcript, tool argument, or memory content |
| `bureau.schedules.list`, `bureau.schedules.get` | Query | Durable schedules |
| `bureau.schedules.create`, `bureau.schedules.pause`, `bureau.schedules.resume`, `bureau.schedules.cancel` | Command | Schedule lifecycle |
| `bureau.goals.list`, `bureau.goals.get` | Query | Goals and attempts |
| `bureau.goals.create`, `bureau.goals.cancel` | Command | Goal lifecycle |

The existing `bureau.events` and `operative.runs.events` operations are served through `createBureauHandler` over the generic Server-Sent Events route, as COR-1299 and COR-1300 require, with live-only semantics: a cursor resumes within one process lifetime and carries no promise across a restart. `bureau.tasks.events` is the durable, resumable equivalent. This answers COR-1298's third open question: both operations turn on `transports.http`, and their tests that assert WebSocket-only change accordingly.

`bureau.tasks.events` elements are `task.snapshot`, `task.status`, `task.gap`, and `task.removed`, each carrying `taskId`, the durable `cursor`, and `emittedAtMs`. A `task.status` carries the state, the finish reason, a status message of at most 1,000 characters, and, for a task that completed, the answer as one artifact of at most 64 KiB (`truncated` says when it was cut). A durable kind the projection does not list is dropped, and each durable event yields at most one element, so a cursor never names two. A review becoming pending is a durable `review.requested` event (the review identifier, its kind, and the signal name or call identifier, never the prompt or the arguments), which the stream shows as `input-required`; the event is an additive kind inside the existing record wrapper, so the history's `CURRENT_SCHEMA_VERSION` stays 1. A subscription that names no cursor begins with a `task.snapshot` and then replays what the history retains, and a stream ends at the task's terminal status once no review is open, or at its removal. Only session runs record durable `run.*` events: a catalog run is released from the run store when it settles and records none, so its stream is the snapshot alone, and `bureau.tasks.get` is where its state is read. A Bureau with no persistent storage keeps no durable history, and `bureau.tasks.events` answers it with `UnsupportedCapability`.

A caller that can only write is told the receipt and nothing more: `bureau.tasks.cancel` carries the task view (owner, context, agent, status, open waits) only for a caller that could read the task, and `bureau.contexts.delete` names the tasks it cancelled only to the context's owner or a caller holding both `bureau.contexts:read` and `bureau.tasks:read`. Both operations authorize against the exact session or task they act on: `bureau.contexts.get` and `delete` load the session once, judge its own recorded owner, and delete only that incarnation (`Bureau.deleteSession(id, { incarnation })`, compare-and-swapped in the session store), so a context id deleted and created again for another owner in between is neither read nor deleted. A completed `bureau.run()` task's answer rides on its `task.snapshot` as the `artifact`, because its stream carries nothing else.

A crash can leave a task record behind its run, so boot recovery reconciles: a task record with no settlement whose durable run is terminal is settled from the durable state, and a durable `bureau.run()` run that is still in flight and has no task record is given one from its recovery record, dated from the durable run. A catalog run that is over is never given a record at boot, so a task that retention removed stays removed. A catalog run settles its task through one internal hook (`catalog-run-settlement.ts`) that fires for every `bureau.run()` run when it ends, dispatched by this process or recovered after a restart, and publishes only an end the durable run actually reached: a handle that rejects because the engine was disposed (a graceful shutdown) publishes nothing, so the task stays open and cancelable and the run's snapshot reference stays unsettled until the run resumes at the next boot. The hook also publishes recovered child runs and recovered goal attempts, which are not tasks, so each subscriber filters what it needs: the task settler skips a run the child topology holds and a goal attempt, and the snapshot-reference subscriber settles every recovered run's reference; a deletion that fails retryably after its live runs were aborted leaves the context in place with cancelled tasks, and a retry deletes it. Settlement and cleanup writes are awaited by `shutdown()` before storage closes, with the wait for cleanup acknowledgements bounded by event-loop turns (an acknowledgement that arrives later is not recorded), and every canceled terminal, a shutdown's abort included, follows its run's cleanup.

`bureau.tasks.cancel` and `bureau.contexts.delete` take `waitMilliseconds` (default 0, at most 60,000), the longest they wait for a cleanup acknowledgement still outstanding; with the default the receipt is whatever has settled, and `bureau.tasks.get` carries the same cleanup state afterwards. `Bureau.deleteSession` resolves a report of the tasks that were live in the session, each with its run's cleanup acknowledgement, so the operation reports without a second deletion method.

## Command envelope

Every command carries the same fields. On the A2A surface they map onto the message and the command-receipts extension's metadata; on the management plane they are the operation's input envelope.

| Field | A2A carrier | Management carrier | Required |
| --- | --- | --- | --- |
| Command identifier | `message.messageId` (on `SendMessage` and `SendStreamingMessage`, the two A2A commands this envelope covers; `CancelTask` and the push-configuration methods keep their fixed shapes) | `commandId` | Yes |
| Typed intent | The operation name | The operation name | Yes |
| Authenticated sender | The authenticated principal, never a payload field | Same | Yes |
| Recipient | The published agent addressed by the interface URL and `tenant` | The operation's target | Yes |
| Reply target | The stream, or a push notification config | The response, or a subscription | Yes |
| Conversation | `contextId` | `contextId` | No |
| Correlation | `metadata` correlation identifier | `correlationId` | No |
| In-reply-to | `taskId` on a continuation; `referenceTaskIds` | `inReplyTo` | No |
| Target kind and identifier | `taskId`, or the agent for a new task | `target` | Yes |
| Target revision or attempt fence | Command-receipts extension `expectedRevision` | `expectedRevision` | No |
| Operation and schema version | `A2A-Version` plus the extension URI version | The operation's schema version | Yes |
| Payload digest | Computed by Bureau, after fields of extensions the request did not activate and the correlation identifier in `metadata` are removed, `acceptedOutputModes` is sorted and deduplicated (it is a set), and push authentication scheme names are lowercased (they are case-insensitive, and push `Create` compares them the same way), over the canonical message, the work-affecting part of its `configuration` (`taskPushNotificationConfig` and `acceptedOutputModes`; the response controls `historyLength` and `returnImmediately` are excluded), and the activated extensions | Computed by Bureau | Yes, server-side |
| Causal request and trace identifiers | `traceparent` header | `traceparent` header | No |
| Deadline | Command-receipts extension `deadline` | `deadline` | No |
| Idempotency scope | The authenticated principal, the published agent, the A2A operation version (`A2A-Version` normalized to its Major.Minor value, since A2A 1.0.1 §3.6 makes patch versions equivalent, so `1.0` and `1.0.1` share a binding; matching COR-424's ledger key), `messageId`, and, for a continuation, its target task, because Weft's mailbox binds identifiers per task | The principal, the operation, and `commandId` | Yes |
| Ownership mode | Detached (the only v1 mode) | Detached | Implied |

A field that belongs to an extension is ignored unless the request activates that extension, so a plain A2A client gets plain A2A behavior.

## Extensions

Bureau publishes these A2A extensions. Each URI names a specification document that `@lostgradient/weft/a2a` ships alongside its implementation; the documents are written with the kit, so the URIs are reserved identifiers until then. The Weft mirror emits only documentation declared one file at a time in `scripts/mirror/source.ts`, so the issue that writes each document also declares it there, and the URIs count as published only when each returns `200` from the public repository.

| Extension | URI | What it adds |
| --- | --- | --- |
| Durable history | `…/a2a/extensions/durable-history-v1.md` | On A2A `SubscribeToTask`: resumption through the standard `Last-Event-ID` request header (the request carries only `tenant` and `id`); the first event is always the current `Task`, whose extension metadata carries its cursor C, the requested cursor, and, when the requested cursor is below the retention floor, the gap; then only durable events after C, each with its cursor as the SSE `id`. Ephemeral frames carry no `id`. A2A never replays events older than the `Task` it just sent; full event replay is `bureau.tasks.events` on the management plane |
| Command receipts | `…/a2a/extensions/command-receipts-v1.md` | The receipt state, `expectedRevision`, and `deadline` on `SendMessage` and `SendStreamingMessage`, the two A2A commands whose request carries a message, and a typed conflict on reuse. `CancelTask` and push-configuration `Delete` have fixed shapes with no carrier and rely on their specified idempotency instead. A2A does not make `Create` idempotent, so Bureau does: a `Create` naming an existing configuration `id` for the same task and caller with the same webhook URL, `token`, and authentication, or omitting `id` with the same three as an existing configuration, returns that configuration rather than registering a second one; a deleted configuration never matches, and a `Create` naming a deleted configuration's `id` is rejected with `-32602`, and a `Create` reusing an existing `id` with any of the three changed is rejected with `-32602` (COR-1470). A new configuration's projector checkpoint is set, in the same write as the configuration, to the cursor C read under the task's mutation barrier, so every update after C reaches it and none before |
| Cleanup | `…/a2a/extensions/cleanup-v1.md` | The `CleanupAcknowledgement` and review detail on task status, so a canceled task can report whether cleanup finished |

`…` is `https://github.com/stevekinney/weft/blob/main/packages/weft/documentation`.

Bureau also advertises one third-party extension, A2UI's A2A extension at the URI the pinned A2UI release (`v0.9.1`) defines, as optional. It carries interactive surfaces to A2A clients that render them; Bureau's own rules below apply to it as well.

The rules for every extension:

- **Activation.** A client activates an extension per request with the `A2A-Extensions` header, or the binding's equivalent. The response echoes the extensions Bureau applied. The one exception is A2UI's extension, which Bureau also treats as activated through either of the mechanisms the pinned A2UI v0.9.1 specification defines: the `X-A2A-Extensions` header, accepted as an A2UI-only alias, or `metadata.a2uiClientCapabilities` on a message. The cross-origin CORS allowlist allows and exposes `X-A2A-Extensions` for that reason.
- **Versioning.** A breaking change publishes a new URI with the next major version. Bureau never falls back to an older version on its own.
- **Optional by declaration.** Every card entry has `required: false`.
- **Fail-closed as a client.** When an operative calls a peer whose card marks an extension `required` and Bureau does not implement it, Bureau refuses the call with `ExtensionSupportRequiredError` rather than sending a request the peer will misread.
- **Typed substate.** Extension data lives in the extension's own namespace inside `metadata`, with its own schema; it never repurposes a core field.

## Receipt state machine

A command's receipt is a projection of the store that admitted it: the COR-424 ledger for run creation, Weft's mailbox for commands to an existing resource, and Weft's outbox for deliveries. The contract's receipt states, and which stores produce them:

| Receipt state | Meaning | Produced by |
| --- | --- | --- |
| `accepted` | Durably admitted; nothing applied yet | Ledger pending entry; mailbox `accepted`, `available` |
| `rejected` | Refused at admission; nothing will be applied | Validation, authorization, mailbox `rejected` (backlog full) |
| `pending` | Claimed and in progress | Mailbox `claimed`; ledger in-flight entry |
| `applied` | The mutation took effect | Ledger complete; mailbox `applied` |
| `observed` | Applied, and the effect is visible in durable history | Durable history append for the resource |
| `superseded` | Replaced by a later command before it applied | Review `superseded`; session input `superseded` |
| `failed` | Accepted but could not apply | Mailbox `dead-lettered` or failure reasons |
| `cancel-requested` | Cancellation recorded; the work has not stopped | Mailbox `cancellation-requested`; run `aborting` |
| `canceled` | Stopped before or during application | Mailbox `cancelled`; run `aborted` |
| `cleanup-pending` | Terminal, with cleanup still running | `CleanupAcknowledgement` not yet settled |
| `cleaned-up` | Terminal, with cleanup `completed` or `not-required` | `CleanupAcknowledgement` |
| `expired` | The command's deadline passed before it applied | Mailbox `deadline-exceeded`; ledger deadline |
| `cleanup-failed` | Terminal, and cleanup definitely failed | `CleanupAcknowledgement` `failed` |
| `cleanup-unresolved` | Terminal, and cleanup could not be confirmed; it may still be running, so an external effect may still occur and a client must not treat the work as safely retryable | `CleanupAcknowledgement` `unresolved` with `timed-out`, `unreachable`, or `persistence-failed` |
| `unknown-outcome` | An external effect may or may not have happened | Outbox `unknown-outcome`; `CleanupAcknowledgement` `unresolved` with `unknown-effect` |

Which states each operation can produce:

| Operation | States |
| --- | --- |
| `SendMessage` or `SendStreamingMessage` creating a task | `accepted`, `rejected`, `pending`, `applied`, `observed`, `expired` |
| `SendMessage` or `SendStreamingMessage` continuing a task | `accepted`, `rejected`, `pending`, `applied`, `observed`, `superseded`, `failed`, `expired` |
| `bureau.tasks.cancel` (A2A `CancelTask` returns the task itself, which carries no receipt) | `cancel-requested`, `canceled`, `cleanup-pending`, `cleaned-up`, `cleanup-failed`, `cleanup-unresolved`, `unknown-outcome`, `rejected` |
| `bureau.contexts.delete` | `applied`, `rejected`, `cleanup-pending`, `cleaned-up`, `cleanup-failed`, `cleanup-unresolved`, `unknown-outcome` |
| `bureau.reviews.resolve` | `applied`, `rejected`, `superseded` |
| Management delivery commands (`bureau.deliveries.retry`, `bureau.deliveries.cancel`; A2A push-configuration methods return their fixed objects and carry no receipt) | `accepted`, `pending`, `applied`, `failed`, `canceled`, `unknown-outcome` |
| Schedule and goal commands | `applied`, `rejected`, `cancel-requested`, `canceled`, `cleanup-pending`, `cleaned-up`, `cleanup-failed`, `cleanup-unresolved` |

The management receipts map onto observed facts. `bureau.tasks.cancel` answers `cancel-requested` while the run has not stopped, and then the state its `CleanupAcknowledgement` ends in: `cleanup-pending` while it is outstanding, `cleaned-up` for `completed` or `not-required`, `cleanup-failed` for `failed`, `cleanup-unresolved` for `unresolved` with `timed-out`, `unreachable`, or `persistence-failed`, and `unknown-outcome` for `unresolved` with `unknown-effect`. `canceled` is the receipt for a durable run that this process holds no live handle for and whose workflow cancellation was requested: it claims the stop and nothing about cleanup, because no acknowledgement exists to report. `rejected` is a cancel of a task that finished without being canceled (reason `already-terminal`): nothing is applied, and it is a receipt, not a `Conflict` fault; a repeated cancel of a task already canceled answers its current cleanup receipt. `bureau.contexts.delete` answers `applied` when no task was live, and `rejected` (reason `shutting-down`) once `shutdown()` has closed admission. Otherwise it answers the aggregate of its live tasks' cleanup states, the least settled winning in this order: `cleanup-pending` (a request still outstanding counts here), `cleanup-unresolved` (a stop with no acknowledgement behind it counts here), `unknown-outcome`, `cleanup-failed`, `cleaned-up`; the response lists each task's own state.

A `bureau.reviews.resolve` whose decision is `reject` and that lands is `applied`: the response's `decision` carries `reject`, and `rejected` stays the receipt of a command refused at admission, which v1 reports as a fault.

## Retry, concurrency, and ordering

- **Exact retry.** The same principal, agent, A2A operation version, `messageId` (and, for a continuation, target task), and payload digest returns the original receipt and task. Exactly one run exists.
- **Conflicting reuse.** The same principal, agent, A2A operation version, and `messageId` (and, for a continuation, target task) with a different payload digest returns, to a client that activated command receipts, a typed conflict carrying the original receipt, and to any other client a standard JSON-RPC `-32602` error stating that the `messageId` was reused with a different payload, without receipt metadata; either way it is recorded as its own failed ledger entry (COR-424's `BureauLedgerConflictError`, reason `payload-mismatch`). The original command is untouched.
- **Ordering.** Messages to one task are applied in admission order through that task's mailbox. Different tasks are independent; there is no ordering across them. Because Weft's mailbox binds identifiers per task, a continuation's idempotency scope also includes its target task: the same `messageId` sent as continuations to two different tasks is two commands, while an exact retry to the same task returns the original receipt.
- **Concurrency.** State transitions are compare-and-swap on the record. Two concurrent commands to one resource produce one winner; the other observes the new revision.
- **Stale target.** A command carrying `expectedRevision` that no longer matches returns the stale-revision fault and changes nothing.
- **Duplicate delivery.** A command delivered twice, for example by a retrying proxy, is an exact retry.
- **Expiry.** A run-creation binding is held for as long as its task is non-terminal, and its retention window starts only when the task settles, so a delayed retry of a long-running task never admits a second run. After the idempotency binding's retention, 24 hours by default, the mailbox deletes the command record and its binding (`packages/weft/src/core/mailbox-maintenance.ts`), so a query for the old receipt returns not-found and the same `messageId` admits a new command. Clients that retry later than that must mint a new identifier. A command whose deadline passes before it applies is `expired`.
- **Disconnect.** Closing a stream or connection changes nothing about the task. The client reattaches with `SubscribeToTask`.
- **Process restart.** With persistent storage, ledger entries, mailbox receipts, outbox deliveries, and durable history survive a restart. `BureauOptions.persistence` is optional and an ephemeral Bureau has no durable history, so `createBureauHandler` derives each extension from the concrete stores Bureau actually composed, never from `BureauOptions.persistence` alone: command receipts only when the persistent COR-424 ledger and the session-input mailbox exist, durable history only when the durable engine and its event history exist, and push only when both the outbox and the durable event history exist, because push notifications are projections of durable history. A deployment missing a store omits the matching extension from every card and makes no guarantee that depends on it. COR-424's fault points define run creation's behavior at each crash boundary: a retry after a crash never starts a second run once a ledger entry exists.
- **No exactly-once external effects.** Bureau guarantees one model run per command identity. It does not guarantee that a tool's or a webhook receiver's side effect happened exactly once; a crash after an external effect and before settlement reports `unknown-outcome`.

## Query and event model

One model underlies every surface. Resource snapshots come from the resource's own store; events come from Bureau's durable event history. The A2A stream, the AG-UI stream, `bureau.tasks.events`, and push notifications are projections of that history, and each may expose a strict subset without changing what an event means. Push delivery is projected from the history by a projector that persists, per push configuration, the last cursor it enqueued, so a crash between a history append and its outbox enqueue is repaired on restart by replaying from that checkpoint (COR-903). A checkpoint that retention has overtaken cannot replay, so the projector takes the task's current `Task` snapshot and its cursor C together under the snapshot fence, enqueues one delivery carrying that snapshot, and advances the checkpoint to C, so no event older than the snapshot is sent after it. If a durable append fails, Bureau first marks the task resync-pending in its persisted A2A record, then repairs the history itself by appending, under the task's mutation barrier so no concurrent mutation can interleave, a `task.resynced` durable event carrying the task's current projection and revision, clearing the mark only once that append commits, so a later successful append cannot hide the missed update. Every projection of history serves it: push delivers it as a current `Task` snapshot, A2A streams as a status update plus one artifact update per artifact, and `bureau.tasks.events` as a resync event, so a disconnected management consumer that resumes from `Last-Event-ID` still receives the repair. Because a crash can interrupt that, Bureau also, on every start and on every durable maintenance pass, appends `task.resynced` for each task that is marked resync-pending or whose record revision is newer than the revision of its last durable event, so no window between a mutation and its projections loses an update and a repaired task is not resent. The projector keeps at most one unsettled delivery per configuration, enqueuing the next only after the previous one is terminal, so a webhook receives a configuration's updates in generation order (A2A 1.0.1 §3.5.2) even though Weft's outbox lets a due delivery pass one in retry backoff.

| Element | Definition |
| --- | --- |
| Durable cursor | An opaque string. Clients compare cursors for equality only; today's decimal encoding is not part of the contract. |
| Retention floor | A deployment-configured history retention, `BureauOptions.eventRetention` (default 7 days, `'forever'` to disable). Each durable maintenance pass calls the fleet feed's `retain()` for events older than the window, so the floor advances over a contiguous prefix and never past an event newer than the cutoff. `BureauOptions.taskRetention` (default 30 days) bounds tasks the same way: maintenance deletes a terminal task older than the window through the run store, so `run.removed` fires, and only once its run-creation binding is gone (one unreadable binding record makes the pass fail closed until repaired). A task counts as old from its closing `run.completed` or `run.aborted` action. Only runs that settled in the process's lifetime are candidates: a terminal run from before a restart is not reattached and never receives `run.removed` from this pass. |
| Gap response | On A2A, a resume below the floor is reported in the initial `Task`'s durable-history metadata (requested cursor and first retained cursor), keeping the `Task` first as `SubscribeToTask` requires. On `bureau.tasks.events`, it yields one gap event carrying both cursors, then the events from the floor. `subscribeEventHistory`'s silent gap skipping is replaced, not projected: its listener receives one `history.gap` event whose payload carries `requestedCursor` and `firstRetainedCursor`, and its cursor is the last one before the floor. A subscription whose undelivered backlog the floor overtakes while it is open receives the same event before any later one (its requested cursor is the cursor of the last event it was sent, a previous gap event included); a subscription drained to the tail is never sent one. `firstRetainedCursor` is the canonical shape on the subscriber-facing event; the page API's `firstRetainedSequence` is pre-existing. The `run.removed` event that records a deletion ages out under `eventRetention` like any other. |
| Snapshot plus tail | On A2A, every subscription, fresh or resumed, receives the current `Task` at cursor C first, then only durable events after C, so the client's state never moves backwards; the `Task` already contains every status and artifact a resumed client missed. On `bureau.tasks.events`, a resume with `Last-Event-ID` above the floor replays every durable event after that cursor in order, with monotonic ids, before live events, and a fresh subscription receives the snapshot first. The initial `Task` and its cursor C are read together: Bureau holds this task's mutation barrier, so no new mutation of the task commits while the pair is read, waits for the task's in-flight durable appends (which the durable-event producer already tracks) to settle, then reads the fleet-wide tail C, builds the `Task` from the task record, and accepts the pair only if the durable history holds no event for this task after the record's last folded cursor and at or before C. Otherwise, because the mutation barrier admits no new change, each such event is one the task record already reflects but whose fold was not persisted (a crash between the append and the cursor update), so Bureau verifies it against the record, advances and persists the folded cursor past it, and accepts the pair; the read never loops on unchanged state. An idle task therefore succeeds on the first read even while other tasks append, so no event between the snapshot and the tail is lost or duplicated. |
| Ephemeral frames | Step, delta, and tool frames from the in-memory run feed reach AG-UI streams live, and never A2A streams. They carry no resumable cursor and are not replayed; reconnecting yields the snapshot and the durable tail. |
| Slow consumers | Durable-history subscriptions are pull-driven and never buffer unboundedly. On management streams, ephemeral frames beyond a stream's buffer are dropped and the stream emits one frames-dropped marker (`frames.dropped`, positioned at the last event the reader received, so its `sequence` and `cursor` repeat that event's and are not unique across kinds: never use them as an SSE id with a skip-if-not-greater rule; the stream then resumes after that cursor, replaying whatever the in-memory log still retains, which is the oldest retained event when the log has evicted past the reader's cursor). On an A2A stream, which must deliver the same events in the same order as every other active stream for the task (A2A 1.0.1 §3.5.2), a subscriber that falls behind its buffer is closed instead, and reconnects with `Last-Event-ID`. An A2A tail whose next cursor has fallen below the retention floor (a `fleet:gap`) is closed the same way rather than silently skipping events, so the reconnect's initial `Task` supplies the current state. An AG-UI stream whose reader falls behind its buffer is closed with `RUN_ERROR` `STREAM_OVERFLOW` rather than thinned, because a dropped text delta would silently corrupt a transcript the client rebuilds from deltas; the client attaches again and the snapshot the new stream opens with restores what it missed. |
| A2A projection of live frames | A2A streams carry only the protocol's `StreamResponse` kinds: the initial `Task`, `TaskStatusUpdateEvent`, and `TaskArtifactUpdateEvent`, and every active stream for a task receives the same sequence (A2A 1.0.1 §3.5.2). Step, delta, and tool frames are therefore never sent on A2A; they reach clients only through AG-UI. The frames-dropped marker is sent on management streams only. Status and artifact changes reach A2A as durable events. The durable-event producer appends a task's events strictly in task-revision order, starting an append only after the previous one for that task commits, so the fleet cursor order matches each task's generation order even when an append is slow. Where a durable history is composed and delivering, the A2A projection suppresses the live copy of every durable event kind (`RUN_DURABLE_EVENT_TYPES`, such as run completion, error, abort, and tripwire), so each transition arrives exactly once with its cursor. The live copy is suppressed only once its append commits; if the append fails, the retained live copy is projected without a cursor and the stream closes after it, so the reconnect's initial `Task` supplies the state. Where none is composed, the live fallback subscribes before it reads its initial `Task`, under the same mutation barrier the durable fence uses, so no status or artifact change falls between them; every live status and artifact change, interrupted states such as `INPUT_REQUIRED` and `AUTH_REQUIRED` included, is projected from the live source without a cursor, so both compositions produce the same sequence and differ only in whether events carry cursors. |
| Audit | A separate, allowlisted, append-only compliance record (`packages/bureau/src/audit-trail.ts`). Events are not audit records, and the audit trail is not an event stream. |
| Telemetry | Traces and metrics follow `traceparent` and are not part of the contract. |

## Authorization

The tenant is the deployment, and authorization inside it is owner of record plus operator scopes.

- **Owner of record.** Every resource records its owning principal when it is created, and the record survives restart. The owning principal is a credential-specific identity: a JWT `sub`, an API key's subject from `resolveApiKeyPrincipal`, or an mTLS client's stable service identity, returned by the host-supplied `MTLSConfig.resolvePrincipal` from the verified certificate that the host-supplied `MTLSConfig.getPeerCertificate(request)` provides (both added to Weft by COR-1479, since `AuthContext` carries no certificate today and a fetch handler cannot see the TLS session), so that a renewed or rotated certificate keeps the same owner and no spoofable request data names the owner; the certificate fingerprint is recorded only for audit and revocation. Weft's shared fallbacks (`api-key-caller` for every static key, `mtls-caller` for unforwarded mTLS) and JWTs without `sub` are rejected for owner-scoped operations, because different callers would compare as one owner; several keys may share an owner only through an explicit alias in `resolveApiKeyPrincipal`. Work started by the scheduler, recovery, or expiry carries a named service principal such as `system:scheduler`, never an absent owner. The persisted owner string is namespaced by authentication method so identities from different credential types never collide: `jwt:<issuer>:<sub>`, `api-key:<subject>`, and `mtls:<service identity>`, where every component is percent-encoded (`encodeURIComponent`, which encodes `:`) so no two distinct tuples produce the same string, and the JWT issuer is the validated issuer from OIDC discovery (COR-1479) or, without discovery, the configured `issuer` the verifier checks against `iss`; `createBureauHandler` rejects at construction a JWT configuration with neither, so the issuer is never an unvalidated claim or empty; the `system:` namespace is reserved for Bureau's own service principals and rejected from any credential; sharing across namespaces happens only through an explicit alias. Weft today forbids `resolveApiKeyPrincipal` alongside `jwt` (`validateAuthConfig`), and static keys share one subject, so a deployment that offers both JWT and API keys cannot yet give API-key callers an owner; until COR-1479 lets the resolver handle `X-API-Key` while Bearer tokens fall through to JWT verification, `createBureauHandler` rejects that combination at construction and the card never advertises a scheme whose callers cannot own resources. Static `AuthConfig.apiKeys` are rejected at construction whatever else is configured, because every static key authenticates as the shared `api-key-caller`; API-key authentication requires `resolveApiKeyPrincipal`, and A2A 1.0.1 §12.6 requires every advertised scheme to work.
- **Owners see their own.** A principal can list, read, command, observe, and cancel resources it owns. On the A2A surface every lookup and listing is also scoped to the published agent of the mount the request arrived on, so one agent's endpoint never reveals or acts on another agent's tasks.
- **Operator scopes.** Bureau registers its own scopes (`bureau.tasks:read`, `bureau.tasks:write`, `bureau.reviews:read`, `bureau.reviews:resolve`, `bureau.deliveries:read`, `bureau.deliveries:write`, `bureau.audit:read`, `bureau.schedules:read`, `bureau.schedules:write`, `bureau.goals:read`, `bureau.goals:write`, `bureau.contexts:read`, `bureau.contexts:write`, and `bureau.events:observe-all`). A write scope does not imply its read scope; operators hold both beside Weft's closed scope list. They grant cross-owner access only to management operations, never to the A2A surface, where A2A's `ListTasks` stays caller-scoped.
- **Not-found-shaped denial.** A resource the caller may not see answers exactly as one that does not exist, on every surface.
- **Identifiers are not credentials.** Knowing a task, context, review, or asset identifier grants nothing.
- **Wildcard observation** of every present and future task is the separate `bureau.events:observe-all` scope; a read scope does not imply it.
- **The only public paths** are each published agent's Agent Card and, when the card is signed, the JWKS its signature names. Every other path authenticates (COR-718's "no unauthenticated paths" criterion is amended to say so).
- **Public discovery under mTLS.** When a deployment authenticates with mutual TLS, a client without a certificate is rejected during the TLS handshake, before any public route runs. Such a deployment serves the Agent Card and JWKS from a listener that does not request client certificates, at the separate origin it configures as `discoveryUrl`, and every other route stays on the mTLS listener at `publicUrl`; `createBureauHandler` exposes its discovery routes as a separately mountable handler for that purpose. Weft's `createAuthenticator` today treats an otherwise uncredentialed request as authenticated mTLS (`packages/weft/src/server/authentication/index.ts`), which is an authentication bypass whenever client certificates are optional. A separate Weft fix makes it report `mtls` only with a verified peer certificate, and no deployment may make client certificates optional until that fix lands.
- **A2A's `tenant` field** carries the deployment identifier, the tenant; the interface URL, which is the mount, selects the published agent. A request whose `tenant` differs from the mounted interface's `AgentInterface.tenant` is rejected with `-32602` before the SDK handler runs, so no tenant-scoped store is addressed by a caller-chosen partition. It is not a security boundary.

The predicate per action:

| Action | Owner | Operator scope |
| --- | --- | --- |
| List, get, query | Own resources | The kind's read scope (`bureau.tasks:read`, `bureau.reviews:read`, `bureau.contexts:read`, `bureau.deliveries:read`, `bureau.schedules:read`, `bureau.goals:read`) |
| Command | Own resources | The kind's write scope |
| Events | Own resources | `bureau.tasks:read`; `bureau.events:observe-all` for wildcard |
| Result | Own tasks | `bureau.tasks:read` |
| Child traversal | Children of own tasks | `bureau.tasks:read` |
| Transcript and memory | Bureau's internal session transcript and memory are not served through any v1 operation; `bureau.contexts.list` and `get` serve a session's `title` and `lastMessagePreview`, two bounded excerpts the summary index records, and nothing else of its messages. The task's own A2A history (`GetTask`, `ListTasks`, and send responses with `historyLength`) is served to the task's owner | Not granted by any v1 scope; a later data-tier model must define its vocabulary, its fail-closed default, and how each authentication method maps to it before any operation serves internal transcript or memory content |
| Audit | Own records | `bureau.audit:read` |
| Abort and cleanup | Own tasks | `bureau.tasks:write` |
| Delete | Own contexts | `bureau.contexts:write` |
| Review resolution | The requester, for `INPUT_REQUIRED` and `AUTH_REQUIRED` | `bureau.reviews:resolve` |

## Error contract

Errors are versioned with the surface that returns them, machine-readable, and, when produced after the request is parsed, carry the request's correlation identifier and, for commands, the command identifier; authentication (401) and rate-limit (429) rejections happen before parsing and carry no correlation identifier. Weft's `FaultCode` gains the categories marked new.

| Category | A2A surface | Weft fault | HTTP (management plane) |
| --- | --- | --- | --- |
| Validation | JSON-RPC `-32602` | `InvalidParams` | 400 |
| Unsupported content | `ContentTypeNotSupportedError` (`-32005`) when a message part's media type is outside the agent's `defaultInputModes` or skill input modes | `Unprocessable` | 415 |
| Authentication | HTTP 401 | `Unauthorized` | 401 |
| Authorization | Not found (denial is not-found-shaped) | `NotFound` | 404 |
| Not found | `TaskNotFoundError` (`-32001`) | `NotFound` | 404 |
| Conflict | Command-receipts extension conflict: an A2A error whose `ErrorInfo` reason is `CONFLICT` | `Conflict` | 409 |
| Stale revision | Command-receipts extension stale revision: an A2A error whose `ErrorInfo` reason is `STALE_REVISION` | `StaleRevision` (new) | 409 |
| Unsupported capability | `UnsupportedOperationError` (`-32004`), `ExtensionSupportRequiredError` (`-32008`), `VersionNotSupportedError` (`-32009`) | `NotImplemented`, `UnsupportedCapability` (new) | 400, 501 |
| Rate limit | HTTP 429 | `RateLimited` (new) | 429 |
| Deadline | A2A has no deadline code. A creation command that expires before applying projects the new task as `TASK_STATE_FAILED` with a deadline reason; an expired continuation leaves the existing task in its current, still-interrupted state and reports the command's `expired` receipt; an expired request is JSON-RPC `-32603` with `Timeout` data | `Timeout` | 408 |
| Cancellation | `TaskNotCancelableError` (`-32002`) for a task that is `COMPLETED`, `FAILED`, or `REJECTED`; `CANCELED` (A2A 1.0.1 §3.1.5 names an already-canceled task as not cancelable, so a repeated cancel has the same effect and the same error), and `TaskNotFoundError` once the task is purged (§3.3.1) | `Conflict` (Weft keeps no cancellation category), for the A2A surface only: `bureau.tasks.cancel` reports a task that finished without being canceled as the `rejected` receipt, and a repeated cancel as its current cleanup receipt, so it raises no fault for either | 409 |
| Unavailable dependency | JSON-RPC `-32603` with retry detail | `Unavailable` (new) | 503 |
| Internal failure | JSON-RPC `-32603` | `EngineFailure` | 500 |

The HTTP column applies to the management plane. On the A2A JSON-RPC mounts, every application-level error is a JSON-RPC error envelope with HTTP 200, as the pinned SDK returns it; only authentication (401) and rate limiting (429), which are rejected before the JSON-RPC handler runs, use HTTP statuses there. `ErrorInfo` reasons are UPPER_SNAKE_CASE identifiers (`CONFLICT`, `STALE_REVISION`, `TIMEOUT`, `RATE_LIMITED`, `UNAVAILABLE`), as `google.rpc.ErrorInfo` requires, not Weft's fault names.

A2A 1.0.1 §9.5 reserves the whole range `-32001` to `-32099` for A2A errors, and Weft's own codes sit inside it (`-32010` to `-32099`). The two surfaces therefore never share an endpoint: the A2A mount answers only with A2A error codes, and its `error.data` is the array §9.5 requires, each entry carrying `@type`: for a core A2A error, the `google.rpc.ErrorInfo` §9.5 defines, with domain `a2a-protocol.org` and its standardized reason (such as `TASK_NOT_FOUND`); for a fault with no A2A code, an `ErrorInfo` with domain `bureau` and the UPPER_SNAKE_CASE reason listed above, never the Weft fault name. Weft fault objects, with their `weftCode` and `httpStatus`, appear only on the management plane's endpoint.

## Untrusted input and catalog identity

Per-run input from outside Bureau carries only the message, its parts, and the envelope fields above. An inbound message whose `role` is not `ROLE_USER` is rejected with `-32602`, so a caller cannot forge an agent-authored history entry. AB-15's hardening removes everything else from untrusted input:

- `systemPrompt`, `maximumSteps`, and `maximumTokens`, which only the deprecated `createRun` still accepts (`packages/bureau/src/types.ts:1982-2012`). `createRun` is not served through `createBureauHandler`.
- `principal` in any payload. The principal is the authenticated caller.
- Model, provider, route, and effort overrides, except through steering policy profiles the agent's definition allows.
- Tool lists, tool approvals, and grants.

AB-22's immutable catalog is the only source of external identity and capability metadata. A card's identity is the catalog's agent name and `definitionRevision`; its descriptive fields come from the agent definition (COR-1301); its visibility comes from `publish`. Nothing in a request can change any of them.

## Agent coordination

Bureau manages many operatives, and they coordinate in two ways.

- **Parent and child.** A parent dispatches, waits on, signals, and cancels its children through the typed in-process child API, with `cascade` or `detach` cancellation, `closed()` cleanup, and delegation grants. This is unchanged; children are internal resources that appear on the parent task's status detail.
- **Peers.** An operative communicates with another agent by Agent Card over A2A, whether the peer runs in this Bureau or another. The calling operative is an A2A client (COR-905), and operatives are that issue's named consumer. A call to a peer in the same Bureau goes through the same A2A path, so a peer can move between deployments without the caller changing.

Peers are a trust boundary. A message or artifact from a peer is untrusted input whose provenance is the peer's Agent Card identity, and it enters memory only as untrusted evidence with that provenance. Nothing from memory, transcripts, or other tasks reaches a peer unless the operative puts it in the outgoing message.

This supersedes COR-807, which rejected direct peer messaging for lack of a consumer. The [runtime contracts](../../../documentation/runtime-contracts.md#parent-child-and-peer-communication) peer paragraph stays accurate until COR-905 ships and is updated in that change.

## Changes to Weft

Weft is a public package. To make it a good base for anyone implementing A2A, not just Bureau, these changes land in Weft:

- **`@lostgradient/weft/a2a`.** A new subpath, kept free of Bun-only and UI code, built on `@a2a-js/sdk` and containing:
  - a fetch handler around the SDK's `JsonRpcTransportHandler`, with streaming over Server-Sent Events, carrying only A2A `StreamResponse` kinds, where snapshots and durable-history events carry their durable cursor as the SSE `id` (step, delta, and tool frames never reach this handler);
  - `A2A-Version` and `A2A-Extensions` negotiation;
  - the public Agent Card route, signed with the SDK's `generateAgentCardSignature`, and its public JWKS;
  - security schemes derived from Weft's `AuthConfig`;
  - durable `TaskStore` and `PushNotificationStore` implementations over Weft storage;
  - push notification delivery through Weft's outbox, sent as `Content-Type: application/a2a+json` (A2A 1.0.1 §4.3.3) and carrying the push configuration's own `authentication` (`Authorization: <scheme> <credentials>`, with credentials stored only in the push-configuration record), its `token`, when set, as the `X-A2A-Notification-Token` header (the header the pinned `@a2a-js/sdk` sender uses; A2A names none), and, when the operator provisions signing secrets, Standard Webhooks signatures in addition (HMAC-SHA256 over per-deployment secrets, COR-1471's `signingSecrets`, shared with receivers out of band and rotated by a two-secret overlap; A2A's `token` is unrelated), behind an SSRF egress policy.
- **A workflow reference backend.** Weft workflows served as A2A agents: a workflow run is a task, `waitForSignal` is `TASK_STATE_INPUT_REQUIRED`, cancellation is `CancelTask`, workflow output is artifacts, and history is the fleet feed. It is also the conformance fixture for the A2A test kit, proving the kit independent of Bureau.
- **Durable stores** over Weft storage for backends that have no task records of their own. The workflow backend uses the task store; Bureau uses only the push-configuration store, because a Bureau run already is the task.
- **Security scheme derivation.** Card `securitySchemes` generated from Weft's `AuthConfig`.
- **Foreign subscriptions over Server-Sent Events.** The generic subscription route COR-1299 adds, which no transport reaches today.
- **Fault codes.** `StaleRevision`, `RateLimited`, `Unavailable`, and `UnsupportedCapability` added to `FaultCode`.

An Agent Card's `version` is the agent's version, `definitionRevision` for Bureau and the definition's `version` for workflows, so Weft adds no server version. Rate limiting of a fetch handler, which cannot see the client address, stays with COR-718's limits criterion.

- **Package-registered scopes.** Weft's scope list is closed today (`packages/weft/src/server/authorization-scope.ts`); a package must be able to register its own namespaced scopes, such as Bureau's operator scopes.

The Conversationalist-to-A2A part mapping (COR-1303) stays in Conversationalist with its own hand-written types for the pinned proto, as that issue specifies, so Conversationalist gains no dependency on Weft. A Bureau test, where both packages are available, proves that the mapping's output is accepted by `@a2a-js/sdk`'s types and request handler, so the two definitions cannot drift.

## Interborough

The first consumer is Interborough, Corvidae's main application. It is served from the same origin as the Bureau host it runs, so its calls need no CORS, and Weft's own server runs on a private loopback port behind it, so the console and the engine API answer on that one origin. A deployment that serves a UI from any other origin opts in through `createBureauHandler`'s CORS option, which must allow that origin, `GET`, `POST`, and `OPTIONS`, the request headers `Authorization`, `X-API-Key` (when the API-key scheme is configured), `Content-Type`, `A2A-Version`, `A2A-Extensions`, `X-A2A-Extensions`, `Last-Event-ID`, `If-None-Match`, and `traceparent`, and expose `A2A-Extensions`, `X-A2A-Extensions`, and `ETag`, so a cross-origin client can revalidate the Agent Card. The Interborough uses AG-UI for its live chat surface, the A2A surface for agent discovery and task lifecycle, and the management plane for operator screens. It uses the Cinder components and carries its own client provider, query helpers, router, and live-source plumbing, and it supplies its own code highlighter. It is scoped in its own Linear project; External Control Plane's Definition of Done names it as the consumer that completes discover, command, reconnect, result, abort, and cleanup without private APIs.

## Scenarios

| Scenario | Result |
| --- | --- |
| Exact retry | The original receipt and task; one run exists |
| Conflicting retry | To a client that activated command receipts, a typed conflict carrying the original receipt; to any other client, a standard `-32602` error without receipt metadata; either way the original command is untouched |
| Stale session target | The stale-revision fault; nothing changes |
| Process crash after acceptance | The retry observes the pending ledger entry and returns its outcome; no second run starts |
| Reconnect below the history floor | On A2A, the current `Task` first, with the gap in its durable-history metadata, then only events after its cursor; on `bureau.tasks.events`, one gap event, then the events from the floor |
| Slow subscriber | The durable tail is pulled at the subscriber's pace. On management streams, dropped ephemeral frames produce one frames-dropped marker; an AG-UI subscriber that falls behind is closed with `STREAM_OVERFLOW` and attaches again, and an A2A subscriber that falls behind is closed and resumes with `Last-Event-ID` |
| Resource-ownership denial | Not found, identical to a resource that does not exist |
| Attached disconnect | Not applicable in v1: every task is detached |
| Detached disconnect | The task continues; `SubscribeToTask` resumes with a snapshot |
| Cancellation race | One compare-and-swap winner. A cancel that loses to completion returns `TaskNotCancelableError` with the terminal task; a completion that loses to cancel ends `TASK_STATE_CANCELED` |
| Unknown webhook outcome | The delivery settles `unknown-outcome` and is parked for operator inspection, never silently retried as success |

## Bureau method map

Every current `Bureau` member (`packages/bureau/src/types.ts:1102-1836`) maps to the taxonomy or is internal:

| Bureau member | External mapping |
| --- | --- |
| `run` | `SendMessage` or `SendStreamingMessage` creating a task |
| `createRun` | Internal (deprecated; accepts per-request overrides AB-15 removes) |
| `getRun`, `getRunReport`, `getDurableRun`, `listRuns`, `listDurableRuns` | `GetTask`, `ListTasks`; `bureau.tasks.get`, `bureau.tasks.list` |
| `abortRun`, `cancelDurableRun` | `CancelTask`; `bureau.tasks.cancel` |
| `deleteRun`, `listAbortingRuns`, `subscribeRunSnapshot` | Internal; cleanup status reaches clients through the cleanup extension |
| `listSessions`, `getSession`, `deleteSession` | `contextId`; `bureau.contexts.delete` |
| `signalSession`, `submitSessionInput`, `submitSteeringCommand` | `SendMessage` or `SendStreamingMessage` continuing a task |
| `updateSession`, `querySession` | Absent (always `UNSUPPORTED_CAPABILITY`) |
| `children.*` | Internal; parent task status detail |
| `goals.*` | `bureau.goals.*` |
| `submitSchedulerTask`, `locateSchedulerTask`, `awaitSchedulerTask` | Internal |
| `createSchedule`, `getSchedule`, `listSchedules`, `pauseSchedule`, `resumeSchedule`, `cancelSchedule` | `bureau.schedules.*` |
| `listPendingReviews`, `getReview`, `resolveReview` | `bureau.reviews.*`; `INPUT_REQUIRED` on the task |
| `sweepExpiredReviews` | Internal maintenance |
| `issueGrant`, `revokeGrant`, `listGrants` | Internal |
| `webhookNotifier` | `bureau.deliveries.*`; push notification configs |
| `auditTrail` | `bureau.audit.query` |
| `eventHistory`, `subscribeEventHistory` | `bureau.tasks.events`; the durable-history extension |
| `eventFeed`, `runEventFeeds`, `subscribeLiveFrames`, `events`, `on`, `once`, `subscribe`, `toObservable`, `addEventListener`, `removeEventListener` | Internal; the live sources behind the AG-UI streams and, without durable history, the A2A status and artifact projection |
| `agents` | Agent Cards; `bureau.agents.list` |
| `id`, `getConfiguration`, `getTools`, `waitForRecovery` | `bureau.deployment.get` (identity and recovery status only) |
| `modelCatalog`, `planSelection` | Internal |
| `onlineEvalSampler` | Internal; breaches reach deliveries |
| `setRequestAuthorityValidator`, `getRequestAuthorityValidator` | Internal; the authorization predicate is configured on the handler |
| `ready`, `store`, `memory`, `scheduler`, `sessionStore`, `kv`, `signal`, `completed`, `complete`, `dispose`, `shutdown`, `runDurableMaintenance` | Internal host lifecycle |

COR-1300's operations (`bureau.run`, `getRun`, `abortRun`, `listPendingReviews`, `resolveReview`, and the event feeds) map onto the A2A surface and the management plane as above.

## Consequences

- **COR-424** keys run creation on the caller, the published agent, the A2A operation version (`A2A-Version`), and the A2A `messageId`; its receipt type becomes the ledger's projection of the receipt states above.
- **COR-718** keeps public only each Agent Card and, when the card is signed, the JWKS its signature names; registers Bureau's operator scopes; and derives the card's security declaration from enforced configuration. Its two-tenant language becomes two principals plus a two-deployment isolation check.
- **COR-841** implements A2A push notification configs on the delivery outbox, alongside the four existing triggers.
- **COR-903** implements the A2A surface as the contract, through `@lostgradient/weft/a2a`.
- **COR-905** has a named consumer: operatives calling peers.
- **COR-1298** treats the A2A adapter as the primary mount and gets its third question answered: `bureau.events` and `operative.runs.events` turn on `transports.http` with live-only semantics.
- **COR-1447** exported the shared UI layers from `@lostgradient/weft/ui`; COR-1488 moved them into `applications/interborough` when Weft's UI surface was removed.
- **COR-794** conforms to the asset section; COR-901 is no longer blocked by it. COR-788 adds the authenticated asset route.
- **COR-962** defines the interactive surface named in the taxonomy. A2UI travels to the Interborough over AG-UI and to external clients and peers over A2UI's A2A extension, which the A2A surface advertises as optional. An action from any renderer, Bureau's or a foreign host's, arrives as a command and is reauthorized like any other; the renderer is never trusted. Bureau agents emit A2UI's standard v0.9.1 basic catalog, which official renderers understand, and offer Cinder's catalog (COR-1310) only to clients that list it in `supportedCatalogIds`. The Interborough renders the basic catalog with Cinder through a renderer in `@lostgradient/chat`; Cinder gains `text`, `video-player`, and `audio-player` components and an `image` fit and size for it. Structured input requests travel as A2UI forms in the `INPUT_REQUIRED` status message, with a text fallback. The A2UI pin moves from `v0.9` to the current `v0.9.1`.
- **The Weft A2A kit and its workflow reference backend** are tracked as new issues in the A2A Interoperability project, upstream of COR-903.
- **The External Control Plane and A2A Interoperability projects** drop their non-goals that kept A2A a projection, and this project's two-tenant criterion becomes two principals plus two deployments.
- **Existing issues the A2A surface depends on.** COR-1302 is a hard dependency: Bureau must mint a stable `taskId` at admission, and today `bureau.run`'s handle reports a placeholder identifier until durable dispatch resolves. `SendMessage` returns that task early only when `configuration.returnImmediately` is true; otherwise it waits, as A2A 1.0.1 §3.2.2 requires, until the task is terminal or interrupted. COR-1301 (descriptions and skills), COR-1303 (message-to-part mapping, in Conversationalist), COR-1304 (caller-scoped task listing), and COR-855 (the AG-UI projection) supply the rest.
- **New work to scope.** No existing issue owns these, so each needs scoping before the surface that relies on it ships:
  - the Weft A2A kit, its workflow reference backend (both in A2A Interoperability), and the Weft changes listed above, including package-registered scopes and the new fault codes;
  - delivering `SendMessage` with a `taskId` to a live task, which needs session-input admission (served by `submitSessionInput` through the session mailbox, delivered to the live run at its next step boundary by COR-1476, and outside COR-424's scope);
  - durable-history maintenance: advancing the retention floor, replacing the silent gap skip with the explicit gap event, the frames-dropped marker (management streams only: an AG-UI stream closes on overflow instead), and deleting terminal tasks after `taskRetention`;
  - the management operations COR-1300 and COR-841 do not cover: `bureau.deployment.get`, `bureau.agents.list`, `bureau.tasks.*`, `bureau.contexts.delete`, `bureau.audit.query`, `bureau.schedules.*`, and `bureau.goals.*`;
  - the Interborough project.
