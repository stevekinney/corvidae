# Fleet state events

Five engine events report state changes that used to be silent: a realm lifecycle transition, an ownership-lease status change, a declined worker registration, an operator change to a worker deployment, and a chunk written to a workflow stream. All five are classified `published` in `EVENT_CLASSIFICATIONS` (`src/server/runtime/client-visible-events.ts`), so they reach the fleet feed and the `events.read` kind filters. None is on the deny-list: each payload is identifiers, statuses, and counts, with no message text, stream bodies, manifest content, or error text.

Every event is dispatched on the `Engine` and read with `addEventListener`. Their payloads are the own enumerable properties of the event, serialized without `isTrusted`.

| Kind | Scope | Payload | Dispatched when |
| --- | --- | --- | --- |
| `realm:state-changed` | engine | `realmId`, `revision`, `state`, `restartCount` | A revision realm changes lifecycle state (`warming`, `ready`, `active`, `draining`, `terminated`, `crashed`). A realm's construction is not a transition, so the first event for a realm is its first change; a bounded restart from `crashed` back to `warming` is one and carries the incremented `restartCount`. |
| `lease:health-changed` | engine | `status` | The `status` of `getLeaseHealth()` changes: `disabled`, `no-lease`, `healthy`, or `contested`. It fires on lease acquisition, when a renewal attempt settles, when the lease manager reports a loss, and on deposition. A renewal that leaves the status unchanged is silent, and the `WeftEngineLeaseLostWarning` process warning is unchanged. |
| `worker:registration-rejected` | engine | `workerId`, `code` | The worker registry appends a declined `register` attempt to its rejection log. `code` is the `registerError` taxonomy; `workerId` is absent when the frame carried none and is cut to 128 characters because it is not validated yet. |
| `worker:deployment-changed` | engine | `deploymentName`, `buildId` (when one build was named), `drainState`, `routingGeneration` | An operator drains or resumes a deployment or one of its builds, or sets the routing pointer, promotes, or rolls back, after the mutation committed. `drainState` is `active`, `draining`, or `drained`; `routingGeneration` is `0` while no pointer exists. Per-worker drains, the automatic drain of a build the catalog already marks draining, and build removal do not fire it. |
| `stream:chunk` | workflow | `workflowId`, `key`, `sequence` | A chunk written under any stream key other than `tokens` is durably stored. It carries no chunk body. The `tokens` key is excluded: it already reaches subscribers through `stream:token` and the workflow feed. The event announces a stored chunk, not a finished stream, and a stream that later fails has its partial chunks removed. |

`stream:chunk` is also the name of the workflow feed's internal commit kind (`STREAM_CHUNK_KIND`), which does carry the chunk body for the `tokens` selector. The two are separate layers; the engine event never carries a body.

Not yet part of this set: `queue:depth-changed`. Its source of truth is an open decision.

## Volume

`stream:chunk` is dispatched once per stored chunk. Because it is workflow-scoped and published, each event adds one watch-storage write and one fleet-feed append, serialized on the workflow's event chain. A workflow that streams many small chunks under a non-token key produces proportionally many events.
