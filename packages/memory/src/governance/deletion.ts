import type { Embedder } from 'armorer';

import {
  type MemoryRecordReference,
  MemoryRecordVersionConflictError,
} from '../memory-record-storage';
import type { GovernanceContext, ResolvedRecord } from './governance-context';
import type {
  MemoryDeletionPropagationResult,
  MemoryDeletionPropagator,
} from './governed-memory-types';
import type { StoredMemoryDeletionReceipt } from './ledger';
import {
  ASYNCHRONOUS_DELETION_TARGETS,
  type AsynchronousDeletionTarget,
  type MemoryDeletionPlan,
  type MemoryDeletionReceipt,
  type MemoryDeletionTarget,
  type MemoryDeletionTargetReceipt,
  type MemoryDeletionTargetStatus,
  type MemoryLineageLink,
  SYNCHRONOUS_DELETION_TARGETS,
  type SynchronousDeletionTarget,
} from './ledger-types';
import { resolveTenantPolicy } from './policy';
import type {
  DerivedRecordKind,
  MemoryAttribution,
  MemoryDeletionClaim,
  MemoryRecordSourceReference,
} from './record-governance';

export interface DeletionRequest {
  readonly attribution: MemoryAttribution;
  readonly resolved: ResolvedRecord;
  readonly trigger: MemoryDeletionReceipt['trigger'];
  readonly scope: MemoryDeletionReceipt['scope'];
}

/**
 * Executes COR-806's deletion plan. Before planning, the deletion claims the
 * record and, for a source deletion, everything its lineage reaches (each
 * envelope's `deletionRequestedAt`), reading the lineage again after each round
 * of claims until a read finds nothing new, so the plan also reaches whatever a
 * promotion or derived write running alongside published. A projection
 * deletion's plan is its own record alone. A receipt is persisted before
 * anything is deleted; the synchronous lane then removes source evidence, canonical
 * projections, identity views, and the managed-asset canonical record in one
 * storage transaction; and each bounded-async target settles against its own
 * deadline. Every step is idempotent, so {@link DeletionEngine.processOpen}
 * resumes an interrupted deletion after a restart.
 *
 * A legal hold on the record or on anything its plan reaches holds the
 * deletion. It is checked again before the synchronous lane and before each
 * bounded-async target, and every record deletion is conditioned on the
 * versions that check read, so a hold placed on one of those records at any
 * point while the deletion is in flight leaves the held record, and every
 * target not yet settled, alone until the hold is released. A projection
 * deletion never sees a hold on its source or on a record derived from it.
 *
 * No row reports a target clean while a record the deletion names is still
 * stored: until every row that removes records (the named record's own row
 * and, for a source deletion, the `summaries` row) completes, the other rows
 * wait (and fail at their deadline). A failed synchronous lane is retried by
 * every pass over its open receipt and by a new request to delete the same
 * record, which reruns the failed receipt instead of opening another. Every
 * change to a stored receipt is a conditional write on the receipt as its
 * writer read it, so of several processes acting on one receipt only the
 * first to write moves it on, and the others decide again from what is stored.
 */
/**
 * What a deletion request did. Several processes sharing one store can request
 * the same deletion at once, as concurrent retention sweeps do, and only one
 * of them opens a receipt.
 *
 * - `requested`: this request opened the receipt (or re-ran a failed one) and
 *   ran it.
 * - `owned`: another deletion's receipt owns the record, open or waiting on a
 *   legal hold; this request opened nothing.
 * - `pending`: another deletion holds a live claim on the record and has not
 *   opened its receipt yet, or took this request's claim over before it
 *   opened one, or the record is gone; this request opened nothing, and there
 *   is no receipt to report yet.
 */
export type DeletionRequestOutcome =
  | { readonly status: 'requested'; readonly receipt: MemoryDeletionReceipt }
  | Decided<{ readonly status: 'owned'; readonly receipt: MemoryDeletionReceipt }>
  | Decided<{ readonly status: 'pending' }>;

/**
 * Marks an outcome that `decideClaim` reached from what it just read. Telling
 * a requester that another deletion owns the record, that there is nothing to
 * do yet, or that a failed receipt should be retried is a decision, and each
 * such decision made from a stale read has opened a second receipt or left a
 * record stored. The brand exists only in the type system and only
 * `decideClaim` asserts it, so an object literal cannot stand in for one.
 */
declare const decidedByClaim: unique symbol;
type Decided<T> = T & { readonly [decidedByClaim]: true };

/**
 * What a claim attempt decided: the claim this request now holds, or a
 * decision that stops it, including a failed receipt to retry.
 */
type ClaimDecision =
  | MemoryDeletionClaim
  | Exclude<DeletionRequestOutcome, { readonly status: 'requested' }>
  | Decided<{ readonly status: 'retry'; readonly stored: StoredMemoryDeletionReceipt }>;

/** What a claim attempt observed of the record before deciding. */
type ClaimObservation =
  | {
      readonly kind: 'observed';
      readonly claim: MemoryDeletionClaim | undefined;
      readonly stored: StoredMemoryDeletionReceipt | undefined;
    }
  | { readonly kind: 'record-gone' }
  | { readonly kind: 'contended' };

export interface DeletionEngine {
  /** Claims the record and, under a winning, unexpired claim, opens and runs its deletion. */
  requestDeletion(request: DeletionRequest): Promise<DeletionRequestOutcome>;
  requeueAfterRelease(receipt: MemoryDeletionReceipt): Promise<MemoryDeletionReceipt | undefined>;
  /**
   * Resumes every open deletion, and re-queues any held deletion whose hold was
   * released without its re-queue being recorded.
   */
  processOpen(): Promise<MemoryDeletionReceipt[]>;
}

const SYNCHRONOUS: ReadonlySet<MemoryDeletionTarget> = new Set(SYNCHRONOUS_DELETION_TARGETS);

const TARGET_FOR_KIND: Readonly<Record<DerivedRecordKind, MemoryDeletionTarget>> = {
  'canonical-projection': 'canonical-projections',
  'identity-view': 'identity-views',
  'managed-asset-record': 'managed-asset-record',
  summary: 'summaries',
};

const PROJECTION_TARGETS: readonly MemoryDeletionTarget[] = ['indexes', 'caches', 'exports'];

/**
 * The targets whose rows remove stored records: the source and each kind of
 * derived record. Until every such row in a receipt completes, some record the
 * deletion names is still stored, readable, and recallable, so no other row
 * can be clean of it.
 */
const RECORD_TARGETS: ReadonlySet<MemoryDeletionTarget> = new Set([
  'source-evidence',
  ...Object.values(TARGET_FOR_KIND),
]);

/**
 * How many times the synchronous lane re-checks holds and retries its storage
 * transaction after a record it names changed underneath it. Past this, the
 * lane fails and the next propagation pass tries again.
 */
const SYNCHRONOUS_DELETION_ATTEMPTS = 3;

/**
 * How long a deletion's claim on its record lets it open the receipt. The
 * claim-to-receipt path reads lineage, stamps what it reaches, and inspects
 * holds, which takes milliseconds to seconds; a claimant that dies on it
 * leaves the record unclaimable for this long, after which another claimant
 * takes the claim over. A lease that runs out under a claimant that is merely
 * slow is safe, because both build their receipt under the same `deletionId`
 * and only one can create it.
 */
export const DELETION_CLAIM_LEASE_MILLISECONDS = 60_000;

/**
 * How many times a claim re-reads the record after another claimant changed
 * its claim between this one reading it and writing it. Past this, it yields
 * to the others.
 */
const DELETION_CLAIM_ATTEMPTS = 8;

/** What a deletion saw of the records it names, just before it acts on them. */
interface Inspection {
  /** Whether any record that still exists is under legal hold. */
  readonly held: boolean;
  readonly contentDigests: readonly string[];
  /** The version of each record that still exists, keyed by {@link referenceKey}. */
  readonly versions: ReadonlyMap<string, number>;
}

/**
 * An embedder whose cache can evict entries by the SHA-256 digest of the content
 * they embedded, such as `withEmbeddingCache()`. Only such an embedder lets
 * the built-in `caches` handler claim eviction; any other cache needs a
 * configured propagator or a `not-retained` declaration.
 */
type ContentEvictingEmbedder = Embedder & {
  evictContent(contentDigests: readonly string[]): number | Promise<number>;
};

function evictsContent(embedder: Embedder): embedder is ContentEvictingEmbedder {
  return 'evictContent' in embedder && typeof embedder.evictContent === 'function';
}

/** Every registered embedder that caches content, so a deletion evicts it from each. */
function cachingEmbedders(context: GovernanceContext): ContentEvictingEmbedder[] {
  const { registry } = context.embedding;
  return registry.ids.map((id) => registry.resolve(id)).filter(evictsContent);
}

function emptyPlan(): MemoryDeletionPlan {
  return { projections: [], identityViews: [], managedAssetRecords: [], summaries: [] };
}

function planFromLinks(links: readonly MemoryLineageLink[]): MemoryDeletionPlan {
  const pick = (kind: DerivedRecordKind) =>
    links
      .filter((link) => link.derived.kind === kind)
      .map((link) => ({ id: link.derived.id, namespace: link.derived.namespace }));
  return {
    projections: pick('canonical-projection'),
    identityViews: pick('identity-view'),
    managedAssetRecords: pick('managed-asset-record'),
    summaries: pick('summary'),
  };
}

function planForProjection(
  kind: DerivedRecordKind,
  reference: MemoryRecordSourceReference,
): MemoryDeletionPlan {
  const plan = emptyPlan();
  if (kind === 'canonical-projection') return { ...plan, projections: [reference] };
  if (kind === 'identity-view') return { ...plan, identityViews: [reference] };
  if (kind === 'managed-asset-record') return { ...plan, managedAssetRecords: [reference] };
  return { ...plan, summaries: [reference] };
}

export function planReferences(plan: MemoryDeletionPlan): MemoryRecordSourceReference[] {
  return [
    ...plan.projections,
    ...plan.identityViews,
    ...plan.managedAssetRecords,
    ...plan.summaries,
  ];
}

/**
 * The status of the row that removes the record a deletion names, which is
 * always a receipt's first row: `source-evidence` for a source deletion, and
 * the derived record's own target for a projection deletion. It is what the
 * deletion did to that record's content, whatever the other rows say.
 */
export function deletionOutcome(receipt: MemoryDeletionReceipt): MemoryDeletionTargetStatus {
  return receipt.targets[0]!.status;
}

/**
 * Whether `row` must wait: while any other row that removes records has not
 * completed, a record the deletion names is still stored. So a source
 * deletion's `summaries` row waits for its synchronous lane, and every row
 * that removes no records waits for all of them.
 */
function awaitsRecordRemoval(
  receipt: MemoryDeletionReceipt,
  row: MemoryDeletionTargetReceipt,
): boolean {
  return receipt.targets.some(
    (other) =>
      other.target !== row.target &&
      RECORD_TARGETS.has(other.target) &&
      other.status !== 'completed',
  );
}

/** A pending row whose deadline has passed fails, per COR-806; any other row is returned as is. */
function overdue(target: MemoryDeletionTargetReceipt, now: number): MemoryDeletionTargetReceipt {
  if (target.deadline === undefined || now < target.deadline) return target;
  return {
    ...target,
    status: 'failed',
    settledAt: now,
    detail: 'deadline passed before propagation completed',
  };
}

function referenceKey(reference: MemoryRecordSourceReference): string {
  return JSON.stringify([reference.namespace, reference.id]);
}

function sourceOf(receipt: MemoryDeletionReceipt): MemoryRecordSourceReference {
  return { id: receipt.record.id, namespace: receipt.record.namespace };
}

/** The deleted record and everything its plan reaches: the records a hold on any of which holds the deletion. */
function receiptReferences(receipt: MemoryDeletionReceipt): MemoryRecordSourceReference[] {
  return [sourceOf(receipt), ...planReferences(receipt.plan)];
}

/**
 * Storage references for a deletion, each conditioned on the version the
 * inspection read, so a record changed since then (a hold placed on it, say)
 * aborts the transaction instead of being deleted.
 */
function conditionedReferences(
  tenantId: string,
  references: readonly MemoryRecordSourceReference[],
  inspection: Inspection,
): MemoryRecordReference[] {
  return references.map((reference) => {
    const expectedVersion = inspection.versions.get(referenceKey(reference));
    return {
      id: reference.id,
      scope: { tenantId, namespace: reference.namespace },
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    };
  });
}

function presentCount(
  references: readonly MemoryRecordSourceReference[],
  inspection: Inspection,
): number {
  return references.filter((reference) => inspection.versions.has(referenceKey(reference))).length;
}

function targetRow(
  target: MemoryDeletionTarget,
  held: boolean,
  requestedAt: number,
  bound: number,
): MemoryDeletionTargetReceipt {
  const lane = SYNCHRONOUS.has(target) ? 'synchronous' : 'bounded-async';
  if (held) return { target, lane, status: 'exempt', detail: 'legal hold' };
  return {
    target,
    lane,
    status: 'pending',
    deadline: lane === 'synchronous' ? requestedAt : requestedAt + bound,
  };
}

function withOpen(receipt: MemoryDeletionReceipt, updatedAt: number): MemoryDeletionReceipt {
  return {
    ...receipt,
    open: receipt.targets.some((target) => target.status === 'pending'),
    updatedAt,
  };
}

/**
 * A hold found mid-deletion: every target not yet settled becomes exempt, and
 * the receipt closes waiting on the release, which re-queues what is left.
 * Targets that already settled keep their outcome.
 */
function holdRemaining(receipt: MemoryDeletionReceipt, now: number): MemoryDeletionReceipt {
  const targets = receipt.targets.map((target): MemoryDeletionTargetReceipt =>
    target.status === 'pending'
      ? {
          target: target.target,
          lane: target.lane,
          status: 'exempt',
          settledAt: now,
          detail: 'legal hold',
        }
      : target,
  );
  return withOpen({ ...receipt, targets, awaitingHoldRelease: true }, now);
}

export function createDeletionEngine(context: GovernanceContext): DeletionEngine {
  async function lineageClosure(
    tenantId: string,
    root: MemoryRecordSourceReference,
  ): Promise<MemoryLineageLink[]> {
    const links: MemoryLineageLink[] = [];
    const seen = new Set([JSON.stringify([root.namespace, root.id])]);
    const queue = [root];
    for (let reference = queue.shift(); reference !== undefined; reference = queue.shift()) {
      for (const link of await context.ledger.listLineage(tenantId, reference)) {
        const key = JSON.stringify([link.derived.namespace, link.derived.id]);
        if (seen.has(key)) continue;
        seen.add(key);
        links.push(link);
        queue.push(link.derived);
      }
    }
    return links;
  }

  /**
   * Stamps a record a deletion's plan reaches, so nothing new can be derived
   * from it; a record already gone needs no stamp. The record the deletion
   * names is claimed through {@link claimRecord} instead.
   */
  async function stamp(resolved: ResolvedRecord): Promise<void> {
    await context.updateGovernance(resolved, (governance) =>
      governance.deletionRequestedAt === undefined
        ? { deletionRequestedAt: context.now() }
        : undefined,
    );
  }

  /**
   * Whether `receipt` is a deletion of the requested scope whose row removing
   * the record failed, leaving it stored. A held deletion is not one: its
   * release re-queues it.
   */
  function retriable(receipt: MemoryDeletionReceipt, request: DeletionRequest): boolean {
    return (
      receipt.scope === request.scope &&
      !receipt.awaitingHoldRelease &&
      deletionOutcome(receipt) === 'failed'
    );
  }

  /**
   * Whether `receipt` still owns its record's deletion: it is open, or it
   * waits on a legal hold whose release (and only that) re-queues it.
   */
  function owns(receipt: MemoryDeletionReceipt, request: DeletionRequest): boolean {
    return receipt.open || (receipt.awaitingHoldRelease && request.trigger !== 'hold-release');
  }

  /**
   * The receipt that speaks for the record's deletion right now, read after
   * the record (and so its claim) was read: the receipt stored under the
   * claim's `deletionId`, or, for a record claimed before claims carried one,
   * the receipt for it that a request must defer to (one to retry first, then
   * one that owns it). It is the only receipt a claim decision may use; a
   * listing taken before the claim was read can be stale by the time the
   * decision is made. It comes with its stored revision, so a retry decided
   * from it moves the receipt on only if nobody else has since.
   */
  async function receiptForClaim(
    tenantId: string,
    reference: MemoryRecordSourceReference,
    request: DeletionRequest,
    claim: MemoryDeletionClaim | undefined,
  ): Promise<StoredMemoryDeletionReceipt | undefined> {
    if (claim !== undefined) return context.ledger.readReceipt(claim.deletionId);
    const receipts = await context.ledger.listReceipts({ tenantId });
    const legacy = receipts.filter(
      (receipt) =>
        receipt.record.id === reference.id && receipt.record.namespace === reference.namespace,
    );
    const found =
      legacy.find((receipt) => retriable(receipt, request)) ??
      legacy.find((receipt) => owns(receipt, request));
    return found === undefined ? undefined : context.ledger.readReceipt(found.deletionId);
  }

  /**
   * Decides a claim from what was just observed of the record: its current
   * claim and the receipt {@link receiptForClaim} read for it, and nothing
   * else. It is the only place that may tell a requester `owned`, `pending`,
   * or `retry` (see {@link Decided}). A record that is gone needs nothing
   * more, and a claim that kept changing under this request is left to the
   * claimants changing it. A failed
   * deletion is retried under its own receipt, whether it is still open or
   * already closed; an open receipt, or one waiting on a legal hold, owns the
   * record; any other stored receipt is spent, so a new deletion starts. With
   * no receipt, a claim is live until its lease expires and is then taken over
   * under the same `deletionId`. Every decision that opens a receipt is fenced
   * (the claim by the record's compare-and-swap, the receipt by its
   * create-only key, a retry by the conditional write on the receipt it read),
   * and one that defers can be stale only toward deferring, which the next
   * request corrects.
   */
  function decideClaim(
    request: DeletionRequest,
    observation: Exclude<ClaimObservation, { readonly kind: 'observed' }>,
  ): Decided<{ readonly status: 'pending' }>;
  function decideClaim(request: DeletionRequest, observation: ClaimObservation): ClaimDecision;
  function decideClaim(request: DeletionRequest, observation: ClaimObservation): ClaimDecision {
    const decided = <T>(value: T) => value as Decided<T>;
    if (observation.kind !== 'observed') return decided({ status: 'pending' as const });
    const { claim, stored } = observation;
    if (stored !== undefined) {
      const { receipt } = stored;
      if (retriable(receipt, request)) return decided({ status: 'retry' as const, stored });
      if (owns(receipt, request)) return decided({ status: 'owned' as const, receipt });
    } else if (claim !== undefined) {
      if (context.now() < claim.leaseExpiresAt) return decided({ status: 'pending' as const });
      return { deletionId: claim.deletionId, ...freshLease() };
    }
    return { deletionId: context.runtime.identifiers.next('memory-deletion'), ...freshLease() };
  }

  function freshLease(): Omit<MemoryDeletionClaim, 'deletionId'> {
    return {
      token: context.runtime.identifiers.next('memory-deletion-claim'),
      leaseExpiresAt: context.now() + DELETION_CLAIM_LEASE_MILLISECONDS,
    };
  }

  /**
   * Claims the record a deletion names, as a compare-and-swap on its version,
   * and reports whether this request won: the claim it wrote, or the outcome
   * when another deletion owns the record or the record is gone. Two
   * claimants that read the same claim cannot both replace it, because the
   * swap that lands second finds the record's version moved and re-reads it.
   */
  async function claimRecord(
    request: DeletionRequest,
    reference: MemoryRecordSourceReference,
  ): Promise<ClaimDecision> {
    const tenantId = request.resolved.scope.tenantId;
    for (let attempt = 0; attempt < DELETION_CLAIM_ATTEMPTS; attempt++) {
      const current = await context.load(tenantId, reference);
      if (current === undefined) return decideClaim(request, { kind: 'record-gone' });
      const observed = current.read.governance.deletionClaim;
      const claim = decideClaim(request, {
        kind: 'observed',
        claim: observed,
        stored: await receiptForClaim(tenantId, reference, request, observed),
      });
      if ('status' in claim) return claim;
      let changed = false;
      const stored = await context.updateGovernance(current, (governance) => {
        // Decided against the claim read above: if another claimant replaced
        // or renewed it since (a renewal keeps the token and moves the lease),
        // decide again against what is stored now.
        const latest = governance.deletionClaim;
        changed =
          latest?.token !== observed?.token ||
          latest?.leaseExpiresAt !== observed?.leaseExpiresAt ||
          latest?.deletionId !== observed?.deletionId;
        if (changed) return undefined;
        return {
          deletionRequestedAt: governance.deletionRequestedAt ?? context.now(),
          deletionClaim: claim,
        };
      });
      // A record gone, or a claim changed underneath: observe it again.
      if (stored && !changed) return claim;
    }
    return decideClaim(request, { kind: 'contended' });
  }

  /**
   * Whether `claim` still lets this request open its receipt: the record
   * still carries it, under this claimant's token, with a lease that has not
   * run out. A claimant whose lease ran out while nobody took the claim over
   * renews it, by the same compare-and-swap a takeover would make, so it opens
   * under an unexpired claim either way. This saves a claimant that lost its
   * claim the work of opening a receipt; the conditional write in
   * `ledger.openReceipt` is what keeps one that lost it after this check from
   * opening a second.
   */
  async function stillHolds(
    tenantId: string,
    reference: MemoryRecordSourceReference,
    claim: MemoryDeletionClaim,
  ): Promise<boolean> {
    const current = await context.load(tenantId, reference);
    if (current?.read.governance.deletionClaim?.token !== claim.token) return false;
    if (context.now() < current.read.governance.deletionClaim.leaseExpiresAt) return true;
    let held = false;
    const stored = await context.updateGovernance(current, (governance) => {
      held = governance.deletionClaim?.token === claim.token;
      if (!held) return undefined;
      return {
        deletionClaim: {
          ...claim,
          leaseExpiresAt: context.now() + DELETION_CLAIM_LEASE_MILLISECONDS,
        },
      };
    });
    return stored && held;
  }

  /**
   * Claims the deleted record, then everything its lineage reaches, and plans
   * from the lineage as it stands once a read after the latest claims finds
   * nothing new. A promotion or derived write re-checks its sources after
   * storing and linking its record: one that re-checks after a claim withdraws
   * its record, and one that re-checked before it had already written its
   * link, which the next read finds. A projection deletion removes one
   * derived record, so it claims only that one. The record itself is already
   * claimed by {@link claimRecord}; what its lineage reaches is stamped.
   */
  async function claimPlan(
    request: DeletionRequest,
    reference: MemoryRecordSourceReference,
  ): Promise<MemoryDeletionPlan> {
    const { resolved } = request;
    if (request.scope === 'projection') {
      return planForProjection(resolved.read.governance.lineage!.kind, reference);
    }
    const tenantId = resolved.scope.tenantId;
    const claimed = new Set<string>();
    for (;;) {
      const links = await lineageClosure(tenantId, reference);
      const unclaimed = links.filter((link) => !claimed.has(referenceKey(link.derived)));
      if (unclaimed.length === 0) return planFromLinks(links);
      for (const link of unclaimed) {
        claimed.add(referenceKey(link.derived));
        const derived = await context.load(tenantId, link.derived);
        if (derived !== undefined) await stamp(derived);
      }
    }
  }

  /** Reloads `references`: which still exist, at which version, and whether any is held. */
  async function inspectReferences(
    tenantId: string,
    references: readonly MemoryRecordSourceReference[],
  ): Promise<Inspection> {
    let held = false;
    const contentDigests: string[] = [];
    const versions = new Map<string, number>();
    for (const reference of references) {
      const resolved = await context.load(tenantId, reference);
      if (resolved === undefined) continue;
      held ||= resolved.read.governance.legalHold === 'held';
      contentDigests.push(resolved.read.governance.contentDigest);
      versions.set(referenceKey(reference), resolved.record.version);
    }
    return { held, contentDigests, versions };
  }

  /**
   * Moves a receipt from `current`, as this deletion read it, to `next`, and
   * records the step. Returns `undefined`, recording nothing, when another
   * writer moved the receipt on first: only the writer whose read is still
   * current may change it, so two processes acting on one receipt never
   * overwrite each other's progress or reopen a receipt that closed.
   */
  async function advance(
    current: StoredMemoryDeletionReceipt,
    next: MemoryDeletionReceipt,
    type: string,
    attribution: MemoryAttribution = next.requestedBy,
  ): Promise<StoredMemoryDeletionReceipt | undefined> {
    const stored = await context.ledger.replaceReceipt(current, next);
    if (stored === undefined) return undefined;
    await recorded(next, type, attribution);
    return stored;
  }

  /**
   * Opens a new receipt: stores it only if no receipt is stored under its
   * `deletionId` yet. Returns `undefined`, recording nothing, when one is.
   */
  async function open(
    receipt: MemoryDeletionReceipt,
    attribution: MemoryAttribution = receipt.requestedBy,
  ): Promise<StoredMemoryDeletionReceipt | undefined> {
    const stored = await context.ledger.openReceipt(receipt);
    if (stored === undefined) return undefined;
    await recorded(receipt, 'memory.deletion.requested', attribution);
    return stored;
  }

  async function recorded(
    receipt: MemoryDeletionReceipt,
    type: string,
    attribution: MemoryAttribution,
  ): Promise<MemoryDeletionReceipt> {
    await context.recordEvent({
      tenantId: receipt.tenantId,
      type,
      outcome: receipt.open ? 'pending' : 'settled',
      attribution,
      recordIds: [receipt.record.id],
      details: {
        deletionId: receipt.deletionId,
        trigger: receipt.trigger,
        ...Object.fromEntries(receipt.targets.map((target) => [target.target, target.status])),
      },
    });
    return receipt;
  }

  /** The synchronous lane's storage transaction, conditioned on what `inspection` read. */
  async function deleteSynchronous(
    receipt: MemoryDeletionReceipt,
    inspection: Inspection,
  ): Promise<'deleted' | 'failed' | 'conflict'> {
    const references = [
      ...(receipt.scope === 'source' ? [sourceOf(receipt)] : []),
      ...receipt.plan.projections,
      ...receipt.plan.identityViews,
      ...receipt.plan.managedAssetRecords,
    ];
    try {
      await context.deleteMany(conditionedReferences(receipt.tenantId, references, inspection));
      return 'deleted';
    } catch (error) {
      return error instanceof MemoryRecordVersionConflictError ? 'conflict' : 'failed';
    }
  }

  /**
   * Settles the synchronous rows: `completed` when the transaction removed
   * their records, or `failed` with `failure` as the detail when it did not.
   */
  async function settleSynchronous(
    receipt: MemoryDeletionReceipt,
    failure: string | undefined,
    inspection: Inspection,
  ): Promise<MemoryDeletionReceipt> {
    const succeeded = failure === undefined;
    const now = context.now();
    const { plan } = receipt;
    const details: Record<SynchronousDeletionTarget, string> = {
      'source-evidence': 'source evidence removed',
      'canonical-projections': `${presentCount(plan.projections, inspection)} canonical projection(s) removed`,
      'identity-views': `${presentCount(plan.identityViews, inspection)} identity view(s) removed`,
      'managed-asset-record': `${presentCount(plan.managedAssetRecords, inspection)} managed-asset canonical record(s) removed`,
    };
    const targets = receipt.targets.map((target): MemoryDeletionTargetReceipt => {
      if (target.lane !== 'synchronous' || target.status !== 'pending') return target;
      return succeeded
        ? {
            ...target,
            status: 'completed',
            settledAt: now,
            detail: details[target.target as SynchronousDeletionTarget],
          }
        : { ...target, status: 'failed', settledAt: now, detail: failure };
    });
    // A source deletion removes everything its lineage reaches, so those links
    // are spent. A projection deletion removes one derived record while records
    // derived from it survive: its links stay, so deleting its source later
    // still reaches them through it.
    if (succeeded && receipt.scope === 'source') {
      for (const reference of receiptReferences(receipt)) {
        await context.ledger.deleteLineage(receipt.tenantId, reference);
      }
    }
    return withOpen({ ...receipt, targets }, now);
  }

  async function executeSynchronous(
    receipt: MemoryDeletionReceipt,
  ): Promise<MemoryDeletionReceipt> {
    // A failed synchronous lane left its records stored, so it runs again:
    // its rows are pending once more until this attempt settles them.
    const retried: MemoryDeletionReceipt = {
      ...receipt,
      targets: receipt.targets.map((target): MemoryDeletionTargetReceipt => {
        if (target.lane !== 'synchronous' || target.status !== 'failed') return target;
        const { settledAt: _settledAt, detail: _detail, ...row } = target;
        return { ...row, status: 'pending' };
      }),
    };
    const pending = retried.targets.some(
      (target) => target.lane === 'synchronous' && target.status === 'pending',
    );
    if (!pending) return receipt;
    let inspection: Inspection | undefined;
    for (let attempt = 0; attempt < SYNCHRONOUS_DELETION_ATTEMPTS; attempt++) {
      // A hold placed after the deletion was requested (before a restart, say)
      // is honored here; one placed after this check changes the held record's
      // version, which aborts the conditioned transaction and brings us back.
      inspection = await inspectReferences(retried.tenantId, receiptReferences(retried));
      if (inspection.held) return holdRemaining(retried, context.now());
      const outcome = await deleteSynchronous(retried, inspection);
      if (outcome !== 'conflict') {
        return settleSynchronous(
          retried,
          outcome === 'deleted' ? undefined : 'storage transaction failed',
          inspection,
        );
      }
    }
    return settleSynchronous(retried, 'records changed during deletion', inspection!);
  }

  async function builtIn(
    target: AsynchronousDeletionTarget,
    receipt: MemoryDeletionReceipt,
    inspection: Inspection,
  ): Promise<MemoryDeletionPropagationResult> {
    const references = receiptReferences(receipt);
    if (target === 'indexes') {
      for (const reference of references) await context.textSearchProvider?.remove(reference.id);
      return {
        status: 'completed',
        detail: 'text index entries and record-resident vectors removed',
      };
    }
    const evicting = cachingEmbedders(context);
    if (target === 'caches' && evicting.length > 0) {
      let evicted = 0;
      for (const embedder of evicting)
        evicted += await embedder.evictContent(receipt.contentDigests);
      return { status: 'completed', detail: `${evicted} cached embedding(s) evicted` };
    }
    if (target === 'summaries') {
      // Conditioned on the hold check just made: a summary held since then
      // aborts this attempt, and the next pass finds the hold.
      const { summaries } = receipt.plan;
      await context.deleteMany(conditionedReferences(receipt.tenantId, summaries, inspection));
      return {
        status: 'completed',
        detail: `${presentCount(summaries, inspection)} summary record(s) removed`,
      };
    }
    if (target === 'exports')
      return scrubExports(
        receipt,
        references.map((reference) => reference.id),
      );
    return { status: 'pending', detail: 'no propagator configured for this target' };
  }

  /**
   * Scrubs the deleted records from every export listing them. Each scrub
   * merges onto the manifest as stored when it lands, so an export revoked
   * meanwhile stays revoked.
   */
  async function scrubExports(
    receipt: MemoryDeletionReceipt,
    recordIds: readonly string[],
  ): Promise<MemoryDeletionPropagationResult> {
    const touched = new Set<string>();
    for (const recordId of recordIds) {
      for (const manifest of await context.ledger.listExports({
        tenantId: receipt.tenantId,
        recordId,
      })) {
        touched.add(manifest.exportId);
      }
    }
    for (const exportId of touched) {
      await context.ledger.scrubExport(receipt.tenantId, exportId, recordIds);
    }
    return { status: 'completed', detail: `${touched.size} export manifest(s) scrubbed` };
  }

  async function propagate(
    target: AsynchronousDeletionTarget,
    receipt: MemoryDeletionReceipt,
    inspection: Inspection,
  ): Promise<MemoryDeletionPropagationResult> {
    const configured: MemoryDeletionPropagator | 'not-retained' | undefined =
      context.propagation[target];
    try {
      if (configured === 'not-retained') {
        return { status: 'completed', detail: 'not retained by this deployment' };
      }
      if (configured !== undefined) {
        return await configured.propagate({
          deletionId: receipt.deletionId,
          tenantId: receipt.tenantId,
          target,
          record: receipt.record,
          plan: receipt.plan,
          contentDigests: receipt.contentDigests,
        });
      }
      return await builtIn(target, receipt, inspection);
    } catch {
      return { status: 'pending', detail: 'propagation attempt failed' };
    }
  }

  async function settleAsynchronous(
    target: MemoryDeletionTargetReceipt,
    receipt: MemoryDeletionReceipt,
    inspection: Inspection,
  ): Promise<MemoryDeletionTargetReceipt> {
    const result = await propagate(
      target.target as AsynchronousDeletionTarget,
      receipt,
      inspection,
    );
    const now = context.now();
    const detail = result.detail ? { detail: result.detail } : {};
    if (result.status !== 'pending') {
      return { ...target, status: result.status, settledAt: now, ...detail };
    }
    return overdue({ ...target, ...detail }, now);
  }

  async function advanceAsynchronous(
    receipt: MemoryDeletionReceipt,
  ): Promise<MemoryDeletionReceipt> {
    let current = receipt;
    // Rows that remove records settle first, so the rows waiting on them can
    // follow in the same pass.
    const indices = [...receipt.targets.keys()];
    const removesRecords = (index: number) => RECORD_TARGETS.has(receipt.targets[index]!.target);
    const order = [
      ...indices.filter(removesRecords),
      ...indices.filter((index) => !removesRecords(index)),
    ];
    for (const index of order) {
      const target = receipt.targets[index]!;
      if (target.lane !== 'bounded-async' || target.status !== 'pending') continue;
      // Each target first re-checks every record the deletion names: a hold
      // placed since the last step leaves this target and the rest alone.
      const inspection = await inspectReferences(receipt.tenantId, receiptReferences(receipt));
      if (inspection.held) return holdRemaining(current, context.now());
      // While a record the deletion names is still stored, no other target can
      // be clean of it: the row waits for its removal, failing at its deadline.
      const settled = awaitsRecordRemoval(current, target)
        ? overdue(target, context.now())
        : await settleAsynchronous(target, current, inspection);
      current = { ...current, targets: current.targets.with(index, settled) };
    }
    return withOpen(current, context.now());
  }

  /**
   * Runs the receipt's pending rows and writes what they settled over the
   * receipt as `stored` read it. Two processes can run one receipt at once
   * (two propagation passes, or a pass and a retry), and every row is
   * idempotent (a configured propagator by the at-least-once contract on
   * {@link MemoryDeletionPropagator}), so both may do the work; only the
   * first to write moves the
   * receipt on. The other's outcome, decided from an older read, is dropped
   * in favor of the stored receipt, and anything it did that the stored
   * receipt does not record is redone by the next pass. Returns the receipt
   * as stored after the run, or `undefined` when it is no longer stored.
   */
  async function run(
    stored: StoredMemoryDeletionReceipt,
  ): Promise<MemoryDeletionReceipt | undefined> {
    const synchronous = await executeSynchronous(stored.receipt);
    const settled = synchronous.awaitingHoldRelease
      ? synchronous
      : await advanceAsynchronous(synchronous);
    const written = await advance(stored, settled, 'memory.deletion.propagated');
    if (written !== undefined) return written.receipt;
    return context.ledger.getReceipt(stored.receipt.deletionId);
  }

  /**
   * Runs a failed deletion again under its own receipt: every failed row is
   * pending once more against a fresh deadline, so a retry that removes the
   * record closes the receipt its failure left, and the ledger records who
   * asked. Its plan still covers everything derived from the record, because
   * the first request's claims stop anything new from being derived from it.
   *
   * Reopening the receipt is conditional on the failed receipt as `stored`
   * read it, so of several processes that found the same failure exactly one
   * retries it. Returns `undefined`, having done nothing, when another writer
   * moved the receipt on first (another retry, a propagation pass, or a
   * completed one); the caller decides again from what is stored now.
   */
  async function retryDeletion(
    stored: StoredMemoryDeletionReceipt,
    attribution: MemoryAttribution,
  ): Promise<MemoryDeletionReceipt | undefined> {
    const failed = stored.receipt;
    const now = context.now();
    const bound = resolveTenantPolicy(context.policy(), failed.tenantId).deletionBoundMilliseconds;
    const receipt = withOpen(
      {
        ...failed,
        boundMilliseconds: bound,
        targets: failed.targets.map((target) =>
          target.status === 'failed' ? targetRow(target.target, false, now, bound) : target,
        ),
      },
      now,
    );
    const reopened = await advance(stored, receipt, 'memory.deletion.requested', attribution);
    return reopened === undefined ? undefined : run(reopened);
  }

  /**
   * Claims the record and opens its receipt under the claim. A request that
   * loses its claim before opening (another claimant took it over, or opened
   * the shared `deletionId` first) does not report what it found there: it
   * observes the record again, and {@link decideClaim} decides from that,
   * so a receipt the successor has since failed is retried rather than
   * reported as owned. A retry, or a run, that loses its receipt to another
   * writer observes the record again the same way.
   */
  async function requestDeletion(request: DeletionRequest): Promise<DeletionRequestOutcome> {
    const tenantId = request.resolved.scope.tenantId;
    const reference = {
      id: request.resolved.record.id,
      namespace: request.resolved.scope.namespace,
    };
    for (let attempt = 0; attempt < DELETION_CLAIM_ATTEMPTS; attempt++) {
      const claim = await claimRecord(request, reference);
      if ('status' in claim) {
        if (claim.status !== 'retry') return claim;
        const retried = await retryDeletion(claim.stored, request.attribution);
        if (retried === undefined) continue;
        return { status: 'requested', receipt: retried };
      }
      const receipt = await buildReceipt(request, reference, claim);
      // A claimant that lost its claim stops here, or, if it lost it after
      // this check, at the conditional write: whoever took the claim over
      // builds its receipt under the same `deletionId`, so only one is opened.
      if (!(await stillHolds(tenantId, reference, claim))) continue;
      const opened = await open(receipt);
      if (opened === undefined) continue;
      if (receipt.awaitingHoldRelease) return { status: 'requested', receipt };
      const ran = await run(opened);
      if (ran === undefined) continue;
      return { status: 'requested', receipt: ran };
    }
    return decideClaim(request, { kind: 'contended' });
  }

  /** Plans the deletion `claim` covers and builds the receipt it will open. */
  async function buildReceipt(
    request: DeletionRequest,
    reference: MemoryRecordSourceReference,
    claim: MemoryDeletionClaim,
  ): Promise<MemoryDeletionReceipt> {
    const { resolved } = request;
    const { governance } = resolved.read;
    const tenantId = resolved.scope.tenantId;
    const requestedAt = context.now();
    const bound = resolveTenantPolicy(context.policy(), tenantId).deletionBoundMilliseconds;
    const plan = await claimPlan(request, reference);
    const rows =
      request.scope === 'source'
        ? [...SYNCHRONOUS_DELETION_TARGETS, ...ASYNCHRONOUS_DELETION_TARGETS]
        : [TARGET_FOR_KIND[governance.lineage!.kind], ...PROJECTION_TARGETS];
    // A hold on the record, or on anything its plan reaches, holds the whole
    // deletion: the synchronous lane is one transaction and cannot remove the
    // source while leaving a held projection pointing at nothing. A projection
    // deletion's plan is its own record, so only a hold on that record holds it.
    const derived = await inspectReferences(tenantId, planReferences(plan));
    const held = governance.legalHold === 'held' || derived.held;
    return withOpen(
      {
        version: 1,
        deletionId: claim.deletionId,
        tenantId,
        scope: request.scope,
        trigger: request.trigger,
        record: {
          id: resolved.record.id,
          namespace: resolved.scope.namespace,
          ownerId: governance.ownerId,
          collection: governance.collection,
          memoryClass: governance.memoryClass,
          contentDigest: governance.contentDigest,
        },
        plan,
        contentDigests: [...new Set([governance.contentDigest, ...derived.contentDigests])],
        requestedBy: request.attribution,
        requestedAt,
        boundMilliseconds: bound,
        awaitingHoldRelease: held,
        targets: rows.map((target) => targetRow(target, held, requestedAt, bound)),
        open: false,
        updatedAt: requestedAt,
      },
      requestedAt,
    );
  }

  /**
   * Continues a deletion that a hold stopped after its source was already
   * removed: a new receipt, over the same plan, runs every target the hold
   * exempted and carries over what had already settled.
   */
  async function resumeDeletion(
    held: MemoryDeletionReceipt,
  ): Promise<MemoryDeletionReceipt | undefined> {
    const requestedAt = context.now();
    const bound = resolveTenantPolicy(context.policy(), held.tenantId).deletionBoundMilliseconds;
    const receipt = withOpen(
      {
        ...held,
        // Named after the held receipt, so two passes resuming it at once
        // build the same receipt and only one of them opens it.
        deletionId: `${held.deletionId}:resumed`,
        trigger: 'hold-release',
        requestedAt,
        boundMilliseconds: bound,
        awaitingHoldRelease: false,
        targets: held.targets.map((target) =>
          target.status === 'exempt' ? targetRow(target.target, false, requestedAt, bound) : target,
        ),
      },
      requestedAt,
    );
    const opened = await open(receipt);
    if (opened !== undefined) return run(opened);
    // Another pass resumed it first; its receipt is the one to report.
    return context.ledger.getReceipt(receipt.deletionId);
  }

  /**
   * Re-queues a held deletion once its hold is released: a fresh deletion when
   * its record still exists, or the rest of the same plan when the hold stopped
   * it partway. The new receipt is recorded before the held one closes, so a
   * crash in between leaves the held receipt waiting, and
   * {@link DeletionEngine.processOpen} re-queues it again (finding the record
   * already gone if the new deletion ran). So does a re-queue that finds
   * another deletion's claim on the record with no receipt behind it yet: the
   * held receipt keeps waiting until a receipt owns the record. The held
   * receipt is read again first, and closed by a conditional write on that
   * read, so a re-queue another pass already closed is left alone.
   */
  async function requeueAfterRelease(
    listed: MemoryDeletionReceipt,
  ): Promise<MemoryDeletionReceipt | undefined> {
    const held = await context.ledger.readReceipt(listed.deletionId);
    if (held === undefined || !held.receipt.awaitingHoldRelease) return undefined;
    const { receipt } = held;
    const resolved = await context.load(receipt.tenantId, sourceOf(receipt));
    const partial = receipt.targets.some((target) => target.status !== 'exempt');
    let next: MemoryDeletionReceipt | undefined;
    if (resolved !== undefined) {
      const outcome = await requestDeletion({
        attribution: receipt.requestedBy,
        resolved,
        trigger: 'hold-release',
        scope: receipt.scope,
      });
      if (outcome.status === 'pending') return undefined;
      if (outcome.status === 'requested') next = outcome.receipt;
    } else if (partial) {
      next = await resumeDeletion(receipt);
    }
    // Losing this write means another pass closed the held receipt first.
    await context.ledger.replaceReceipt(held, {
      ...receipt,
      awaitingHoldRelease: false,
      updatedAt: context.now(),
    });
    return next;
  }

  async function holdStillApplies(receipt: MemoryDeletionReceipt): Promise<boolean> {
    const inspection = await inspectReferences(receipt.tenantId, receiptReferences(receipt));
    return inspection.held;
  }

  return {
    requestDeletion,
    requeueAfterRelease,

    async processOpen() {
      const settled: MemoryDeletionReceipt[] = [];
      for (const listed of await context.ledger.listReceipts({ open: true })) {
        // Read again, with its revision: the listing may already be stale.
        const stored = await context.ledger.readReceipt(listed.deletionId);
        if (!stored?.receipt.open) continue;
        const ran = await run(stored);
        if (ran !== undefined) settled.push(ran);
      }
      // A release that died after lifting its hold but before re-queueing left
      // its held receipt waiting on a hold that no longer applies: resume it.
      for (const receipt of await context.ledger.listReceipts({ open: false })) {
        if (!receipt.awaitingHoldRelease || (await holdStillApplies(receipt))) continue;
        const next = await requeueAfterRelease(receipt);
        if (next !== undefined) settled.push(next);
      }
      return settled;
    },
  };
}
