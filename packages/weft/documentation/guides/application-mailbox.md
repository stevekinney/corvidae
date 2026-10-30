# Application Mailbox

A `Mailbox` is a storage-backed, strictly FIFO command queue scoped to one opaque `(namespace, resourceId)` pair. Admission returns a durable receipt that survives a process restart, delivery is attempt-fenced so two consumers can never both hold a valid claim on the same command, cancellation is durable before it reaches anyone, and every state transition commits atomically with its fleet event when an event sink is configured.

> [!NOTE] `Mailbox` is not a message broker. There are no topics, no consumer groups, no cross-mailbox ordering, and no cross-region replication. Ordering is defined within one mailbox and nowhere else.

## What the mailbox is

Each `Mailbox` instance owns one `(namespace, resourceId)` pair and one FIFO sequence of commands admitted into it. Weft never interprets `namespace` or `resourceId`—they are opaque strings the caller chooses to partition work, for example one mailbox per agent or per workflow run.

```typescript
import { Mailbox } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/storage';

await using storage = new MemoryStorage();
using mailbox = new Mailbox({ storage, namespace: 'bureau', resourceId: 'agent-7' });

const admission = await mailbox.admit({
  caller: 'user:42',
  target: 'agent:7',
  kind: 'steer',
  payload: { form: 'inline', value: { text: 'stop' } },
  idempotencyKey: 'steer-1',
});
console.log(admission.status); // 'admitted'

const claimed = await mailbox.claim();
console.log(claimed.status); // 'claimed'
```

The backing `storage` must report `conditionalBatch` support, `snapshot` scan consistency, and `linearizable` read-after-write. `Mailbox`'s constructor throws an `ApplicationCommandValidationError` immediately if any of those are missing, because strict FIFO delivery depends on all three: every transition is a compare-and-swap, a claim reads the lowest-sequence entry in the delivery index off a consistent snapshot, and every consumer must see every durable admission as soon as it lands.

## Admission

`mailbox.admit(command)` offers a command for delivery and returns an `ApplicationCommandAdmission`:

- `admitted`: a new command was persisted; the result carries its receipt.
- `duplicate`: an exact retry of the same `idempotencyKey` bound to the same `(caller, target, kind, payloadDigest)`; the original receipt is returned and no second command is created.
- `conflict`: the `idempotencyKey` is already bound to a different `(caller, target, kind, payloadDigest)`; the original command is untouched.
- `rejected`: the backlog is at `maxBacklog` (reason `backlog-full`), or the mailbox was purged and takes no further commands (reason `purged`); nothing was persisted.

`idempotencyKey` is the caller's only retry handle. `commandId` is minted by the mailbox, not supplied by the caller.

## Claim

`mailbox.claim()` leases the FIFO head to one attempt and returns a `MailboxClaimResult`:

- `claimed`: the caller now holds an `ApplicationCommandClaim` carrying the receipt, a digest-verified payload, an `attemptToken`, and an attempt-scoped `AbortSignal`.
- `empty`: nothing is waiting.
- `held`: the FIFO head exists but is not due yet (`availableAt` in the future); the caller gets an `availableAt` to wait on.

The `attemptToken` is the fencing credential every later mutation on this attempt must present. It is deliberately absent from `ApplicationCommandReceipt`, because a receipt is readable by any observer and publishing the token there would let a bystander settle work it never claimed.

## Renew

`mailbox.renew({ commandId, attemptToken, progress })` extends a lease's `visibilityExpiresAt` and reports liveness. It returns an `ApplicationCommandRenewalResult`:

- `renewed`: carries the new `visibilityExpiresAt` and a `cancellationRequested` flag. That flag is the cross-process cancellation channel: a claimant in another process never sees the attempt-scoped `AbortSignal`, so `renew()` is where it learns cancellation was requested.
- `stale`: the caller no longer holds the current attempt on this command.
- `deadline-exceeded`: the command's absolute deadline has passed; no attempt may extend or settle it.
- `unknown`: the command no longer exists.

Renewal emits no fleet event. It is liveness evidence, not a state transition: the record's disposition is unchanged, so publishing an event per heartbeat would flood the feed without telling a consumer anything a receipt read does not already say.

## Settle

`mailbox.acknowledge({ commandId, attemptToken, outcome })` settles a claimed command successfully. `mailbox.reject({ commandId, attemptToken, failure, retry })` settles it as failed, optionally scheduling a retry at the command's original FIFO position. Both return an `ApplicationCommandSettleResult` with `settled`, `retrying`, `stale`, `deadline-exceeded`, or `unknown`.

`stale` and `deadline-exceeded` are reported separately on purpose: `stale` means another attempt owns the command and this one should stop, while `deadline-exceeded` means the command itself is over and no attempt will ever settle it—maintenance dead-letters the record.

## Maintenance

`mailbox.runMaintenance(now?)` is the only thing that advances time-driven work: releasing a delayed command whose `availableAt` passed, reclaiming an expired lease at its original FIFO position, dead-lettering a command past its absolute deadline, and retiring terminal receipts past `terminalRetentionMs`. Nothing in the mailbox runs on a hidden timer—a host configured with `backgroundTasks: 'manual'` drives every time-based transition through this one call and should await each cycle before starting another.

Each pass is bounded: it walks the command keyspace in pages of `maintenanceBatchSize`, up to a fixed number of pages per call, and carries its cursor forward to the next call when the cap cuts it short. It returns a `MailboxMaintenanceReport` with `released`, `reclaimed`, `deadLettered`, `cancelled`, and `retired` counts.

```typescript
import type { Mailbox } from '@lostgradient/weft';

declare const mailbox: Mailbox;

const report = await mailbox.runMaintenance();
console.log(report.reclaimed); // expired leases returned to the delivery index
```

## Purge

`mailbox.purge()` permanently deletes every command record (payloads included), receipt and index of the mailbox, for a host that has retired the resource and must forget what was sent to it rather than wait for terminal retention. It does not cancel work: a command a consumer has claimed is deleted under it, so call it only once the resource has no consumer. The header stays, sealed with `purgedAt`: every later `admit()` is refused as `rejected` with reason `purged`, and an admission that raced the purge, having read the header the seal replaced, loses its compare-and-swap and is refused the same way, so nothing can recreate the mailbox behind the purge. It is safe to repeat: a second call finishes what a failed one stopped and answers `0` when nothing is left.

```typescript
import type { Mailbox } from '@lostgradient/weft';

declare const mailbox: Mailbox;

const deleted = await mailbox.purge();
const refused = await mailbox.admit({
  caller: 'alice',
  target: 'chat-1',
  kind: 'steer',
  payload: { form: 'inline', value: {} },
});
console.log(deleted, refused.status); // <keys deleted> "rejected"
```

## The ordering contract

Delivery is strictly FIFO among ready commands: `claim()` only ever considers the lowest-sequence entry in the delivery index. When that head is not due yet, `claim()` reports `held` rather than skipping ahead to a later command—head-of-line blocking is real and intended, so a command sitting in retry backoff holds its resource's queue until it is due or dead-lettered.

Strict FIFO governs when a command becomes claimable, not when it finishes. A later command may be claimed and worked while an earlier one is still in flight, because each command is leased to its own attempt independently once it is the head at the moment of claim. Completion order belongs to consumers, not to the mailbox.

### Permitted races

A later command may be claimed while an earlier one is in flight, and a claim does not fence against a recovery reinsertion at the FIFO head. Sequence 0 is leased—it is absent from the ready delivery index while its attempt runs. A consumer observes sequence 1 as the current head and begins claiming it. Concurrently, maintenance reclaims sequence 0's expired lease (its `visibilityExpiresAt` passed) via `recoverExpiredCommand` and reinserts it at its original FIFO position—the same sequence number it always had. The consumer's compare-and-swap on sequence 1 succeeds. The outcome: sequence 1 is worked while sequence 0 sits at the head again, and sequence 0 is delivered to whoever claims next.

This is permitted, not a bug. It is observably identical to a simpler case a caller already has to accept: sequence 0's lease expiring one millisecond after the sequence-1 claim commits, rather than one millisecond before the sequence-1 claim was requested. Nothing distinguishes the two sequences of events from a consumer's perspective—in both, sequence 1 gets claimed while sequence 0 is (or becomes) the reclaimed head. A claim is a compare-and-swap against the head it observed, not a lock against every command that might later reappear at a lower sequence.

The absolute deadline is rechecked after commit; the visibility window is not. Two bounds apply to a lease, and they are enforced differently by design.

The absolute deadline (`absoluteDeadlineAt`) is the hard bound. It is rechecked after a claim or a renewal commits, because both `leaseHead` (in `mailbox-delivery.ts`) and `renewClaim` (in `mailbox-settlement.ts`) perform an asynchronous commit—a fleet-event sink may retry its own compare-and-swap—so a lease can land durably after the deadline it was checked against just before the commit. `leaseHead` re-reads the clock immediately after the commit and, if `runtime.now() >= transition.next.absoluteDeadlineAt`, dead-letters the just-committed lease via `deadLetterCommittedLease` and returns `null` so the caller looks at the head again instead of receiving expired work. `renewClaim` performs the same recheck and returns `deadline-exceeded` instead of `renewed` when it trips. A lease that lands past the absolute deadline is dead-lettered and withheld from the caller in both paths—the caller never sees it.

The visibility window (`visibilityExpiresAt`) is a soft, renewable bound, and it is not rechecked after commit. A `claimed` result's `visibilityExpiresAt` can already be short, or already elapsed, by the time the caller reads it—under slow storage or a slow event sink, the interval between the clock read that computed the lease and the commit landing can itself exceed the visibility timeout. Weft does not withhold or re-verify the claim against this second reading. The way a claimant with a stale-on-arrival visibility window discovers that maintenance already reclaimed its lease is by calling `renew()` and receiving `stale` back instead of `renewed`.

Withholding a claim whose visibility window is already tight was considered and rejected. It would fail claims outright under slow storage or slow event sinks without changing anything durable—the record would already be committed as `claimed`, so refusing to hand the claim to its caller would not free the command for anyone else, and the caller would simply retry `claim()` and, in the same slow environment, risk hitting the same tight window again. The renewable bound already gives the claimant (and the mailbox, on the next `renew()` or maintenance pass) a way to detect and correct for the delay; a second gate on top of it buys nothing durable and only adds failure surface to a slow but otherwise healthy claim.
