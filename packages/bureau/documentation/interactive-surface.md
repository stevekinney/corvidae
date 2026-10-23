# Interactive surfaces

An interactive surface is something a task shows a person and lets them act on: a form that asks for input, an A2UI component tree, or an MCP App. This document is Bureau's contract for surfaces, `bureau.interactive-surface.v1`. It defines the resource, the commands that change it and their receipts, how the lifecycle is kept, and how A2UI, MCP Apps, and Bureau's own forms map onto it. `@lostgradient/bureau` exports every type named here, and `bureau.surfaces` implements the lifecycle.

The contract is a wire protocol, so it is a one-way door. The [Design](#design) section says how it grows without breaking a consumer, and why each choice below was made.

A surface is a resource in the [external control plane's taxonomy](./external-control-plane.md#resource-taxonomy). Its owner is its task's owner, its updates live in the task's durable history, and it changes only by compare-and-swap on its revision.

## The resource

A snapshot reads one surface as an `InteractiveSurface`:

| Field | Meaning |
| --- | --- |
| `contractVersion` | `bureau.interactive-surface.v1`. Every surface, command, and receipt carries it. |
| `surfaceId` | The surface's identifier, unique within its task. The caller chooses it, so an A2UI `surfaceId` can be used unchanged. |
| `taskId` | The parent task (an agent run, the A2A `taskId`). The surface's actions may continue only this task. |
| `owner` | The task's owner of record (`bureau.tasks.record(taskId).owner`), copied at creation. |
| `audience` | Other principals who may read the surface and act on it. They may not change it. |
| `kind` and `representation` | What the surface shows: `input-form`, `a2ui`, or `mcp-app`, with that kind's own fields (see [Representations](#representations)). `representation` is `null` once the surface is torn down. |
| `data` | The surface's data model: an A2UI data model, a form's initial value, the result an app presents. `null` for none. |
| `summary` | Required text that says what the surface asks or shows. A host that cannot render the kind shows it instead. |
| `actions` | The action catalog (see [Actions](#actions)). |
| `classification` | `standard` or `sensitive` (see [Content classification and redaction](#content-classification-and-redaction)). |
| `revision` | Rises by one with every committed change. A change names the revision it was made against as `baseRevision`. |
| `componentRevision` | The revision at which the representation last changed: the A2UI component tree, the form's schema, or the app resource. |
| `dataRevision` | The revision at which `data` last changed. |
| `state` | `open` or `closed`. |
| `liveness` | `live` while open; `frozen` once its task was cancelled or ended, with its last content still readable; `torn-down` once it was closed explicitly, with its content gone. |
| `closeResult` | How it closed: `reason` (`completed`, `dismissed`, `cancelled`, or `task-ended`) and `closedAt`. `null` while open. |
| `createdAt`, `updatedAt` | ISO 8601. |
| `eventCursor` | The cursor, in the task's durable history, of the event that committed this revision. See [Event durability](#event-durability-and-replay-gaps). |

The authorization context of a request is an `InteractiveSurfaceAuthorization`: the authenticated `principal`, the `taskId` the caller acts within when the caller is a run (a model's tool call), and the MCP App `instanceId` a request comes from. A caller that states none of them is trusted: it is Bureau's own code, or a gateway that has already authorized the request.

The cleanup acknowledgement a task's surfaces report reuses Operative's `CleanupAcknowledgement`: `not-required`, `completed`, `failed`, or `unresolved` with a reason.

## Representations

The representation union is closed: `input-form`, `a2ui`, and `mcp-app`, discriminated by `kind`. It grows only with a new contract version. Each kind keeps its own validation and security metadata beside the shared lifecycle fields.

- **`input-form`** is the native kind, which every host must render. Its `schema` is a JSON Schema 2020-12 schema of an object, and its root declares `type: "object"` itself (v1 does not accept a root that reaches an object only through `allOf` or `$ref`, so a renderer can lay out a form from the root's `properties`); the schema must compile, may not declare `$id`, may not be asynchronous (admission validates synchronously), may not use `pattern` or `patternProperties` (an untrusted regular expression can stall Bureau when a value is admitted), and has no `format` assertion (the 2020-12 default). `submitLabel` optionally names the submit control. `@lostgradient/chat` renders it with Cinder's `SchemaForm`.
- **`a2ui`** is an A2UI surface, experimental, pinned to A2UI `v0.9.1` by `specificationVersion`. It carries the `catalogId` its components come from, the `components` list as A2UI's `updateComponents` carries it (the whole list as the adapter has folded A2UI's incremental `updateComponents` messages into it, which may be empty after `createSurface` and need not hold `root` yet, since A2UI lets components arrive before it; ids are unique), an optional `theme`, and A2UI's optional `sendDataModel` flag, which asks the client to send its whole data model back with each action. Bureau checks this shape; it does not validate the components against their catalog (see [Design](#design)).
- **`mcp-app`** is an MCP App: its `ui://` `resourceUri`, the `text/html;profile=mcp-app` `mimeType`, the `contentDigest` of the resource's bytes (`sha256:` and 64 lowercase hex digits), the `instanceId` of the app instance this revision shows, its `csp` (`connectDomains`, `resourceDomains`, and optionally `frameDomains` and `baseUriDomains`, each a list of origins: a scheme of `https`, `http`, `wss`, or `ws`, a host, and an optional port, with no path, query, fragment, or credentials), its `permissions` (`camera`, `microphone`, `geolocation`, `clipboardWrite`; an absent one is denied), and optionally the `toolName` whose result it presents. Bureau applies no narrower guard than this: the host's sandbox contains the app.

An update may replace the representation, but not change its kind.

## Actions

An action continues the surface's own task, and nothing else. Its `intent` is one of four, and its continuation must name the surface's own task: a review whose identifier names the task's run (`approval:<taskId>:…` or `human-wait:<taskId>:…`), or a signal to the task's own session. A create or update naming any other is `invalid`, because a surface's author may be the model, and the receipt's continuation is what the caller dispatches. A run id and a wait's signal name can both hold colons, so a review id's text cannot say which run it belongs to. Bureau decides from the reviews it holds: the review must be one the task holds open (one this process lists, or a wait derived from the run's durable state) when the surface is created or its actions change.

| Intent | Continuation | Continued by |
| --- | --- | --- |
| `approve`, `deny` | `{ type: 'review', reviewId, round? }` | `bureau.resolveReview` |
| `answer`, `submit` | `{ type: 'signal', sessionId, signalName }` | `bureau.signalSession` |
| `answer`, `submit` | `{ type: 'review', reviewId }` for a held `human-wait:` review | `bureau.resolveReview` (`approve`, with the value as `payload`) |

A tool approval that is re-gated keeps its id and advances its round, so a decision may carry the `round` its surface shows. The adapter that continues an admitted decision refuses it when that round is no longer the review's current one. A run with no session, such as a `bureau.run()` catalog run, is answered through its held `human-wait` review rather than a session signal.

Each action in the catalog has a unique `name`, its `intent`, its `continuation`, an optional `label`, and an optional `valueSchema`. An action's value must satisfy its `valueSchema`, which in v1 is a JSON Schema object (the boolean schemas `true` and `false` are not accepted). Without one, an `answer` or `submit` action on an `input-form` surface takes the form's own schema, and any other action takes no value (it must send none, or `null`). Management-plane commands are never reachable from a surface: there is no intent for them.

A renderer is never trusted. An action arrives as a command and is admitted only when the surface is open, the caller may act on it, the `revision` the renderer showed is the surface's current revision, the action is in the catalog, the value satisfies its schema, and, for an `mcp-app`, the request comes from the instance the surface shows: a caller that states a principal must also state the `instanceId`, and it must be the one the surface shows. Anything else is denied and commits nothing. An action request may also carry A2UI's provenance, its `sourceComponentId` and its `timestamp` (an ISO 8601 date-time naming a real date and time); both are recorded with the admitted action.

## Commands and receipts

Every command carries `contractVersion`, a `type`, the `taskId`, and a `commandId`, the caller's idempotency key. An exact retry, the same `commandId` with the same content, returns an acceptance with `replayed: true` and commits nothing; its `committedRevision` is the revision the original command committed, and its `surface` is the surface as it stands now, which later commands may have changed; the same `commandId` with other content is rejected as a `conflict`. A surface remembers its 64 most recent commands for this. Owner abort is the exception: it acts on every surface of a task, keeps no replay record, and is idempotent by its effect instead. A retry freezes whatever is still open, and its `frozen` counts only that, so it is `0` once an earlier abort froze everything; its `cleanup` is the evidence to rely on.

| Command (`type`) | Receipt | Runtime in v1 |
| --- | --- | --- |
| Create (`surface.create`) | `CreateInteractiveSurfaceReceipt` | Yes |
| Compare-and-swap update (`surface.update`) | `UpdateInteractiveSurfaceReceipt` | Yes |
| Snapshot (`surface.snapshot`, a query) | `InteractiveSurfaceSnapshotReceipt` | Yes |
| Action request (`surface.action`) | `InteractiveSurfaceActionReceipt` | Yes: admission |
| Action result (`surface.action-result`) | `InteractiveSurfaceActionResultReceipt` | Types only |
| Context update (`surface.context-update`) | `InteractiveSurfaceContextUpdateReceipt` | Types only |
| Subscribe (`surface.subscribe`) | `InteractiveSurfaceSubscribeReceipt` | Types only |
| Close (`surface.close`) | `CloseInteractiveSurfaceReceipt` | Yes |
| Owner abort (`surface.owner-abort`) | `AbortInteractiveSurfacesReceipt` | Yes |
| Cleanup (`surface.cleanup`, a query) | `InteractiveSurfaceCleanupReceipt` | Yes |

A receipt is either an acceptance or an `InteractiveSurfaceRejection`, whose `reason` is one of `invalid`, `not-found`, `conflict`, `stale-revision` (with the surface's `currentRevision`), `stale-instance`, `closed`, `payload-too-large`, `contended` (the surface kept changing while the command was checked, so it may be retried as is), or `unsupported-capability`. A rejection commits nothing. `bureau.surfaces` never throws for a refused command; it throws only when storage fails.

Subscribe, context update, and action result are defined so their consumers can build against them, but Bureau does not serve them yet: a subscriber replays the task's durable history (see below), a client's data model is not written back to the surface, and what became of an admitted action is read from the task itself.

```ts
import {
  createBureau,
  INTERACTIVE_SURFACE_CONTRACT_VERSION,
  type InteractiveSurfaceActionReceipt,
} from '@lostgradient/bureau';
import { createAgent, type GenerateFunction } from '@lostgradient/operative';

declare const generate: GenerateFunction;
declare const taskId: string;

const bureau = await createBureau({
  agents: { assistant: createAgent({ generate }) },
  storage: { type: 'sqlite', path: './bureau.db' },
  durableExecution: true,
});
const surfaces = bureau.surfaces;
if (surfaces === undefined)
  throw new Error('surfaces need durable execution over persistent storage');

const created = await surfaces.create({
  type: 'surface.create',
  contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
  commandId: 'ask-for-a-window',
  taskId,
  surfaceId: 'deployment-window',
  summary: 'When should the deployment run?',
  representation: {
    kind: 'input-form',
    schema: {
      type: 'object',
      properties: { window: { type: 'string', enum: ['tonight', 'tomorrow'] } },
      required: ['window'],
    },
  },
  actions: [
    {
      name: 'submit',
      intent: 'submit',
      continuation: { type: 'signal', sessionId: 'session-1', signalName: 'deployment-window' },
    },
  ],
});

if (created.outcome === 'accepted') {
  const receipt: InteractiveSurfaceActionReceipt = await surfaces.act(
    {
      type: 'surface.action',
      contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
      commandId: 'answer-1',
      taskId,
      surfaceId: 'deployment-window',
      revision: created.surface.revision,
      action: 'submit',
      value: { window: 'tonight' },
    },
    { principal: created.surface.owner },
  );
  if (receipt.outcome === 'accepted' && receipt.continuation.type === 'signal') {
    // The caller continues the task: an admitted answer is delivered as the signal.
    console.log(receipt.continuation.signalName, receipt.value);
  }
}
```

## Ownership and audience

Only the task's owner, or a trusted caller, may create, update, close, or abort a task's surfaces. The owner and the principals in `audience` may read a surface and act on it. A caller that states a `taskId` reaches only that task's surfaces, so a child run, a sibling run, or any other task cannot read or change a surface it does not own. Every refusal of this kind is `not-found`, so a caller cannot tell a surface it may not see from one that does not exist. The owner of a surface is the owner of its task; a schedule's service principal is never one.

## Lifecycle

- **Create** commits revision 1, while the task exists and has not ended. A `surfaceId` already in use on the task is a `conflict`.
- **Update** commits only while the surface's `revision` is still the command's `baseRevision`, and each field it omits keeps its value. A stale update is rejected as `stale-revision` and leaves the surface unchanged. Two updates made against the same revision race inside one storage batch, so exactly one commits and the other is `stale-revision`.
- **Snapshot** reads the latest revision.
- **Action admission** is described under [Actions](#actions). An admitted action is recorded in the task's history and leaves the surface's revision unchanged; the receipt names the continuation, and the caller runs it. An exact retry returns the same admission, so the caller keys its delivery by the action's `commandId` and delivers each admission once.
- **Close** tears the surface down: `state` becomes `closed`, `liveness` `torn-down`, and the representation, data, and actions are cleared. Only the summary and close result remain. Like an update, a close commits only while the surface's `revision` is still the command's `baseRevision`; a stale close is rejected as `stale-revision`, so it never discards a change its caller has not seen.
- **Owner abort** and **cancellation** freeze every open surface of the task read-only: `state` becomes `closed`, `liveness` `frozen`, `closeResult.reason` `cancelled`, and the last content stays readable until the task's retention ends. Actions on a frozen surface are rejected as `closed`. Bureau freezes a task's surfaces itself when the task settles (a task whose run has ended while a review is still open reads as `input-required`, not settled, and its surfaces stay live until the review closes): `cancelled` for a cancelled task, `task-ended` for one that completed or failed. Liveness is enforced when a surface is read: a settlement this process did not see (another process's, one before a restart, or one that raced a create) freezes a surface the next time it is read, and every command that changes or acts on a surface refuses an ended task. A surface whose task was deleted is unreachable (`not-found`). Removing a task's surfaces first records a marker that every commit is conditioned on, so a command checked before the removal is refused as `not-found` rather than writing a surface no one can reach.
- **Cleanup** completes when every surface of the task is frozen or closed. `bureau.surfaces.closed(taskId)` resolves that evidence once the task has settled and its surfaces are frozen (`completed`), at once for a task with none (`not-required`), and `failed` when a freeze could not be written; a caller's `signal` bounds its own wait (`unresolved`, `timed-out`). The `surface.cleanup` query answers `pending` with the number still open.
- **Disconnect** is not a command. An observer that goes away releases only its observation; the surface is unchanged.

## Event durability and replay gaps

Each committed change is one event in the task's durable history, owned by `{ kind: 'run', id: taskId }`: `surface.created` (the whole surface), `surface.updated` (`baseRevision` and the changed fields), `surface.action.admitted` (the action, its continuation, and its value), `surface.closed`, and `surface.frozen` (the close result). The surface's current state is written in the same storage batch as its event, conditioned on the state the command was checked against, so the history and the state never disagree, and nothing outside that batch is a source of truth.

`eventCursor` names the event that committed the current revision; replaying the task's history from it yields every later change. It is recorded just after the batch commits, so after a crash in between it reads `null` until the surface next changes. A subscriber that asks for a cursor older than the history's retention floor receives a gap, the same `gap` outcome `bureau.eventHistory` returns, and starts again from a snapshot.

## Retention

A surface follows its task: it stays readable, frozen or closed, until `BureauOptions.taskRetention` ends and Bureau deletes the task, and it is deleted with the task, as `deleteRun` deletes it too. Its events stay in the history until `eventRetention` prunes them.

## Payload limits

A surface's content, its representation, data, summary, actions, and audience as JSON, is capped at `INTERACTIVE_SURFACE_MAX_PAYLOAD_BYTES`, 1 MiB, which is the default `maxRequestBodyBytes` of `createBureauHandler`, so a surface that fits the cap fits in one request. A larger create or update is rejected as `payload-too-large`. Identifiers, each audience principal among them, are at most 256 characters of well-formed Unicode with no control characters, except the ones Bureau composes from others, a `taskId` (a session id plus `:<sequence>`) and a review id, which may be up to 1,024, and a summary at most 4,096.

## Accessibility

A surface's accessibility is its renderer's: Bureau renders nothing. An `input-form` follows Cinder `SchemaForm`'s contract (labelled fields, errors tied to their fields, focus moved to the first invalid field). An `a2ui` surface follows the Cinder component contracts of the renderer in `@lostgradient/chat`, and every component in Cinder's A2UI catalog carries a required accessible `label`. An `mcp-app` is the app author's responsibility inside the host's sandbox. Every surface has a text `summary`, so a host that cannot render it, or a reader using one that does not, still learns what it asks.

## Content classification and redaction

A surface's author may be author code or the model, and Bureau validates every proposal from either as untrusted content: unknown fields are errors, every schema must compile, and the payload is capped. A surface must carry no secret; its content is recorded in the task's history and shown to its owner and audience.

A `sensitive` surface keeps its action values out of the history: `surface.action.admitted` records the value's SHA-256 digest instead, and the admission receipt still carries the value to the caller that continues the task. No surface's state record stores an action value at all: an exact retry of an action carries the same value, which its digest proves, so the replay answers with the retry's own value. The surface's own content is recorded as for any surface. A rejection's `detail` explains the refusal and never echoes a secret.

## Mapping

### A2UI (COR-837)

A2UI v0.9.1's server-to-client messages, confirmed against its `server_to_client.json`, map onto these commands one for one:

| A2UI v0.9.1 | Contract |
| --- | --- |
| `createSurface` (`surfaceId`, `catalogId`, `theme`) | `surface.create` with an `a2ui` representation; the A2UI `surfaceId` is the `surfaceId` |
| `updateComponents` (`surfaceId`, `components`) | `surface.update` with a new `representation`; `componentRevision` rises |
| `updateDataModel` (`surfaceId`, `path`, `value`) | `surface.update` with new `data`; `dataRevision` rises. The adapter applies the path to the current data model and sends the whole of it |
| `deleteSurface` | `surface.close` |
| Client `action` (`name`, `surfaceId`, `sourceComponentId`, `context`) | `surface.action`: `name` is the action's `name` in the catalog, `context` its value, and the revision the client last received its `revision` |
| Client `error` | Not a command; the adapter reports it |
| `a2uiClientDataModel` (with `sendDataModel`) | `surface.context-update`, types only in v1 |

Over AG-UI, the stream projects each surface as an `ACTIVITY_SNAPSHOT` (see [A2UI over AG-UI](#a2ui-over-ag-ui)). Over A2A, it carries the same messages in a `DataPart` whose `metadata.mimeType` is `application/a2ui+json`, under A2UI's extension URI `https://a2ui.org/a2a-extension/a2ui/v0.9.1`, and receives client actions the same way. Bureau emits the A2UI basic catalog by default and offers Cinder's catalog only to a client that lists it in `supportedCatalogIds`.

#### The adapter (experimental)

`createA2uiAdapter({ surfaces })` implements this mapping (COR-837). **It is experimental**: the support is pinned to A2UI v0.9.1 (`A2UI_SPECIFICATION_VERSION`, `A2UI_SUPPORT_STATUS`) and may change until a stable A2UI 1.0 compatibility review. `apply` takes one batch of messages for one surface and commits it as a single store command: `createSurface` plus the `updateComponents` and `updateDataModel` that follow become one `surface.create`, later components and data become one `surface.update`, and a lone `deleteSurface` becomes `surface.close`. The batch is validated whole first, so a refusal commits nothing and returns structured `issues` an author or model can repair from.

- **Catalogs.** Only the vendored basic catalog and Cinder's catalog are known; no client or author can supply one. The basic catalog is the default. Cinder's is offered only when `supportedCatalogIds` lists its id, and a client that lists no known catalog is offered nothing and shown the surface's `summary`. An unknown catalog, component, property, function, or binding is refused. `messages.test.ts` round-trips each message through the vendored `server_to_client.json`.
- **Graph.** Components merge by id; the graph is bounded (500 components, 32 levels), acyclic, and its bindings are well-formed JSON Pointers (`__proto__` is refused). With `complete`, it also needs a `root`, no dangling reference, and nothing unreachable; without it a surface may be built in steps. The data model stays separate, and `updateDataModel` paths are applied deterministically.
- **Actions.** A component can raise only an event the surface declares in `actions`. A client `action` is read at `parseClientMessage`, which takes exactly `name`, `surfaceId`, `sourceComponentId`, and `context` from the body; the task, revision, and idempotency key come from the authenticated request (`toActionRequest`), and the store reauthorizes the result, so an action cannot name a tool, call a function, or continue another task.
- **Retries.** An update or delete must state its `baseRevision`; the adapter forwards it unchanged, so an exact retry of the same batch and `commandId` replays the store's original receipt. `audience` and `classification` are fixed at creation, and an update that states them is refused. An absent data model is stored as `{}`, so a stored `null` is an explicit null and a reconnect replays it as one.
- **Authors.** Author code calls `apply`. A model uses `createProposeA2uiSurfaceTool`, which runs the same path; the host chooses each action's continuation, and the model chooses only its name and intent.
- **Conformance.** `bun run test:a2ui-conformance` (in `packages/bureau`) drives the adapter and the real store through progressive rendering, stale updates, graph repair, typed actions, reconnect, cross-surface authorization, cancellation, deletion, cleanup, and catalog negotiation. It also runs in Bureau's `test`.

#### Over A2A (experimental)

A task read (`GetTask`, `ListTasks`, and the first task a send returns) carries the task's `a2ui` surfaces on its status message. A request that activated A2UI's extension gets one data part per surface, typed `application/a2ui+json`, holding the messages that rebuild it (`a2uiMessagesOf`: `createSurface`, `updateComponents`, and the data model, always, so an explicit `null` survives). Each part's `metadata` carries `surfaceId` and `a2uiSurfaceRevision`, the revision a renderer echoes on its action. A surface is sent as data only when its catalog is one the client declared in `a2uiClientCapabilities` on its send (the basic catalog when it declared nothing, a read declaring nothing), and as its `summary` text otherwise. A `GetTask`, `ListTasks`, or `SubscribeToTask` request has no message to carry `a2uiClientCapabilities`, so those reads offer the basic catalog only and a Cinder surface reads as its `summary`; Bureau does not persist a client's declaration on the task, so a client that wants Cinder surfaces declares its catalogs on the send (or, for AG-UI, as below). Any other request gets each surface's `summary` as text. The card's A2UI extension entry carries `supportedCatalogIds` (the basic and Cinder catalogs), `acceptsInlineCatalogs: false`, and `experimental: true`.

A renderer's `action` arrives as a data part of a `SendMessage` that continues the task, and counts as a surface action only when the request activated the extension, the task is `input-required`, and the message names one of the task's `a2ui` surfaces. The surface store admits it (`surfaces.act`, the message id as the command id) as the task's owner, against the revision in `metadata.a2uiSurfaceRevision`. An action without one is accepted only while the surface is still at revision 1; once it has been updated, a missing revision is refused as stale (`-32602`, `bureau` ErrorInfo `STALE_REVISION`), so a click never applies to a UI its sender did not see. A `review` continuation that names an approval round is refused when the review has since advanced to another round, and a value the action carries reaches a human wait as its structured `data`. The admitted action becomes the answer its host-declared continuation stands for: a `signal` continuation answers that human wait with the action's value (or, for a valueless action, its name), and a `review` continuation approves or denies a tool approval by the action's intent. The answer then travels the ordinary answer path and its ledger, so a retry of the same message is idempotent: the answer is recorded in the ledger claim, and a retry of a claim left pending replays it instead of reading the action against the task's later state.

On a stream (`SendStreamingMessage`, `SubscribeToTask`), a request that activated A2UI's extension gets each surface revision once. The opening `Task` shows the surfaces as a read does, and the stream then re-reads the task's surfaces whenever a `surface.*` event reaches the task's durable history, sending only the revisions above what it has already sent (a revision in the opening snapshot is never sent again, including on a resume). A change goes out as a `statusUpdate` carrying the task's current state, whose message holds the same parts a read holds: an `application/a2ui+json` data part per surface with `surfaceId` and `a2uiSurfaceRevision` in its `metadata`, holding the surface's whole current state (the first delivery begins with `createSurface`; a later frame for a surface the stream already delivered carries `updateComponents` and `updateDataModel` only, because A2UI v0.9.1 forbids a second `createSurface` for an existing id; a replacement that changes `theme` or `sendDataModel`, which only `createSurface` carries, or a replacement that drops a component the client holds, is sent as `deleteSurface` followed by a full recreation), and each surface held to the catalogs the client declared (a send's `a2uiClientCapabilities`; `SubscribeToTask` declares none, so it offers the basic catalog only). A surface that was torn down sends the `deleteSurface` envelope, but only to a client that held it as A2UI data. The frame's SSE `id` is the cursor of the history event that triggered it, so a resume with `Last-Event-ID` re-reads the surfaces as they stand and neither repeats nor loses a revision; surface frames and status frames keep the order of the history they came from. When the task ends, one last read runs first, so a surface frozen with the task is delivered ahead of the terminal status, which stays the last frame; the freeze is delivered only if the task record already shows the task ended when the end is mapped, because the store's task-end freeze runs separately, and a lagging record can let the stream close before it. A task's `input-required` status message names its open waits and their forms and does not repeat the surfaces: they arrive only in the opening snapshot and as these frames. A client that did not activate the extension gets no per-revision surface frames; it sees each surface's text summary in the opening snapshot and on reads, as before. Without a durable history there is no `surface.*` event to follow, so a stream carries the opening snapshot only.

Nothing is left undone on the A2A side. The AG-UI projection is [below](#a2ui-over-ag-ui).

#### A2UI over AG-UI

The AG-UI stream merges a run's surfaces in as a second source (experimental, pinned to A2UI v0.9.1). A run's native events and its surfaces share one durable history, keyed by the task, which is the native run id, so there is one cursor space; the stream is a second consumer of it.

- **Opt-in.** AG-UI has no extension negotiation, so a client opts in as an A2A client does: the `a2uiClientCapabilities` forwarded prop on a start or resume (`{ "v0.9": { "supportedCatalogIds": [...] } }`), or, on any route and the only way for an attach, the `X-A2A-Extensions` header naming A2UI's extension URI, or an `X-A2UI-Client-Capabilities` header carrying the same JSON. A client that does not opt in receives no surface event. An opt-in that lists no catalogs is offered the basic catalog only; one that lists catalogs is offered the known ones it lists, per surface, and a surface in a catalog it did not list is skipped (AG-UI has no text fallback).
- **Event.** One `ACTIVITY_SNAPSHOT` per surface revision: `activityType: "a2ui-surface"`, `messageId` the surface id, `replace: true`, and `content` of `{ surfaceId, surfaceRevision, liveness, messages }`, where `messages` are `a2uiMessagesOf` (a torn-down surface is a lone `deleteSurface`). `surfaceRevision` is what a renderer echoes as `a2uiSurfaceRevision` on its action. Snapshots only, never deltas: an `updated` record carries changes, and a snapshot is what a reconnecting client needs. The event is `durable: false` and carries the surface's `eventCursor`, like `MESSAGES_SNAPSHOT`. The envelope is experimental.
- **Order and reconnect.** The mount has no resume cursor (the SSE `id` is output only); a reconnect is an attach. At open the stream reads the run's history, subscribes to it strictly after the highest cursor it held, and reads the surfaces as they stand, so nothing falls in the gap and a revision is sent once. Surface snapshots are ordered among themselves by revision; against the run's live frames, which are ordered by in-process sequence and include live-only text deltas, they interleave in arrival order. Before the terminal event (and before an interrupt) the stream sends any surface the run last changed; a freeze recorded after the run's terminal record is read on the next attach.
- **Holders and peers.** The holder's stream and a peer's (a process that does not hold the run) use the same source; a child run's stream has none.

### MCP Apps (COR-910)

An `mcp-app` surface is one MCP App instance on a task: the resource it shows (`resourceUri`, `contentDigest`, `mimeType`), the policy its host enforces (`csp`, `permissions`), the tool it presents (`toolName`), and the resource's optional MCP Apps metadata, its dedicated sandbox origin (`domain`) and whether it asks for a border (`prefersBorder`). Reloading the app, or a new resource digest, is an update with a new `instanceId` (an update that changes `resourceUri` or `contentDigest` and keeps the `instanceId` is `invalid`), so a call from the old instance is `stale-instance`. A tool result the app presents is the surface's `data`. An app-to-host call that continues the task (an approval, an answer) is a `surface.action` carrying the app's `instanceId`; a call that only reads (a snapshot, a run's events) is a query the host authorizes as the app's user. An app never reaches a management-plane command, because no action intent names one.

### Human input forms (COR-1487 and COR-1309)

A human-input request with a schema is an `input-form` surface: the request's JSON Schema is `representation.schema`, its prompt is the `summary`, and its answer is an `answer` or `submit` action continuing the human-wait signal, so an admitted value is the signal's payload and has already been validated against the schema. `@lostgradient/chat` renders it with `SchemaForm` and reports a valid submission as `onInputSubmit(toolCallId, value)`, the same `{ toolCallId, value }` an `input` tool action produces, so a host maps that callback onto `surface.action` without reshaping it. Projected as A2UI, the same request becomes a basic-catalog form, with the summary as its text fallback.

## Design

The contract is a one-way door, so how it changes is part of it.

**Versioning.** Every surface, command, and receipt carries `contractVersion`. A Bureau refuses a command whose version it does not implement, and never falls back to an older one on its own.

**Unknown fields.** A command is a closed shape: an unknown field, in the command, its representation, or its actions, is `invalid`. A command carries authority, so a field Bureau does not understand must not be silently dropped. A snapshot or receipt may gain optional fields within v1, and a reader must ignore a field it does not know. A reader that meets a rejection `reason` it does not know treats it as `invalid`, so a reason may be added within v1.

**Growing the union.** A new representation kind, action intent, continuation type, or close reason changes what a renderer must handle, so each arrives only with a new contract version (`bureau.interactive-surface.v2`). A Bureau may accept more than one version during a transition. A new optional command field also needs a new version, because a v1 Bureau refuses it.

**Choices made for v1.**

- **Layout.** `src/interactive-surface/types.ts` holds the wire types, `validation.ts` the checks on untrusted content, `store.ts` the lifecycle, and `bureau-wiring.ts` how a Bureau builds it. `createBureau` gains one call and one property.
- **State beside the history, in the same batch.** A surface's state is a projection written in the same storage batch as its history event, not a fold over the history. The batch is conditioned on the projection the command was checked against, which is what makes the compare-and-swap atomic: a fold alone cannot refuse a stale write without a fence of its own. It also makes a snapshot one storage read. Nothing outside the batch is a source of truth, and the history alone still replays every change.
- **The payload cap** is a constant, `INTERACTIVE_SURFACE_MAX_PAYLOAD_BYTES`, equal to the handler's default `maxRequestBodyBytes` (1 MiB), with a `maxPayloadBytes` option on `createInteractiveSurfaces` rather than a new `BureauOptions` field, until a deployment needs another value.
- **`ajv` is a dependency of Bureau now.** `input-form` is the native kind, and admitting its answer means validating the value against its schema; a shape check alone would admit any value.
- **A2UI is shape-checked only.** Bureau does not vendor the basic catalog's schema yet; COR-837's adapter validates components against their catalog, and Cinder's catalog generator already exports a validator for A2UI messages against Cinder's catalog.
- **Admitted actions are dispatched by the caller.** Admission returns a typed receipt naming the continuation (`resolveReview` for a review, `signalSession` for a signal), and the adapter that received the action runs it, rather than Bureau dispatching it inside admission. The receipt is the wire contract either way; a later version can dispatch inside Bureau without changing it, and each catalog entry already names its continuation's type.
- **Names.** Surface fields follow the existing taxonomy row (`revision`, `baseRevision`, `owner`, `audience`). The event kinds are `surface.*`, recorded under the task's `run` owner, the precedent reviews set: a surface is not a durable-history owner kind of its own.
