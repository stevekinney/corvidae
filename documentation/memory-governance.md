# Memory governance and lifecycle evaluation

Once memory outlives one conversation and more than one principal can reach it, three questions matter more than recall quality. Should this memory exist? Can this caller use it? Can we remove it, and say honestly how far the removal got? This guide covers what [Memory](../packages/memory/README.md), [Bureau](../packages/bureau/README.md), and [Evaluation](../testing/evaluation/README.md) ship to answer them, how the pieces connect, and what they do not do.

The binding decision is COR-806: deletion-propagation timing, retention periods, and legal-hold handling. The memory classes come from the COR-750 lifecycle contract. COR-41 implemented governed memory and Bureau's enforcement of it. COR-755 built the action-based memory-lifecycle evaluation. The package READMEs are the API references; this guide is the map.

## Choose the surface

| You need to | Use | Governed |
| --- | --- | --- |
| Remember and recall for one trusted process | `createMemory()` | No. Whoever holds the `Memory` can do anything with it. |
| Share memory across users, agents, tools, or tenants | `createGovernedMemory()` | Yes. |
| Give the runs Bureau composes governed recall and persistence | `BureauOptions.memory` | Yes, for tasks (`bureau.tasks.start`), schedule-fire, and recovered runs. Catalog runs get no memory hooks. |
| Let a model store, recall, and forget | `createGovernedMemoryTools()` | Yes, under each call's persisted request authority. |
| Decide whether a memory architecture change makes agents act better | `bun run --cwd testing/evaluation memory-lifecycle run` | Not applicable: it measures, it does not govern. |

`createMemoryHooks()`, the ungoverned memory tools, `ingest()`, `createFileSynchronizer()`, and Operative's `createMemoryBridge()` all work on an ungoverned `Memory`. They have no authority, admission, or receipts.

## Who may act

Every governed call takes a `MemoryAuthority`: the acting principal and its kind, the tenant, the owner it acts for, a purpose, capabilities, the delegation chain the capabilities came through, the authorization revision, and the projection the call arrived through. The authority has no namespace field. A collection name or record id in a request only selects inside the scope the authority already owns, and a guessed id reads exactly like a missing record.

A delegated authority can only narrow. `attenuateMemoryAuthority()` rejects a request for a capability the parent lacks, or for a more privileged principal kind, with a `MemoryAuthorityError` whose code is `escalation`. Governance and service privilege come from the whole delegation chain, never from the actor's declared kind: any user, agent, run, or tool upstream withholds them. That is what keeps legal holds (`memory:legal-hold`), retention sweeps (`memory:retention`), and policy changes (`memory:policy`) out of reach of anything a model can drive. See the memory README's [Authority](../packages/memory/README.md#authority) section for every capability.

## One predicate for every projection

`decideMemoryAccess(authority, operation, resource)` decides list, get, search, write, promote, share, export, quarantine, revoke, and delete. It takes the record's persisted governance, not anything the caller supplies. It records the projection (`bureau`, `agent`, `child`, `tool`, `a2a`, `mcp`, `audit`, or `administrative`) for attribution and never consults it, so every projection gets the same decision and the same redaction. What each projection has today:

| Projection | What ships |
| --- | --- |
| `bureau` | Bureau's recall and persistence hooks, under `createRunMemoryAuthority()`, and `createBureauHandler`'s `bureau.memory.*` operations, under a `user` authority per call. |
| `tool` | `createGovernedMemoryTools()`. |
| `agent`, `child` | `attenuateMemoryAuthority()`, for a host to derive a narrower authority. |
| `audit`, `administrative` | The host's own calls, under an authority it builds. |
| `a2a`, `mcp` | No adapter exists in this repository. One would build an authority with that projection and call governed memory like any other caller. |

What a call without the capability gets back depends on the method. `write()` is `rejected` with `missing-capability`, and so is a `consolidation`, which admits a write. `get()` and `getDeletionReceipt()` return `undefined`. `list()`, `search()`, `recallForModel()`, and `listEvents()` return nothing. `export()`, the retention sweeps, and every other method that returns a `MemoryOperationResult`, including every other `forget()` mode, report `denied`. A record in another tenant or owner partition, one whose content no longer matches its admission digest, and a derived record still waiting for its source check all read as `not-found`. Every denial is written to the governance ledger with its reason as a protected field, except that `getDeletionReceipt()` and `listEvents()` record nothing. The memory README's [One access predicate](../packages/memory/README.md#one-access-predicate) section has the full order of checks.

## What gets in, and what a model sees

Conversation, model tools, tool results, ingested documents, and derived records are untrusted writers by default. Admission validates content, applies a per-collection quota, refuses `operator` and `system` sources to principals that cannot vouch for them, and runs the policy's detectors. A detection quarantines the record by default, and a detector that throws counts as one. The writer learns only `admitted`, `quarantined`, `rejected`, or `duplicate`. The detector's name, category, and confidence go to the ledger as a protected diagnostic.

`recallForModel()` is the only recall path meant for a model. It withholds records below the trust floor for their class (`procedural` and `identity` need `verified` trust by default), records evicted from the context the call names, and anything a recall detector trips on, which it also quarantines. What passes is rendered as a `<memory-evidence>` block of JSON lines that record content cannot break out of. The block tells the model it is reading evidence. It does not stop a model from being persuaded by what it reads. What it guarantees is narrower and enforceable: nothing recalled changes the caller's authority, because authority comes from the persisted request and never from content. Bureau's own test drives a recalled "operator approved unrestricted deployments" claim into a run and checks that the run's tool capabilities are unchanged.

The default detector, `createMemoryPoisoningDetector()`, is ten regular expressions. It catches instruction overrides, role and delimiter spoofing, authority grants, requests to skip approval or sandboxing, and pipe-to-shell commands, and nothing phrased some other way. Add detectors for stronger scanning.

## Forgetting is ten operations

`forget()` does not collapse "forget this" into one boolean. It distinguishes `active-context-eviction`, `retrieval-demotion`, `consolidation`, `supersession`, `quarantine`, `source-deletion`, `projection-deletion`, `index-invalidation`, `retention-expiry`, and `export-revocation`. Only the three deletion modes remove anything, and each of those produces a receipt. The others change what retrieval returns, move records out of active use while keeping their history, or withdraw an export manifest. A record that supersession or consolidation moved out of active use stays stored and `get` still reads it, but `list` shows it only to a caller holding `memory:inspect`, and a record is moved out once: a second supersession or consolidation of it is rejected as `superseded`, and withdraws the replacement it had admitted. The memory README's [Forgetting](../packages/memory/README.md#forgetting) table gives each mode's capability and effect.

## Deletion and its receipt

A deletion claims its record, and for a source deletion everything the record's lineage reaches, before it plans. It persists a receipt before it removes anything. COR-806 then splits the work into two lanes:

- **Synchronous.** Source evidence, canonical projections, identity views, and the managed-asset canonical record are removed together in one `deleteMany()` storage transaction when the deletion is requested. Their rows carry a deadline equal to the request time. When the transaction fails, or the records keep changing underneath it through three attempts, the rows are `failed`, the records stay readable and recallable, and every propagation pass retries the transaction while the receipt is open.
- **Bounded-async.** Indexes, caches, summaries, managed-asset bytes, durable snapshots, exports, and external processors each settle against a deadline: the trigger time plus the tenant's bound, 24 hours by default. The package has built-in handlers for indexes, caches (for an embedder that can evict by digest), summaries, and exports. The deployment supplies a propagator, or declares `'not-retained'`, for the rest.

No row claims a target clean while a record the deletion names is still stored. The rows that remove records settle first: a source deletion's synchronous rows and its `summaries` row, or a projection deletion's own row. Every other row waits until they complete, and fails at its deadline if they have not.

Every target row reports one of COR-806's five statuses:

| Status | Meaning |
| --- | --- |
| `completed` | Removed or invalidated, declared `'not-retained'`, or reported done by a propagator. |
| `pending` | Not settled yet, with a `deadline`. A pending bounded-async row never passes its deadline silently: the first propagation pass at or after it fails the row, including a row still waiting for the deletion's records to be removed. |
| `exempt` | Retained under a legal hold. A deletion held when it is requested reports every row `exempt`, and a hold found partway exempts every row not yet settled. |
| `failed` | The storage transaction failed or its records kept changing through three attempts, a propagator reported failure, or a bounded-async row was still pending on the first propagation pass at or after its deadline. |
| `unknown` | A propagator reported that the deletion cannot be observed. Nothing reports it by default, and it is never used for work that simply has not happened yet. |

The call reports what happened to the record it names, not to every target. `delete()` and the three `forget()` deletion modes return `applied` only when the record was removed, with `deletion: 'completed'`, the status of the row that removes it. A held deletion returns `unchanged` with `deletion: 'exempt'`, and a failed one returns `unchanged` with `deletion: 'failed'`. A summary deleted as a projection is removed in the bounded-async lane, so its deletion can also return `unchanged` with `deletion: 'pending'`, while that row is still retried, or `'unknown'`, when a propagator reports that the removal cannot be observed. A held or failed deletion leaves the record stored, readable, and recallable. The model-facing `memory_forget` tool follows the same rule: `{ deleted: true }` only once the record is gone, and otherwise `{ deleted: false, reason }` with `held`, `failed`, or `refused`. The memory README's [Operation results](../packages/memory/README.md#operation-results) section has the full table.

This walk-through runs in [`packages/memory/test/governance/memory-governance-guide.test.ts`](../packages/memory/test/governance/memory-governance-guide.test.ts), which imports from the package source instead of `@lostgradient/memory` and asserts every commented result. It takes one deletion through every status:

```typescript
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage } from '@lostgradient/storage';
import {
  createGovernedMemory,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMemoryVectorStore,
  createMockEmbedder,
  createTestEmbedders,
  createWeftMemoryRecordStorage,
  withEmbeddingCache,
} from '@lostgradient/memory';

const HOUR = 60 * 60 * 1000;
// A manual clock, so the example can move past the deletion deadline.
const runtime = createManualRuntimeServices();
const storage = new MemoryStorage();
const memory = createGovernedMemory({
  storage: createWeftMemoryRecordStorage(storage, { runtime }),
  ledger: createMemoryGovernanceLedger(storage),
  // Evicts by content digest, so the built-in `caches` handler can complete.
  ...createTestEmbedders(withEmbeddingCache(createMockEmbedder(64)), 64),
  vectors: createMemoryVectorStore(storage),
  policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
  runtime,
  propagation: {
    // This deployment keeps no raw asset bytes.
    'managed-asset-bytes': 'not-retained',
    // The CRM vendor accepts deletion requests but offers no way to confirm them.
    'external-processors': {
      async propagate() {
        return { status: 'unknown', detail: 'vendor offers no deletion confirmation' };
      },
    },
    // 'durable-snapshots' is left undeclared on purpose: see below.
  },
});
await memory.init();

const alice = createMemoryAuthority({
  principal: { kind: 'user', id: 'user:alice' },
  tenantId: 'acme',
  ownerId: 'alice',
  purpose: 'support-memory',
  capabilities: ['memory:write', 'memory:delete'],
  policyRevision: 'authorization:7',
  projection: 'bureau',
});
const phone = await memory.write(alice, 'Call Alice at 555-0100.', {
  collection: 'support',
  source: 'conversation',
});

// 1. The request. The synchronous lane has already run when `delete` returns.
const deleted = await memory.delete(alice, { id: phone.recordId!, collection: 'support' });
console.log(deleted.status); // 'applied': the record is gone, though a row is still pending
console.log(deleted.deletion); // 'completed': the status of its 'source-evidence' row
const { receipt } = deleted;
console.log(Object.fromEntries(receipt!.targets.map((row) => [row.target, row.status])));
// {
//   'source-evidence': 'completed',
//   'canonical-projections': 'completed',
//   'identity-views': 'completed',
//   'managed-asset-record': 'completed',
//   indexes: 'completed',
//   caches: 'completed',
//   summaries: 'completed',
//   'managed-asset-bytes': 'completed', // declared 'not-retained'
//   'durable-snapshots': 'pending', // no propagator and no declaration
//   exports: 'completed',
//   'external-processors': 'unknown', // the vendor cannot say
// }
console.log(receipt!.open); // true: a target is still pending
// The pending row's deadline is requestedAt + 24 hours.

// 2. The deadline passes. A propagation pass fails the bounded-async rows still pending.
await runtime.advance(24 * HOUR);
await memory.processDeletionPropagation();
const settled = await memory.getDeletionReceipt(alice, receipt!.deletionId);
const failed = settled!.targets.find((row) => row.target === 'durable-snapshots');
console.log(failed?.status); // 'failed'
console.log(failed?.detail); // 'deadline passed before propagation completed'
console.log(settled!.open); // false

// 3. A legal hold. Only a governance principal can place one.
const counsel = createMemoryAuthority({
  principal: { kind: 'governance', id: 'governance:counsel' },
  tenantId: 'acme',
  ownerId: 'legal',
  purpose: 'litigation-hold',
  capabilities: ['memory:legal-hold'],
  policyRevision: 'authorization:7',
  projection: 'administrative',
});
const address = await memory.write(alice, 'Alice lives at 12 Elm Street.', {
  collection: 'support',
  source: 'conversation',
});
const locator = { id: address.recordId!, collection: 'support', ownerId: 'alice' };
await memory.placeLegalHold(counsel, locator);

const held = await memory.delete(alice, locator);
console.log(held.status); // 'unchanged': the record is still stored
console.log(held.deletion); // 'exempt'
console.log(held.receipt!.targets.every((row) => row.status === 'exempt')); // true: every row 'exempt'
console.log(held.receipt!.awaitingHoldRelease); // true

// 4. The release re-queues the deletion under a new receipt.
const released = await memory.releaseLegalHold(counsel, locator);
const requeued = await memory.getDeletionReceipt(alice, released.requeued![0]!);
console.log(requeued!.trigger); // 'hold-release'
console.log(requeued!.targets.find((row) => row.target === 'source-evidence')?.status); // 'completed'

await memory.close();
```

Step 2 is the fail-closed rule at work. Nobody told the package how to delete durable snapshots, so it did not pretend: the row waited out its bound and then reported `failed`. In a real deployment, either give `durable-snapshots` a propagator that deletes the conversation snapshots and checkpoints the deployment keeps, or declare it `'not-retained'` if it keeps none. The `unknown` row is the honest answer for a processor that cannot confirm anything.

A receipt survives a restart because it lives in the governance ledger. `processDeletionPropagation()` resumes an interrupted synchronous lane, retries a failed one while its receipt is open, advances every open receipt, and re-queues a held deletion whose release crashed before its re-queue was recorded. Nothing calls it for you. The memory README's [Deletion and receipts](../packages/memory/README.md#deletion-and-receipts) section has the propagator contract and every receipt field.

## Legal hold and retention

A legal hold moves `none` to `held` to `released`, never back to `none`, and only a principal with `memory:legal-hold` through a chain made only of governance principals can place or release one. A hold on the record a deletion names exempts the whole deletion, and so, for a source deletion, does a hold on anything its lineage reaches. Either way the call returns `unchanged` with `deletion: 'exempt'`. A projection deletion checks only its own record, so a hold on the record it was derived from, or on a record derived from it, does not exempt it: the projection is removed, and the held record stays stored, because a projection deletion reaches no other record. A later deletion of the projection's source still reaches a held record derived from the projection, through the projection's lineage, so that hold exempts the source deletion. The deletion still claims its records, held or not: the deleted record and, for a source deletion, everything its lineage reaches. It does so whether `delete()`, a `forget()` deletion mode, `sweepRetention()`, or `expireWorkingMemory()` requested it. Until the hold is released and the re-queued deletion removes them, those records stay readable and recallable, but they are left out of every export, an inspecting one included, and cannot be promoted or used as a `derivedFrom` source, a consolidation input included. That is the ordinary claim that [A claim does not hide the record](#what-deletion-cannot-guarantee) describes. Here the implementation departs from COR-806, which says a held record is not deleted, invalidated, or queued while `held`. Holds on those same records are checked again before the synchronous lane and before each bounded-async target, so a hold placed on one of them mid-deletion exempts whatever has not settled yet. What already settled stays settled, so a hold on a summary found after a source deletion removed its record leaves that deletion `applied`. Release re-queues the rest under a `hold-release` receipt with fresh deadlines. A hold never brings back anything already deleted. A held derived record whose sources no longer back it stays stored and hidden until a propagation pass after the release withdraws it. Holds and quarantine are independent: a hold blocks deletion, and quarantine blocks retrieval.

Retention expiry is a deletion with the same plan and the same receipt. COR-806 fixes the defaults, and each can be overridden per tenant:

| Class | Retention |
| --- | --- |
| `working` | The owning run's lifetime. The host ends it with `expireWorkingMemory(authority, runId)`. |
| `episodic` | 90 days from the event or observation time. |
| `semantic`, `procedural` | Until superseded, then 90 days from supersession. |
| `identity` | No clock. Deleted only on request. |
| `resource` | No clock of its own. A resource written with `derivedFrom` goes when a deletion of its source reaches it. |
| Audit receipts and events | At least one year, pruned by the retention sweep. A receipt is never deleted by the deletion it documents. |

`sweepRetention()` runs as a service or governance principal with `memory:retention` and `memory:delete`. A dry run reports what would expire, and previewing a candidate policy works only as a dry run, so only an activated policy revision ever deletes. Activating or rolling back a policy needs the platform-level `memory:policy` capability, changes future decisions only, and lasts only for the life of the process: a new instance starts from the policy it is constructed with.

## Bureau

Bureau is the first consumer. It derives each run's memory authority from the run's persisted request authority through a three-link chain: a `service` principal with id `bureau` holding the deployment's `runCapabilities` (`memory:search` and `memory:write` by default), then the request principal, then the run. Explicit `memory:*` capabilities on the request can only narrow that grant. A grant narrowed to nothing, including `runCapabilities: []`, still leaves both hooks attached: every run's recall and write are refused as `missing-capability` and recorded as `memory.access.denied` events that reach `onEvent`. Leave `BureauOptions.memory` unset to attach no memory hooks.

Where a run's memory lives: the tenant is the Bureau's identifier (`Bureau.id`), the owner is the run's owner of record (the owner persisted on its session, `anonymous:local` when none was recorded, and the schedule's owner for a schedule's fire), and the collection is the agent's identifier. Memory therefore follows an agent across every chat its owner has with it, and does not follow an agent's name across owners. The persist hook writes the chat that produced a record into its `metadata` as `sessionId`. A Bureau with persistent memory needs a stable `BureauOptions.id`, because the generated default changes on every restart and the restarted Bureau would read a partition that holds none of what it remembered. A request with no request context no longer decides the partition: the request authority's tenant and owner are the tools' authority, not memory's.

Recall runs on step 0 over the agent's collection and arrives as a labeled system message, which the AG-UI messages snapshot leaves out of the thread a person reads (the stored conversation keeps it). The final answer is written as untrusted `conversation` memory. Every run writes it with the deterministic dedupe key `<runId>:<step>`, so a replayed step cannot write twice, provided the governed memory's storage implements `getByDedupeKey()` and `putOnce()`, as both bundled backends do. A run that starts again without a durable engine can still store a second answer when it answers on a different step. A write governed memory rejects stores nothing, and Bureau reports it to `onDiagnostic` as a `warn` with scope `memory`.

The memory is read and changed through `createBureauHandler`'s `bureau.memory.list`, `search`, `get`, `export`, `forget`, `correct`, `share`, `share.revoke`, `quarantine`, `hold`, and `hold.release` operations. They need the scope `bureau.memory:read` (list, search, get, export), `bureau.memory:write` (forget, correct, share, share.revoke, quarantine), or `bureau.memory:govern` (hold, hold.release), answer `Forbidden` without it even for the caller's own memory, and never grant another owner's: each call builds an authority for the caller's own partition (a `user` one, and a `governance` one for the legal hold, which governed memory takes from no other kind), so a record of another owner is `NotFound`. The one door to another owner's record is a share: `share` lets the grantee `get` that record, naming its owner as `ownerId`, and nothing else, until `share.revoke`. Every call lands in the ledger under the caller's owner, so a share records its grantor. `forget` is a source deletion that answers the receipt; `correct` is a supersession by an `operator` successor, and a list shows the successor and not the original. A concurrent pair of corrections, or of consolidations, replaces a record once: the stamp that takes a record out of use is a compare-and-swap that declines one already replaced, and the loser withdraws what it admitted.

Bureau does not attach memory hooks to catalog runs (`bureau.run`) or to `bureau.children` children. It does not copy governance events into its audit trail. Its maintenance pass, `maintain()` and the automatic timer, calls `sweepRetention()` under a `service:bureau` authority holding only `memory:retention` and `memory:delete`, and then `processDeletionPropagation()`, so an expired record is deleted and the deletion's bounded-async targets settle without the host scheduling either. It never runs working-memory expiry, which Bureau has no use for because its hooks write only `episodic` records. `BureauOptions.retention.memory` (also the live setting `retention.memory`) replaces the policy's `episodic` duration for each sweep through `sweepRetention`'s `retention` option, without activating a policy revision. The sweep frees only records that have expired, so a collection that fills with records still inside retention is bounded by the policy's quota, which is the host's to set. The Bureau README's [Governed memory](../packages/bureau/README.md#governed-memory-cor-41) section has a tested example and the details.

## Switching the embedder

Memory keeps its vectors per embedding profile: the embedder that made them, their dimension, and a generation. One profile is active, and recall and admission use it. `memory.embedding.switchTo(id)` starts a durable switch to another registered embedder. The switch fills a new profile, whose generation no profile has had before, with a vector for every stored record. Recall keeps the active profile until the switch completes, and then the new profile becomes active in one compare-and-swap. A switch to an embedder that is not loaded, or that `needs-setup`, is refused, and so is a switch while one is running.

While a switch runs, every admission is embedded into both profiles, and every deletion removes the record from both. When the target embedder errors on an admission, the admission still succeeds, and the switch embeds the record later. The switch writes each vector with the `version` the record had when it was read, then reads the record again. When the record was deleted or changed in between, the switch withdraws the vector from the target and embeds the record again later. A forgotten record therefore never reappears, and a correction is never overwritten. When that read finds the record deleted, the switch, or the admission, also evicts the content it just embedded from every embedder that caches content, because the deletion's `caches` target may already have run. The target profile is the switch's checkpoint: a restart resumes the switch, and a record the target already holds is not embedded again. A switch starts only while the switch record and the active profile are still what it read; a start that lost to another switch reads again.

`memory.embedding.cancel()` cancels a running switch, and deletes the profile it was filling. A switch whose embedder errors, or gives a vector of the wrong length or with an entry that is not a finite number, fails with that error, and one whose embedder a restart no longer loads fails as `target-unavailable`; its profile is deleted either way. An admission whose embedder gives such a vector is refused before its record is stored. Recall stays on the previous profile. `memory.embedding.status()` reports the active embedder and dimension and, while a switch runs or after one failed or was cancelled, its `target`, `state`, `done`, `total`, and `error`. Starting a switch deletes every profile that is neither active nor the one the last completed switch replaced, such as a target a crash left behind. Completing a switch deletes the profile two switches back. Deleting a profile removes its marker and stores a deletion checkpoint in one write, then removes its vectors, then the checkpoint. A deletion that stops part-way leaves the checkpoint: a forget still removes the record's vectors from that profile, and the next `advance()` finishes the deletion.

Memory advances a switch only when asked to: `memory.embedding.advance()` embeds up to 500 records per call. A Bureau that composes the memory does this on its maintenance pass, and owns the live setting `memory.embedder`. Writing it starts the switch. The write is refused while the embedder is not loaded or needs setup, or while a switch runs. A switch that fails or is cancelled sets the setting back to the embedder memory still uses, on the next maintenance pass.

## Running it in a deployment

Governed memory does not run in the background. The host that owns it is responsible for:

- Choosing record storage that implements `deleteMany()`, which construction checks, and `getByDedupeKey()` and `putOnce()`, which it does not. Without either of the last two, a `dedupeKey` is ignored without an error and every keyed write is stored, a replayed Bureau step's included. Without `putOnce()`, two concurrent writes with the same key can both be stored. Both bundled backends implement all three.
- Configuring `propagation` for every bounded-async target the deployment keeps copies in, and declaring `'not-retained'` only for targets it truly does not. A configured propagator or declaration replaces that target's built-in handler.
- Calling `processDeletionPropagation()` on a schedule shorter than the deletion bound, and once after every restart. A Bureau that composes the memory does this on its maintenance pass; a host that uses governed memory without a Bureau does it itself.
- Calling `memory.embedding.advance()` on a schedule, whether or not a switch of the embedder runs, since each call also finishes a profile deletion that stopped part-way. A Bureau that composes the memory does this on its maintenance pass.
- Calling `sweepRetention()` on a schedule under a service authority, and `expireWorkingMemory()` when each run that wrote working memory ends. A Bureau that composes the memory runs the sweep on its maintenance pass, as it does propagation; a host that uses governed memory without a Bureau does it itself, and a Bureau host still owns `expireWorkingMemory()`.
- Recording the activated policy revision in its own configuration, since activation is not reloaded after a restart.
- Routing `onEvent` notifications, or reading `listEvents()`, wherever its audit needs them, through a sink that never throws. `onEvent` is awaited inside every governed call that records an event, after the ledger append, so a throw or rejection escapes the call even though its change and its ledger event are already stored. A write is stored, so retrying it without a `dedupeKey`, or on storage that cannot honor one, stores it twice. A deletion's receipt is persisted, but its lanes wait for the next `processDeletionPropagation()`. Under Bureau, the run fails. Catch and buffer in the sink whatever it cannot deliver.
- Acting on deletions that did not remove their record. A result of `unchanged` with `deletion: 'failed'`, or a receipt whose synchronous rows are `failed`, means the record is still stored. Propagation passes retry a failed synchronous lane only while its receipt is open. Once the bound passes, the receipt closes, and only a new request to delete the same record reruns it. A `failed` bounded-async row in a deletion whose record was removed is never retried, so watch receipts for those too.

## What deletion cannot guarantee

A `completed` row means the step the package controls finished, or a propagator said so. It is not proof of erasure everywhere a copy might exist.

- **External processors.** A vendor that offers no deletion evidence reports `unknown`, and nothing in the package can do better. Proving deletion from such a provider was out of scope for COR-41.
- **Propagator claims.** A propagator's `completed` is recorded as given, and `'not-retained'` is a declaration the package takes on trust. Neither is verified.
- **Targets without a handler.** Managed-asset bytes, durable snapshots, and external processors have no built-in handler. Without a propagator or declaration, their rows fail at the deadline rather than claim completion.
- **Text a run already read.** Under Bureau, recalled text is appended to the run's conversation and persisted with it, so deleting a memory does not remove the copy a chat saved. The Interborough host declares `not-retained` only for the caches, managed-asset bytes, and external processors it keeps nothing in, and leaves `durable-snapshots` undeclared, so that row reports `pending` and then `failed` at its deadline instead of claiming a scrub nothing performed. Scrubbing conversations is out of scope.
- **Success names one record.** `applied`, `deletion: 'completed'`, and `memory_forget`'s `deleted: true` mean the named record was removed. Bounded-async rows can still be `pending`. After a source deletion, a summary its lineage reaches stays readable and recallable until the `summaries` row completes, and a hold on that summary found first leaves it stored until release. A projection deletion removes only its own record, so records derived from it stay stored, readable, and recallable until a deletion of their source reaches them.
- **A failed synchronous lane leaves the record in place.** When the storage transaction fails, or the records keep changing through three attempts, the synchronous rows are `failed`, and the source record, its vector, and every record in the synchronous plan stay stored, readable, and recallable. Every bounded-async row waits rather than claim completion, so no index, cache, or export manifest is reported clean, and each fails at its deadline unless a retry commits first. Propagation passes retry the transaction only while the receipt is open. Once the bound has passed and a pass has closed the receipt, nothing retries it until someone requests the same deletion again, which reruns that receipt with fresh deadlines.
- **Some failed rows are final.** A `failed` bounded-async row is never retried once the deletion's own record is gone. A source deletion's `summaries` row that fails at its deadline leaves its summary records stored, readable, and recallable, and the rows that waited on it fail with it. The source is gone, so asking to delete it again finds nothing. The host must detect these receipts itself.
- **A claim does not hide the record.** A deletion's claim stops promotion, derived writes, and exports from reaching a record. `get`, `list`, `search`, and `recallForModel` still return it until the synchronous lane removes it, including after that lane failed until a retry commits, and, for a held record, until the hold is released and the re-queued deletion removes it.
- **Caches the package cannot reach.** The built-in `caches` handler evicts only from an embedder with `evictContent()`, such as `withEmbeddingCache()`. Provider-side caches, HTTP caches, and anything else need a propagator.
- **Copies already handed out.** The `exports` handler scrubs the ledger's export manifests, and `export-revocation` marks a manifest revoked. Neither reaches records an export already delivered, or content a model already read into a transcript, a checkpoint, or a log outside the governed store.
- **Physical media.** `completed` for source evidence means the storage transaction removed the records from the backend's view. How a backend reclaims the bytes (SQLite free pages, write-ahead logs, backups of the underlying `Storage`) is outside the receipt.
- **Held and retained records.** A record under legal hold is `exempt` and stays until release. A hold keeps only the record it is on, and exempts any source deletion that reaches that record. It does not stop a projection deletion of a record derived from the held one, or of the projection the held record was derived from. Audit events and receipts stay for at least one year.
- **Digests stay behind.** Receipts, events, and diagnostics keep SHA-256 content digests, never content. A digest of short, guessable content, such as a phone number, can be confirmed by anyone who guesses the content.
- **Ungoverned surfaces.** Records written through `createMemory()` or the other ungoverned helpers have no receipts and are invisible to governed memory, even in the same storage.
- **Rollback.** Rolling back a policy or releasing a hold changes future decisions only. Nothing revoked or deleted comes back without a new, authorized write.

## Measuring memory architectures

Governance says what memory may do. The memory-lifecycle suite in `@lostgradient/evaluation` (COR-755) asks whether a memory architecture makes an agent's final action better, compared with simpler options under the same budget. The versioned command is:

```bash
bun run --cwd testing/evaluation memory-lifecycle run --lane deterministic
```

It runs the committed suite, `memory-lifecycle` version `memory-lifecycle-2026-09`: fourteen scenarios covering writing, state maintenance, retrieval, downstream use, governance, and final action, under temporal change, contradiction, long delays, procedural reuse, multimodal evidence, recovery, deletion, privacy, and poisoning. Every scenario runs against four baselines under one compute envelope:

| Baseline | What it is |
| --- | --- |
| `no-memory` | Retains nothing. |
| `raw-log-search` | Authorized raw-log search: BM25 over the owner's own durable log. |
| `flat-hybrid` | The current `createMemory()` flat hybrid store. |
| `lifecycle` | The proposed lifecycle architecture: governed memory plus a state projector, procedure memory, and resource derivation. |

The report gives each baseline's evidence admission precision and recall, stale-state rate, transition faithfulness, retrieval sufficiency, context cost, latency, downstream task success, tool and environment correctness, privacy and authorization violations, poison exposures, deletion completion and receipts, unsupported operations, and unknown outcomes. The command exits with the release gate's codes. The committed gate, `gates/memory-lifecycle.json`, blocks any regression in authorization, deletion, poisoning, state maintenance, or the cost ceiling, and requires a predeclared improvement in action success over the best simpler baseline. Every trial writes an artifact that `memory-lifecycle replay` reproduces without a model.

The offline lanes run a fixed reference policy, not a live model, and the suite's deployment keeps no bounded-async copies, so its lifecycle receipts settle at once. No external benchmark score is a threshold. The evaluation README's [Memory lifecycle evaluation](../testing/evaluation/README.md#memory-lifecycle-evaluation) section documents every subcommand, metric, exit code, and limit.

## Source map

The contracts in this guide are defined in:

- `packages/memory/src/governance/authority.ts`: authorities, capabilities, attenuation, and chain privilege.
- `packages/memory/src/governance/predicate.ts`: the one access predicate and redaction decision.
- `packages/memory/src/governance/governed-writes.ts` and `governed-reads.ts`: admission, recall admission, reads, and exports.
- `packages/memory/src/governance/governed-transitions.ts` and `governed-forgetting.ts`: promotion, sharing, quarantine, revocation, legal hold, and the ten forgetting modes.
- `packages/memory/src/governance/deletion.ts` and `ledger-types.ts`: deletion plans, lanes, propagation, and receipts.
- `packages/memory/src/governance/policy.ts`, `retention.ts`, and `governed-administration.ts`: policy defaults, retention, sweeps, and policy revisions.
- `packages/memory/src/memory-vector-store.ts` and `governance/embedding-switch.ts`: embedding profiles, the switch record, and the switch itself.
- `packages/bureau/src/runtime-composition.ts`: `createRunMemoryAuthority()` and Bureau's recall and persistence hooks.
- `packages/bureau/src/memory-embedder-setting.ts`: the `memory.embedder` setting and the maintenance pass that advances a switch.
- `testing/evaluation/src/memory-lifecycle/` and `testing/evaluation/scripts/memory-lifecycle.ts`: the lifecycle suite and its command.
