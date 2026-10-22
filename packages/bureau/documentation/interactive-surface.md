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

- **`input-form`** is the native kind, which every host must render. Its `schema` is a JSON Schema 2020-12 schema of an object; the schema must compile, may not declare `$id`, may not be asynchronous (admission validates synchronously), may not use `pattern` or `patternProperties` (an untrusted regular expression can stall Bureau when a value is admitted), and has no `format` assertion (the 2020-12 default). `submitLabel` optionally names the submit control. `@lostgradient/chat` renders it with Cinder's `SchemaForm`.
- **`a2ui`** is an A2UI surface, experimental, pinned to A2UI `v0.9.1` by `specificationVersion`. It carries the `catalogId` its components come from, the `components` list as A2UI's `updateComponents` carries it (one has the id `root`, and ids are unique), and an optional `theme`. Bureau checks this shape; it does not validate the components against their catalog (see [Design](#design)).
- **`mcp-app`** is an MCP App: its `ui://` `resourceUri`, the `text/html;profile=mcp-app` `mimeType`, the `contentDigest` of the resource's bytes (`sha256:` and 64 lowercase hex digits), the `instanceId` of the app instance this revision shows, its `csp` (`connectDomains`, `resourceDomains`, and optionally `frameDomains` and `baseUriDomains`, each a list of origins: a scheme of `https`, `http`, `wss`, or `ws`, a host, and an optional port, with no path, query, fragment, or credentials), its `permissions` (`camera`, `microphone`, `geolocation`, `clipboardWrite`; an absent one is denied), and optionally the `toolName` whose result it presents. Bureau applies no narrower guard than this: the host's sandbox contains the app.

An update may replace the representation, but not change its kind.

## Actions

An action continues the surface's own task, and nothing else. Its `intent` is one of four, and its continuation must name the surface's own task: a review whose identifier names the task's run (`approval:<taskId>:…` or `human-wait:<taskId>:…`), or a signal to the task's own session. A create or update naming any other is `invalid`, because a surface's author may be the model, and the receipt's continuation is what the caller dispatches.

| Intent             | Continuation                                | Continued by           |
| ------------------ | ------------------------------------------- | ---------------------- |
| `approve`, `deny`  | `{ type: 'review', reviewId }`              | `bureau.resolveReview` |
| `answer`, `submit` | `{ type: 'signal', sessionId, signalName }` | `bureau.signalSession` |

Each action in the catalog has a unique `name`, its `intent`, its `continuation`, an optional `label`, and an optional `valueSchema`. An action's value must satisfy its `valueSchema`; on an `input-form` surface, an `answer` or `submit` action without one takes the form's own schema; any other action without one takes no value. Management-plane commands are never reachable from a surface: there is no intent for them.

A renderer is never trusted. An action arrives as a command and is admitted only when the surface is open, the caller may act on it, the `revision` the renderer showed is the surface's current revision, the action is in the catalog, the value satisfies its schema, and, for an `mcp-app`, the request comes from the instance the surface shows: a caller that states a principal must also state the `instanceId`, and it must be the one the surface shows. Anything else is denied and commits nothing.

## Commands and receipts

Every command carries `contractVersion`, a `type`, the `taskId`, and a `commandId`, the caller's idempotency key. An exact retry, the same `commandId` with the same content, returns an acceptance with `replayed: true` and commits nothing; its `committedRevision` is the revision the original command committed, and its `surface` is the surface as it stands now, which later commands may have changed; the same `commandId` with other content is rejected as a `conflict`. A surface remembers its 64 most recent commands for this.

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

A receipt is either an acceptance or an `InteractiveSurfaceRejection`, whose `reason` is one of `invalid`, `not-found`, `conflict`, `stale-revision` (with the surface's `currentRevision`), `stale-instance`, `closed`, `payload-too-large`, or `unsupported-capability`. A rejection commits nothing. `bureau.surfaces` never throws for a refused command; it throws only when storage fails.

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
if (surfaces === undefined) throw new Error('surfaces need persistent storage');

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
- **Action admission** is described under [Actions](#actions). An admitted action is recorded in the task's history and leaves the surface's revision unchanged; the receipt names the continuation, and the caller runs it.
- **Close** tears the surface down: `state` becomes `closed`, `liveness` `torn-down`, and the representation, data, and actions are cleared. Only the summary and close result remain.
- **Owner abort** and **cancellation** freeze every open surface of the task read-only: `state` becomes `closed`, `liveness` `frozen`, `closeResult.reason` `cancelled`, and the last content stays readable until the task's retention ends. Actions on a frozen surface are rejected as `closed`. Bureau freezes a task's surfaces itself when the task settles (a task whose run has ended while a review is still open reads as `input-required`, not settled, and its surfaces stay live until the review closes): `cancelled` for a cancelled task, `task-ended` for one that completed or failed. A settlement this process did not see, another process's or one before a restart, freezes a surface the next time it is read.
- **Cleanup** completes when every surface of the task is frozen or closed. `bureau.surfaces.closed(taskId)` resolves that evidence once the task has settled and its surfaces are frozen (`completed`), at once for a task with none (`not-required`), and `failed` when a freeze could not be written; a caller's `signal` bounds its own wait (`unresolved`, `timed-out`). The `surface.cleanup` query answers `pending` with the number still open.
- **Disconnect** is not a command. An observer that goes away releases only its observation; the surface is unchanged.

## Event durability and replay gaps

Each committed change is one event in the task's durable history, owned by `{ kind: 'run', id: taskId }`: `surface.created` (the whole surface), `surface.updated` (`baseRevision` and the changed fields), `surface.action.admitted` (the action, its continuation, and its value), `surface.closed`, and `surface.frozen` (the close result). The surface's current state is written in the same storage batch as its event, conditioned on the state the command was checked against, so the history and the state never disagree, and nothing outside that batch is a source of truth.

`eventCursor` names the event that committed the current revision; replaying the task's history from it yields every later change. It is recorded just after the batch commits, so after a crash in between it reads `null` until the surface next changes. A subscriber that asks for a cursor older than the history's retention floor receives a gap, the same `gap` outcome `bureau.eventHistory` returns, and starts again from a snapshot.

## Retention

A surface follows its task: it stays readable, frozen or closed, until `BureauOptions.taskRetention` ends and Bureau deletes the task, and it is deleted with the task, as `deleteRun` deletes it too. Its events stay in the history until `eventRetention` prunes them.

## Payload limits

A surface's content, its representation, data, summary, and actions as JSON, is capped at `INTERACTIVE_SURFACE_MAX_PAYLOAD_BYTES`, 1 MiB, which is the default `maxRequestBodyBytes` of `createBureauHandler`, so a surface that fits the cap fits in one request. A larger create or update is rejected as `payload-too-large`. Identifiers are at most 256 characters with no control characters, and a summary at most 4,096.

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

Over AG-UI, the adapter projects each committed revision as an `ACTIVITY_SNAPSHOT` whose `messageId` names the surface and whose `content` holds its A2UI messages, and a replay from `eventCursor` re-sends them in order. Over A2A, it carries the same messages in a `DataPart` whose `metadata.mimeType` is `application/a2ui+json`, under A2UI's extension URI `https://a2ui.org/a2a-extension/a2ui/v0.9.1`, and receives client actions the same way. Bureau emits the A2UI basic catalog by default and offers Cinder's catalog only to a client that lists it in `supportedCatalogIds`.

### MCP Apps (COR-910)

An `mcp-app` surface is one MCP App instance on a task: the resource it shows (`resourceUri`, `contentDigest`, `mimeType`), the policy its host enforces (`csp`, `permissions`), and the tool it presents (`toolName`). Reloading the app, or a new resource digest, is an update with a new `instanceId` (an update that changes `resourceUri` or `contentDigest` and keeps the `instanceId` is `invalid`), so a call from the old instance is `stale-instance`. A tool result the app presents is the surface's `data`. An app-to-host call that continues the task (an approval, an answer) is a `surface.action` carrying the app's `instanceId`; a call that only reads (a snapshot, a run's events) is a query the host authorizes as the app's user. An app never reaches a management-plane command, because no action intent names one.

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
