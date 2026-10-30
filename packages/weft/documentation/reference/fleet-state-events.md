# Fleet state events

Six engine events report state changes that used to be silent: a realm lifecycle transition, an ownership-lease status change, a declined worker registration, an operator change to a worker deployment, a chunk written to a workflow stream, and a change in a task queue's backlog. All six are classified `published` in `EVENT_CLASSIFICATIONS` (`src/server/runtime/client-visible-events.ts`), so they reach the fleet feed and the `events.read` kind filters. None is on the deny-list: each payload is identifiers, statuses, and counts, with no message text, stream bodies, manifest content, or error text.

Every event is dispatched on the `Engine` and read with `addEventListener`. Their payloads are the own enumerable properties of the event, serialized without `isTrusted`.

| Kind | Scope | Payload | Dispatched when |
| --- | --- | --- | --- |
| `realm:state-changed` | engine | `realmId`, `revision`, `state`, `restartCount` | A revision realm changes lifecycle state (`warming`, `ready`, `active`, `draining`, `terminated`, `crashed`). A realm's construction is not a transition, so the first event for a realm is its first change; a bounded restart from `crashed` back to `warming` is one and carries the incremented `restartCount`. |
| `lease:health-changed` | engine | `status` | The `status` of `getLeaseHealth()` changes: `disabled`, `no-lease`, `healthy`, or `contested`. It fires on lease acquisition, when a renewal attempt settles, when the lease manager reports a loss, and on deposition. A renewal that leaves the status unchanged is silent, and the `WeftEngineLeaseLostWarning` process warning is unchanged. |
| `worker:registration-rejected` | engine | `workerId`, `code` | The worker registry appends a declined `register` attempt to its rejection log. `code` is the `registerError` taxonomy; `workerId` is absent when the frame carried none and is cut to 128 characters because it is not validated yet. |
| `worker:deployment-changed` | engine | `deploymentName`, `buildId` (when one build was named), `drainState`, `routingGeneration` | An operator drains or resumes a deployment or one of its builds, or sets the routing pointer, promotes, or rolls back, after the mutation committed. `drainState` is `active`, `draining`, or `drained`; `routingGeneration` is `0` while no pointer exists. Per-worker drains, the automatic drain of a build the catalog already marks draining, and build removal do not fire it. |
| `stream:chunk` | workflow | `workflowId`, `key`, `sequence` | A chunk written under any stream key other than `tokens` is durably stored. Coalesced per `(workflowId, key)` (see "Stream chunks"): `sequence` is the latest chunk stored when the event fires, not every chunk. It carries no chunk body. The `tokens` key is excluded: it already reaches subscribers through `stream:token` and the workflow feed. The event announces stored chunks, not a finished stream, and a stream that later fails has its partial chunks removed. |
| `queue:depth-changed` | engine | `queue`, `depth` | The pending, unclaimed task count of one of the server's in-memory task queues changes: a task is enqueued or restored, a worker claims one, a task expires or is removed as stale. Coalesced per queue to at most one event per second (see "Queue depth"). A task handed straight to a parked long-poll worker never becomes pending and does not fire it. |

`stream:chunk` is also the name of the workflow feed's internal commit kind (`STREAM_CHUNK_KIND`), which does carry the chunk body for the `tokens` selector. The two are separate layers; the engine event never carries a body.

## Queue depth

`queue:depth-changed` reads its depth from the server's in-memory `TaskQueue` (`pendingCount(queue)`), not from the durable task ledger. The depth is therefore **per-process**: it counts the tasks pending in the process that raised the event. A deployment that runs several server processes raises one stream of depths per process and does not sum them, and a process that restarts begins again at `0` until its ledger recovery re-enqueues work. Tasks dispatched to a worker are not counted; they are no longer pending.

Coalescing is per queue and needs no clock. The first change after a quiet second is announced at once and opens a one-second window. Further changes inside the window raise nothing; when the window closes the queue reads its depth again and announces it if it differs from the last announced value, which opens the next window. So a queue emits at most once per second, the latest depth is always announced within one second of the last change, and a burst that ends at `0` ends with a `0` event. A change that leaves the depth as announced is silent, and a queue that is empty and quiet holds no state. Shutting the server down clears the open windows without a final event.

## Stream chunks

`stream:chunk` is coalesced per workflow stream key, with a 250 ms window (`STREAM_CHUNK_EVENT_INTERVAL_MILLISECONDS`). The first chunk stored under a key after a quiet window is announced at once and opens a window. Chunks stored inside the window raise nothing; when the window closes, the latest stored sequence is announced if it is newer than the one announced, which opens the next window. A consumer that treats the event as a signal to read the chunks after the last one it holds therefore sees every chunk, but not one event per chunk.

The last chunk of a stream is always announced. When a stream operation completes, its pending sequence is announced before the operation returns, and when a workflow reaches a terminal state, every pending sequence of its keys is announced before its terminal event. A stream that fails has its pending sequence dropped before its partial chunks are removed, so no event names a removed chunk; a chunk that was already announced may still have been removed, as before. Every event, trailing ones included, carries the execution generation of the run that stored the chunk it names, so a run that a `start-new` replacement superseded announces nothing, and a replacement's first chunk on the same key is announced at once. Disposing the engine cancels the open windows without a final event.

## Volume

`queue:depth-changed` is bounded by its coalescing: at most one event per second for each queue with a changing backlog.

`stream:chunk` is bounded the same way: at most one immediate and one trailing event per stream key per 250 ms window, plus one when the stream completes. Because it is workflow-scoped and published, each event adds one watch-storage write and one fleet-feed append, serialized on the workflow's event chain, so a long stream costs a handful of writes per second rather than one per chunk.
