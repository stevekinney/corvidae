import type { RuntimeServices } from '@lostgradient/lifecycle';

import {
  type MemoryRecord,
  type MemoryRecordReference,
  type MemoryRecordScope,
  type MemoryRecordStorage,
  MemoryRecordVersionConflictError,
} from '../memory-record-storage';
import type { TextSearchProvider } from '../text-search-provider';
import type { MemoryCorrelation } from '../transition-events';
import type { MemoryAuthority, MemoryOperation } from './authority';
import type { GovernedEmbedding } from './governed-embedding';
import type {
  MemoryDeletionPropagation,
  MemoryGovernanceNotification,
  MemoryOperationResult,
  MemoryOperationStatus,
  MemoryRecordLocator,
  MemorySupersessionNotice,
} from './governed-memory-types';
import type { MemoryGovernanceLedger } from './ledger';
import type { MemoryGovernanceEvent } from './ledger-types';
import type { MemoryGovernancePolicy } from './policy';
import {
  decideMemoryAccess,
  type MemoryAccessDecision,
  type MemoryDenialReason,
  type MemoryRecordState,
  type MemoryRedaction,
  type MemoryResourceDescriptor,
  type MemoryVisibility,
} from './predicate';
import {
  attributionFor,
  collectionNamespace,
  describeResource,
  type LegalHoldState,
  MEMORY_GOVERNANCE_METADATA_KEY,
  type MemoryAttribution,
  type MemoryRecordSourceReference,
  type ReadRecordGovernance,
  readRecordGovernance,
  type RecordGovernance,
} from './record-governance';

export type TenantScope = Required<MemoryRecordScope>;

export interface ResolvedRecord {
  readonly record: MemoryRecord;
  readonly read: ReadRecordGovernance;
  readonly scope: TenantScope;
}

export type GovernanceEventInput = Omit<MemoryGovernanceEvent, 'id' | 'at'>;

/**
 * The envelope fields an ordinary governance transition may change. Tenant,
 * owner, collection, provenance, trust, lineage, and attribution are fixed at
 * admission; an ordinary transition only moves a record out of `active`, and a
 * quarantined record comes back only through
 * {@link GovernanceContext.activateQuarantined}; the legal hold changes only
 * through {@link GovernanceContext.updateLegalHold}; and a derived record's
 * pending marker is cleared only through
 * {@link GovernanceContext.activateDerivation}.
 */
export type GovernancePatch = Partial<
  Pick<
    RecordGovernance,
    | 'sharedWith'
    | 'retrievalWeight'
    | 'indexInvalidated'
    | 'invalidatedAt'
    | 'supersededBy'
    | 'deletionRequestedAt'
    | 'deletionClaim'
  >
> & { readonly state?: Exclude<MemoryRecordState, 'active'> };

/**
 * A transition: a patch, or a function deciding the patch from the record's
 * current envelope (returning `undefined` when nothing should change).
 */
export type GovernanceChange =
  GovernancePatch | ((current: RecordGovernance) => GovernancePatch | undefined);

/**
 * How many times an envelope transition re-reads and retries after another
 * writer changed the record first. Each retry means some other transition
 * landed, so contention this deep is a fault worth surfacing.
 */
const ENVELOPE_WRITE_ATTEMPTS = 8;

/** What {@link GovernanceContext.invalidate} came to. */
export type InvalidationOutcome = 'stamped' | 'declined' | 'missing';

/**
 * Why a stored record cannot be released from quarantine, in the order the reasons are
 * decided: `revoked` (never re-activated) and `active` (nothing to release) are not
 * rejections, and the rest are. Several can hold at once; the first one named is the answer.
 */
export type QuarantineReleaseBlock =
  'revoked' | 'active' | 'derived-record' | 'deletion-pending' | 'superseded' | 'tampered';

/**
 * The reason, if any, that the record whose envelope and integrity are `read` cannot be
 * released from quarantine. The one decision both the release's early checks and the fence on
 * its write make, so the two cannot disagree.
 */
export function quarantineReleaseBlock(
  read: ReadRecordGovernance,
): QuarantineReleaseBlock | undefined {
  const { governance } = read;
  if (governance.state === 'revoked') return 'revoked';
  if (governance.state === 'active') return 'active';
  if (governance.lineage !== undefined) return 'derived-record';
  if (governance.deletionRequestedAt !== undefined) return 'deletion-pending';
  if (governance.invalidatedAt !== undefined) return 'superseded';
  if (read.integrity === 'tampered') return 'tampered';
  return undefined;
}

/** What {@link GovernanceContext.activateQuarantined} came to. */
export type ActivationOutcome =
  | { readonly outcome: 'activated'; readonly governance: RecordGovernance }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'declined'; readonly block: QuarantineReleaseBlock };

export type AuthorizationOutcome =
  | { readonly allowed: true; readonly decision: Extract<MemoryAccessDecision, { allowed: true }> }
  | { readonly allowed: false; readonly result: MemoryOperationResult };

/**
 * The shared internals every governed operation uses. Not exported from the
 * package: callers reach memory only through {@link GovernedMemory}.
 */
export interface GovernanceContext {
  readonly storage: MemoryRecordStorage;
  /**
   * Deletes the referenced records in one storage transaction, then their vectors from every
   * profile. A version conflict throws before any vector is touched.
   */
  readonly deleteMany: (references: readonly MemoryRecordReference[]) => Promise<number>;
  readonly ledger: MemoryGovernanceLedger;
  readonly embedding: GovernedEmbedding;
  readonly textSearchProvider: TextSearchProvider | undefined;
  readonly runtime: RuntimeServices;
  readonly propagation: MemoryDeletionPropagation;
  policy(): MemoryGovernancePolicy;
  operationId(): string;
  now(): number;
  scope(
    tenantId: string,
    visibility: MemoryVisibility,
    ownerId: string,
    collection: string,
  ): TenantScope;
  locate(authority: MemoryAuthority, locator: MemoryRecordLocator): TenantScope;
  resolve(
    authority: MemoryAuthority,
    locator: MemoryRecordLocator,
  ): Promise<ResolvedRecord | undefined>;
  load(
    tenantId: string,
    reference: MemoryRecordSourceReference,
  ): Promise<ResolvedRecord | undefined>;
  /**
   * Applies a transition to the record's current envelope, never to the
   * snapshot in `resolved`: the record is re-read, the change is merged onto
   * what is stored now, and the write is a compare-and-swap against the version
   * read, retried when another transition lands first. Returns `false` when the
   * record no longer exists.
   */
  updateGovernance(resolved: ResolvedRecord, change: GovernanceChange): Promise<boolean>;
  /**
   * The one transition that takes a record out of active use because `replacementId` replaces
   * it, with the same merge and compare-and-swap. The check that the record is still in use is
   * part of that swap: `declined` means another replacement stamped it first, and nothing was
   * written. `missing` means the record no longer exists.
   */
  invalidate(resolved: ResolvedRecord, replacementId: string): Promise<InvalidationOutcome>;
  /**
   * Gives a record back to active use, only if `replacementId` is the replacement that took it
   * out: the way a caller that lost a race withdraws the stamps it already made.
   */
  releaseInvalidation(resolved: ResolvedRecord, replacementId: string): Promise<boolean>;
  /** The one transition that sets a record's legal hold, with the same merge and compare-and-swap. */
  updateLegalHold(resolved: ResolvedRecord, legalHold: LegalHoldState): Promise<boolean>;
  /**
   * The one transition that clears a derived record's `pendingDerivation`
   * marker, with the same merge and compare-and-swap. It declines on a record
   * a deletion has claimed, which then stays hidden until it is removed.
   * Returns the envelope now stored, or `undefined` when the record is gone
   * or claimed.
   */
  activateDerivation(resolved: ResolvedRecord): Promise<RecordGovernance | undefined>;
  /**
   * The one transition that gives a quarantined record back to active use, with the same merge
   * and compare-and-swap. The write is decided against the record as it is stored now, and
   * declines, writing nothing, unless that record is still quarantined, not derived, not claimed
   * by a deletion, not superseded, and still matches the digest recorded at admission:
   * `declined` names the first condition that failed ({@link quarantineReleaseBlock}), and
   * `missing` means the record no longer exists. The digest check is what makes the content a
   * caller scanned the content that becomes active.
   */
  activateQuarantined(resolved: ResolvedRecord): Promise<ActivationOutcome>;
  attribution(authority: MemoryAuthority, operationId: string): MemoryAttribution;
  /** Appends an event to the ledger and notifies `onEvent`, with `correlation` on the notification only. */
  recordEvent(event: GovernanceEventInput, correlation?: MemoryCorrelation): Promise<void>;
  authorize(
    authority: MemoryAuthority,
    operation: MemoryOperation,
    resource: MemoryResourceDescriptor,
    context: { operationId: string; recordIds: readonly string[] },
  ): Promise<AuthorizationOutcome>;
}

const HIDDEN_DENIALS: ReadonlySet<MemoryDenialReason> = new Set([
  'tenant-mismatch',
  'not-owner',
  'tampered',
  'pending-derivation',
]);

/** The supersession notice of a `memory.forgotten` event a correction recorded, or nothing. */
function supersessionNoticeOf(event: MemoryGovernanceEvent): {
  readonly supersession?: MemorySupersessionNotice;
} {
  const details = event.details;
  if (event.type !== 'memory.forgotten' || details?.['mode'] !== 'supersession') return {};
  const collection = details['collection'];
  const source = details['source'];
  if (typeof collection !== 'string' || typeof source !== 'string') return {};
  return { supersession: { collection, source } };
}

/**
 * How a denial reads to the caller. Missing a capability says nothing about the
 * resource, so it is reported as `denied`. Tenant, ownership, integrity, and
 * pending-derivation denials are reported exactly like a missing record, so a
 * guessed id or namespace learns nothing. An owner acting on its own record in
 * the wrong state is told why.
 */
export function statusForDenial(reason: MemoryDenialReason): MemoryOperationStatus {
  if (reason === 'missing-capability') return 'denied';
  return HIDDEN_DENIALS.has(reason) ? 'not-found' : 'rejected';
}

export interface CreateGovernanceContextInput {
  readonly storage: MemoryRecordStorage;
  readonly ledger: MemoryGovernanceLedger;
  readonly embedding: GovernedEmbedding;
  readonly textSearchProvider: TextSearchProvider | undefined;
  readonly runtime: RuntimeServices;
  readonly propagation: MemoryDeletionPropagation;
  readonly policy: () => MemoryGovernancePolicy;
  readonly onEvent:
    ((notification: MemoryGovernanceNotification) => void | Promise<void>) | undefined;
}

export function createGovernanceContext(input: CreateGovernanceContextInput): GovernanceContext {
  const { storage, ledger, runtime, onEvent } = input;
  const boundDeleteMany = storage.deleteMany?.bind(storage);
  if (boundDeleteMany === undefined) {
    throw new Error(
      'Governed memory requires storage.deleteMany: synchronous deletion targets must share one transaction.',
    );
  }
  const deleteRecords: (references: readonly MemoryRecordReference[]) => Promise<number> =
    boundDeleteMany;
  async function deleteMany(references: readonly MemoryRecordReference[]): Promise<number> {
    // Snapshotted before the first await, so the vectors deleted are those of the records that were.
    const vectors = references.map(({ id, scope: target }) => ({ id, scope: { ...target } }));
    const removed = await deleteRecords(references);
    // A failure here throws after the records are gone, leaving their vectors. That is the repair
    // path, not a leak: the synchronous deletion lane reports the target `failed` and retries it,
    // and the retry deletes no record but runs `forget` again. Recall never reads the vectors in
    // between, because it reads only the vectors of records it found.
    await input.embedding.forget(vectors);
    return removed;
  }

  function scope(
    tenantId: string,
    visibility: MemoryVisibility,
    ownerId: string,
    collection: string,
  ): TenantScope {
    return { tenantId, namespace: collectionNamespace(visibility, ownerId, collection) };
  }

  async function loadFrom(target: TenantScope, id: string): Promise<ResolvedRecord | undefined> {
    const record = await storage.get(id, target);
    if (record === undefined) return undefined;
    const read = readRecordGovernance(record);
    return read === undefined ? undefined : { record, read, scope: target };
  }

  /**
   * Replaces a record's envelope with `next(current)`, where `current` is the
   * envelope stored now, as a compare-and-swap retried when another
   * transition lands first. `next` returning `undefined` leaves it alone. It is also told
   * whether the content it was read with still matches the admission digest.
   */
  async function transition(
    resolved: ResolvedRecord,
    next: (
      current: RecordGovernance,
      integrity: ReadRecordGovernance['integrity'],
    ) => RecordGovernance | undefined,
  ): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      const current = await loadFrom(resolved.scope, resolved.record.id);
      if (current === undefined) return false;
      const envelope = next(current.read.governance, current.read.integrity);
      if (envelope === undefined) return true;
      const metadata = { ...current.record.metadata, [MEMORY_GOVERNANCE_METADATA_KEY]: envelope };
      try {
        const updated = await storage.update(
          current.record.id,
          current.scope,
          { metadata },
          { expectedVersion: current.record.version },
        );
        return updated !== undefined;
      } catch (error) {
        const retry =
          error instanceof MemoryRecordVersionConflictError && attempt < ENVELOPE_WRITE_ATTEMPTS;
        if (!retry) throw error;
      }
    }
  }

  const context: GovernanceContext = {
    storage,
    deleteMany,
    ledger,
    embedding: input.embedding,
    textSearchProvider: input.textSearchProvider,
    runtime,
    propagation: input.propagation,
    policy: input.policy,
    operationId: () => runtime.identifiers.next('memory-operation'),
    now: () => runtime.clock.now(),
    scope,

    locate(authority, locator) {
      return scope(
        authority.tenantId,
        locator.visibility ?? 'private',
        locator.ownerId ?? authority.ownerId,
        locator.collection,
      );
    },

    async resolve(authority, locator) {
      if (locator.collection.length === 0) return undefined;
      return loadFrom(context.locate(authority, locator), locator.id);
    },

    async load(tenantId, reference) {
      return loadFrom({ tenantId, namespace: reference.namespace }, reference.id);
    },

    updateGovernance(resolved, change) {
      const patchFor = typeof change === 'function' ? change : () => change;
      return transition(resolved, (current) => {
        const patch = patchFor(current);
        return patch === undefined ? undefined : { ...current, ...patch };
      });
    },

    async invalidate(resolved, replacementId) {
      let declined = false;
      const stored = await transition(resolved, (current) => {
        declined = current.invalidatedAt !== undefined;
        return declined
          ? undefined
          : { ...current, invalidatedAt: runtime.clock.now(), supersededBy: replacementId };
      });
      if (!stored) return 'missing';
      return declined ? 'declined' : 'stamped';
    },

    releaseInvalidation(resolved, replacementId) {
      return transition(resolved, (current) => {
        if (current.supersededBy !== replacementId) return undefined;
        const { invalidatedAt: _at, supersededBy: _by, ...released } = current;
        return released;
      });
    },

    updateLegalHold(resolved, legalHold) {
      return transition(resolved, (current) => ({ ...current, legalHold }));
    },

    async activateDerivation(resolved) {
      let activated: RecordGovernance | undefined;
      const stored = await transition(resolved, (current) => {
        const { pendingDerivation, ...settled } = current;
        activated = current.deletionRequestedAt === undefined ? settled : undefined;
        return pendingDerivation === true && activated !== undefined ? settled : undefined;
      });
      return stored ? activated : undefined;
    },

    async activateQuarantined(resolved) {
      let block: QuarantineReleaseBlock | undefined;
      let activated: RecordGovernance | undefined;
      const stored = await transition(resolved, (current, integrity) => {
        // Decided again on each attempt, against the envelope that attempt read.
        block = quarantineReleaseBlock({ governance: current, integrity });
        activated = block === undefined ? { ...current, state: 'active' } : undefined;
        return activated;
      });
      if (!stored) return { outcome: 'missing' };
      return activated === undefined || block !== undefined
        ? { outcome: 'declined', block: block ?? 'active' }
        : { outcome: 'activated', governance: activated };
    },

    attribution(authority, operationId) {
      return attributionFor(authority, {
        governanceRevision: input.policy().revision,
        operationId,
        at: runtime.clock.now(),
      });
    },

    async recordEvent(event, correlation) {
      const stored: MemoryGovernanceEvent = {
        ...event,
        id: runtime.identifiers.next('memory-event'),
        at: runtime.clock.now(),
      };
      await ledger.appendEvent(stored);
      const operationId = event.attribution?.operationId ?? event.details?.['operationId'];
      await onEvent?.({
        type: stored.type,
        outcome: stored.outcome,
        tenantId: stored.tenantId,
        at: stored.at,
        recordIds: stored.recordIds,
        ...(typeof operationId === 'string' ? { operationId } : {}),
        ...(event.attribution === undefined
          ? {}
          : {
              principalId: event.attribution.principal.id,
              projection: event.attribution.projection,
            }),
        ...(correlation === undefined ? {} : { correlation }),
        ...supersessionNoticeOf(stored),
      });
    },

    async authorize(authority, operation, resource, details) {
      const decision = decideMemoryAccess(authority, operation, resource);
      if (decision.allowed) return { allowed: true, decision };
      await context.recordEvent({
        tenantId: authority.tenantId,
        type: 'memory.access.denied',
        outcome: 'denied',
        attribution: context.attribution(authority, details.operationId),
        recordIds: details.recordIds,
        details: { operation },
        reason: decision.reason,
      });
      return {
        allowed: false,
        result: {
          operationId: details.operationId,
          status: statusForDenial(decision.reason),
          ...(statusForDenial(decision.reason) === 'rejected' ? { reason: decision.reason } : {}),
        },
      };
    },
  };
  return context;
}

/**
 * What every activation of a record does for text search, so no activation path can forget the
 * check: the record is indexed only when the envelope the activation wrote is active and its
 * owner has not index-invalidated it (a forget removed it from the index, and nothing but a
 * deletion puts it back). The decision is made again once the entry is written: a quarantine,
 * withhold, deletion or index invalidation that landed between the activation and the `index`
 * ran its own `remove`, which this `index` may have outlived, so the record is read again and the
 * entry is removed when it is gone, no longer active, or index-invalidated now. Returns whether an
 * entry was left.
 */
export async function indexActivated(
  context: GovernanceContext,
  resolved: ResolvedRecord,
  governance: RecordGovernance,
): Promise<boolean> {
  if (governance.state !== 'active' || governance.indexInvalidated) return false;
  const provider = context.textSearchProvider;
  if (provider === undefined) return false;
  await provider.index(resolved.record.id, resolved.record.content, resolved.scope.namespace);
  const stored = await context.load(resolved.scope.tenantId, {
    id: resolved.record.id,
    namespace: resolved.scope.namespace,
  });
  const current = stored?.read.governance;
  if (current === undefined || current.state !== 'active' || current.indexInvalidated) {
    await provider.remove(resolved.record.id);
    return false;
  }
  return true;
}

/** The resource descriptor for a resolved record. */
export function resourceOf(resolved: ResolvedRecord): MemoryResourceDescriptor {
  return describeResource(resolved.read);
}

/** The descriptor a write targets: the caller's own private partition. */
export function ownPrivateResource(authority: MemoryAuthority): MemoryResourceDescriptor {
  return {
    tenantId: authority.tenantId,
    ownerId: authority.ownerId,
    visibility: 'private',
    state: 'active',
    sharedWith: [],
    integrity: 'intact',
    pendingDerivation: false,
  };
}

/** Authorizes an operation on a record that may not exist, hiding which case applies. */
export async function authorizeLocated(
  context: GovernanceContext,
  authority: MemoryAuthority,
  operation: MemoryOperation,
  locator: MemoryRecordLocator,
  operationId: string,
): Promise<
  { resolved: ResolvedRecord; redaction: MemoryRedaction } | { result: MemoryOperationResult }
> {
  const resolved = await context.resolve(authority, locator);
  if (resolved === undefined) {
    const capabilityCheck = await context.authorize(
      authority,
      operation,
      ownPrivateResource(authority),
      {
        operationId,
        recordIds: [locator.id],
      },
    );
    if (!capabilityCheck.allowed) return { result: capabilityCheck.result };
    return { result: { operationId, status: 'not-found' } };
  }
  const outcome = await context.authorize(authority, operation, resourceOf(resolved), {
    operationId,
    recordIds: [locator.id],
  });
  return outcome.allowed
    ? { resolved, redaction: outcome.decision.redaction }
    : { result: outcome.result };
}
