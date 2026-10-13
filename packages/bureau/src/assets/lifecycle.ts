/**
 * Lifecycle transitions after admission (COR-794): retention and reference
 * renewal, legal/audit holds, expiry, deletion with tombstones, provider
 * transfer, and garbage collection.
 *
 * Every transition runs under the asset's in-process lock and commits as one
 * compare-and-swap over the record (plus the owner/digest keys it implies),
 * so each one is a single deterministic step from one revision to the next:
 *
 * - `available` → `expired` once the latest of the retention floor and every
 *   live reference has passed, unless a hold is present (by `expire()` or by
 *   collection);
 * - `available`/`expired`/`rejected`/`quarantined` → `deleted` (a tombstone)
 *   by `delete()`, unless a hold is present; a second deletion is a no-op
 *   that returns the same tombstone;
 * - any terminal record → purged once its `tombstoneUntil` passes;
 * - `pending` with no live admission in this process → `rejected`
 *   (`interrupted`) — the recovery path for an admission a failed process
 *   left behind;
 * - a blob with no owner key and no lease → purged; an expired or abandoned
 *   upload session → purged with its chunks.
 */
import { AssetAdmissionError, AssetHeldError, AssetUnavailableError } from './errors';
import { type AssetInternals, classifyFailure } from './internals';
import type { AssetWorkContext } from './operation';
import { readVerifiedBytes, type UploadSessionRecord } from './admission';
import {
  type AssetRecord,
  authorize,
  authorizeOwner,
  authorizePrivileged,
  computeExpiresAt,
  KEYS,
  type LoadedRecord,
  loadRecord,
  projectFor,
  replaceRecord,
} from './records';
import type { AssetStorageOperation } from './storage';
import type {
  AssetDescriptor,
  AssetGarbageCollectionReport,
  AssetPrincipal,
  AssetProviderCopy,
  AssetWorkHandle,
} from './types';

type Change =
  { readonly next: AssetRecord; readonly extra?: readonly AssetStorageOperation[] } | undefined;
type Mutation = (loaded: LoadedRecord) => Change | Promise<Change>;

/** Loads, authorizes, and (when `mutate` returns a change) commits one revision under the asset's lock. */
async function transition(
  internals: AssetInternals,
  assetId: string,
  check: (record: AssetRecord | undefined) => AssetRecord,
  mutate: Mutation,
): Promise<AssetRecord> {
  return internals.withLock(assetId, async () => {
    const loaded = await loadRecord(internals.storage, assetId);
    check(loaded?.record);
    const change = await mutate(loaded!);
    if (!change) return loaded!.record;
    await replaceRecord(internals.storage, loaded!, change.next, change.extra);
    return change.next;
  });
}

function bump(
  internals: AssetInternals,
  record: AssetRecord,
  patch: Partial<AssetRecord>,
): AssetRecord {
  return { ...record, ...patch, revision: record.revision + 1, updatedAt: internals.nowIso() };
}

/**
 * The writes that end an asset's claim on its blob, and on its owner's
 * duplicate index entry when that entry still names this asset (with
 * `store-separately`, a later identical asset may have taken it over).
 */
async function releaseOwnership(
  internals: AssetInternals,
  record: AssetRecord,
): Promise<AssetStorageOperation[]> {
  if (record.digest === undefined || record.custody !== 'bureau') return [];
  const operations: AssetStorageOperation[] = [
    { type: 'delete', key: KEYS.owner(record.digest, record.assetId) },
  ];
  const indexKey = KEYS.digestIndex(record.ownerId, record.digest);
  if ((await internals.storage.get(indexKey)) === record.assetId)
    operations.push({ type: 'delete', key: indexKey });
  return operations;
}

function requireAvailable(record: AssetRecord): AssetRecord {
  if (record.state !== 'available') throw new AssetUnavailableError(record.assetId, record.state);
  return record;
}

export async function retain(
  internals: AssetInternals,
  assetId: string,
  principal: AssetPrincipal,
  reference: { readonly holderId: string; readonly until: string },
): Promise<AssetDescriptor> {
  const until = new Date(Date.parse(reference.until)).toISOString();
  const record = await transition(
    internals,
    assetId,
    (current) => requireAvailable(authorize(current, assetId, principal)),
    ({ record: current }) => {
      const existing = current.references.find((entry) => entry.holderId === reference.holderId);
      // Renewal is monotonic: a claim is extended, never shortened.
      if (existing && Date.parse(existing.until) >= Date.parse(until)) return undefined;
      const references = [
        ...current.references.filter((entry) => entry.holderId !== reference.holderId),
        { holderId: reference.holderId, until },
      ].toSorted((left, right) => left.holderId.localeCompare(right.holderId));
      return { next: bump(internals, current, { references }) };
    },
  );
  await internals.emit({
    type: 'asset.retained',
    assetId,
    revision: record.revision,
    state: record.state,
    principal: principal.id,
    holderId: reference.holderId,
  });
  return projectFor(record, principal);
}

export async function release(
  internals: AssetInternals,
  assetId: string,
  principal: AssetPrincipal,
  holderId: string,
): Promise<AssetDescriptor> {
  const record = await transition(
    internals,
    assetId,
    (current) => authorize(current, assetId, principal),
    ({ record: current }) =>
      current.references.some((entry) => entry.holderId === holderId)
        ? {
            next: bump(internals, current, {
              references: current.references.filter((entry) => entry.holderId !== holderId),
            }),
          }
        : undefined,
  );
  await internals.emit({
    type: 'asset.released',
    assetId,
    revision: record.revision,
    state: record.state,
    principal: principal.id,
    holderId,
  });
  return projectFor(record, principal);
}

export async function placeHold(
  internals: AssetInternals,
  assetId: string,
  principal: AssetPrincipal,
  hold: { readonly holdId: string; readonly kind: 'legal' | 'audit' },
): Promise<AssetDescriptor> {
  const record = await transition(
    internals,
    assetId,
    (current) => {
      const authorized = authorizePrivileged(current, assetId, principal, 'place a hold on');
      if (authorized.state === 'deleted')
        throw new AssetUnavailableError(assetId, authorized.state);
      return authorized;
    },
    ({ record: current }) =>
      current.holds.some((entry) => entry.holdId === hold.holdId)
        ? undefined
        : {
            next: bump(internals, current, {
              holds: [
                ...current.holds,
                {
                  holdId: hold.holdId,
                  kind: hold.kind,
                  placedAt: internals.nowIso(),
                  placedBy: principal.id,
                },
              ],
            }),
          },
  );
  await internals.emit({
    type: 'asset.hold.placed',
    assetId,
    revision: record.revision,
    state: record.state,
    principal: principal.id,
    holdId: hold.holdId,
  });
  return projectFor(record, principal);
}

export async function releaseHold(
  internals: AssetInternals,
  assetId: string,
  principal: AssetPrincipal,
  holdId: string,
): Promise<AssetDescriptor> {
  const record = await transition(
    internals,
    assetId,
    (current) => authorizePrivileged(current, assetId, principal, 'release a hold on'),
    ({ record: current }) =>
      current.holds.some((entry) => entry.holdId === holdId)
        ? {
            next: bump(internals, current, {
              holds: current.holds.filter((entry) => entry.holdId !== holdId),
            }),
          }
        : undefined,
  );
  await internals.emit({
    type: 'asset.hold.released',
    assetId,
    revision: record.revision,
    state: record.state,
    principal: principal.id,
    holdId,
  });
  return projectFor(record, principal);
}

async function expiredRecord(
  internals: AssetInternals,
  record: AssetRecord,
): Promise<{ next: AssetRecord; extra: AssetStorageOperation[] }> {
  const now = internals.nowIso();
  return {
    next: bump(internals, record, {
      state: 'expired',
      expiredAt: now,
      tombstoneUntil: internals.isoAfter(internals.policy.tombstoneRetentionMilliseconds),
    }),
    extra: await releaseOwnership(internals, record),
  };
}

export async function expire(
  internals: AssetInternals,
  assetId: string,
  principal: AssetPrincipal,
): Promise<AssetDescriptor> {
  const record = await transition(
    internals,
    assetId,
    (current) => {
      const owned = requireAvailable(authorizeOwner(current, assetId, principal));
      if (owned.holds.length > 0) throw new AssetHeldError(assetId);
      return owned;
    },
    ({ record: current }) => expiredRecord(internals, current),
  );
  await internals.emit({
    type: 'asset.expired',
    assetId,
    revision: record.revision,
    state: 'expired',
    principal: principal.id,
  });
  return projectFor(record, principal);
}

export function startDeletion(
  internals: AssetInternals,
  assetId: string,
  principal: AssetPrincipal,
): AssetWorkHandle<AssetDescriptor> {
  return internals.registry.start<AssetDescriptor>(
    { kind: 'deletion', assetId, owner: principal.id, classify: (error) => classifyFailure(error) },
    async (context) => {
      let alreadyDeleted = false;
      const record = await transition(
        internals,
        assetId,
        (current) => {
          const owned = authorizeOwner(current, assetId, principal);
          if (owned.state === 'deleted') return owned;
          if (owned.state === 'pending') throw new AssetUnavailableError(assetId, owned.state);
          if (owned.holds.length > 0)
            throw new AssetAdmissionError('held', 'The asset is under a hold.');
          return owned;
        },
        async ({ record: current }) => {
          if (current.state === 'deleted') {
            alreadyDeleted = true;
            return undefined;
          }
          const now = internals.nowIso();
          return {
            next: bump(internals, current, {
              state: 'deleted',
              deletedAt: now,
              tombstoneUntil: internals.isoAfter(internals.policy.tombstoneRetentionMilliseconds),
            }),
            extra: current.state === 'available' ? await releaseOwnership(internals, current) : [],
          };
        },
      );
      if (alreadyDeleted) return projectFor(record, principal);
      await internals.emit({
        type: 'asset.deleted',
        assetId,
        revision: record.revision,
        state: 'deleted',
        principal: principal.id,
      });
      // Provider copies are deleted after the tombstone commits; a provider that never answers leaves the copy listed on the privileged projection.
      for (const copy of record.providerCopies) {
        const transport = internals.ports.providers?.[copy.provider];
        if (transport?.delete)
          await context.track(
            transport.delete({ providerFileId: copy.providerFileId, signal: context.signal }),
          );
      }
      return projectFor(record, principal);
    },
  );
}

export function startProviderTransfer(
  internals: AssetInternals,
  assetId: string,
  principal: AssetPrincipal,
  provider: string,
): AssetWorkHandle<AssetProviderCopy> {
  return internals.registry.start<AssetProviderCopy>(
    {
      kind: 'provider-transfer',
      assetId,
      owner: principal.id,
      classify: (error) => classifyFailure(error, 'provider-transfer-failed'),
    },
    async (context) => {
      const transport = internals.ports.providers?.[provider];
      if (!transport)
        throw new AssetAdmissionError('unsupported-source', 'The provider is not configured.');
      const loaded = await context.track(loadRecord(internals.storage, assetId));
      const record = requireAvailable(authorize(loaded?.record, assetId, principal));
      if (record.custody !== 'bureau') throw new AssetUnavailableError(assetId, record.state);
      const bytes = await readVerifiedBytes(internals, record, context.track);
      const uploaded = await context.track(
        transport.upload({ bytes, mediaType: record.mediaType, signal: context.signal }),
      );
      const copy: AssetProviderCopy = { provider, providerFileId: uploaded.providerFileId };
      const committed = await transition(
        internals,
        assetId,
        (current) => requireAvailable(authorize(current, assetId, principal)),
        ({ record: current }) => ({
          next: bump(internals, current, { providerCopies: [...current.providerCopies, copy] }),
        }),
      );
      await internals.emit({
        type: 'asset.provider-copy.created',
        assetId,
        revision: committed.revision,
        state: committed.state,
        principal: principal.id,
        provider,
      });
      return copy;
    },
  );
}

// ── Garbage collection ────────────────────────────────────────────────

interface CollectionState {
  readonly now: number;
  readonly report: {
    expired: string[];
    purgedTombstones: string[];
    purgedBlobs: string[];
    purgedUploads: string[];
    interruptedAdmissions: string[];
    leasedBlobs: string[];
  };
}

function isExpired(record: AssetRecord, now: number): boolean {
  const expiresAt = computeExpiresAt(record);
  return (
    record.state === 'available' &&
    record.holds.length === 0 &&
    expiresAt !== undefined &&
    Date.parse(expiresAt) <= now
  );
}

async function collectRecord(
  internals: AssetInternals,
  context: AssetWorkContext,
  assetId: string,
  state: CollectionState,
): Promise<void> {
  const { storage } = internals;
  await internals.withLock(assetId, async () => {
    const loaded = await context.track(loadRecord(storage, assetId));
    if (!loaded) return;
    const { record } = loaded;
    if (record.state === 'pending' && !internals.pendingAdmissions.has(assetId)) {
      const next = bump(internals, record, {
        state: 'rejected',
        rejection: {
          code: 'interrupted',
          message: 'The admission was interrupted before it committed.',
        },
        tombstoneUntil: internals.isoAfter(internals.policy.tombstoneRetentionMilliseconds),
      });
      await replaceRecord(storage, loaded, next);
      state.report.interruptedAdmissions.push(assetId);
      await internals.emit({
        type: 'asset.rejected',
        assetId,
        revision: next.revision,
        state: 'rejected',
        code: 'interrupted',
      });
      return;
    }
    if (isExpired(record, state.now)) {
      const { next, extra } = await expiredRecord(internals, record);
      await replaceRecord(storage, loaded, next, extra);
      state.report.expired.push(assetId);
      await internals.emit({
        type: 'asset.expired',
        assetId,
        revision: next.revision,
        state: 'expired',
      });
      return;
    }
    const terminal = record.state !== 'pending' && record.state !== 'available';
    if (
      terminal &&
      record.tombstoneUntil !== undefined &&
      Date.parse(record.tombstoneUntil) <= state.now
    ) {
      const committed = await storage.conditionalBatch(
        [{ key: KEYS.record(assetId), expectedValue: loaded.raw }],
        [{ type: 'delete', key: KEYS.record(assetId) }],
      );
      if (committed) {
        state.report.purgedTombstones.push(assetId);
        await internals.emit({
          type: 'asset.purged',
          assetId,
          revision: record.revision,
          state: record.state,
        });
      }
    }
  });
}

async function collectUploads(
  internals: AssetInternals,
  context: AssetWorkContext,
  state: CollectionState,
): Promise<void> {
  const { storage } = internals;
  for (const key of await context.track(storage.list(KEYS.uploadPrefix))) {
    const raw = await context.track(storage.get(key));
    if (raw === null) continue;
    const session = JSON.parse(raw) as UploadSessionRecord;
    if (session.state === 'open' && Date.parse(session.expiresAt) > state.now) continue;
    await internals.withLock(`upload:${session.uploadId}`, async () => {
      for (const chunk of await storage.list(KEYS.chunkPrefix(session.uploadId)))
        await storage.delete(chunk);
      await storage.delete(key);
    });
    state.report.purgedUploads.push(session.uploadId);
    await internals.emit({ type: 'asset.upload.purged', uploadId: session.uploadId });
  }
}

async function collectBlobs(
  internals: AssetInternals,
  context: AssetWorkContext,
  state: CollectionState,
): Promise<void> {
  const { storage } = internals;
  for (const key of await context.track(storage.list(KEYS.blobPrefix))) {
    const digest = key.slice(KEYS.blobPrefix.length);
    const owners = await context.track(storage.list(KEYS.ownerPrefix(digest)));
    if (owners.length > 0) continue;
    if (internals.leases.isLeased(digest)) {
      state.report.leasedBlobs.push(digest);
      continue;
    }
    await context.track(storage.delete(key));
    state.report.purgedBlobs.push(digest);
    await internals.emit({ type: 'asset.blob.purged', digest });
  }
}

export function startGarbageCollection(
  internals: AssetInternals,
): AssetWorkHandle<AssetGarbageCollectionReport> {
  return internals.registry.start<AssetGarbageCollectionReport>(
    { kind: 'garbage-collection', classify: (error) => classifyFailure(error) },
    async (context) => {
      const state: CollectionState = {
        now: internals.now(),
        report: {
          expired: [],
          purgedTombstones: [],
          purgedBlobs: [],
          purgedUploads: [],
          interruptedAdmissions: [],
          leasedBlobs: [],
        },
      };
      for (const key of await context.track(internals.storage.list(KEYS.recordPrefix))) {
        await collectRecord(internals, context, key.slice(KEYS.recordPrefix.length), state);
      }
      await collectUploads(internals, context, state);
      // Blobs last, so ownership released by expiry above is collected in the same pass.
      await collectBlobs(internals, context, state);
      return Object.freeze({
        expired: Object.freeze(state.report.expired),
        purgedTombstones: Object.freeze(state.report.purgedTombstones),
        purgedBlobs: Object.freeze(state.report.purgedBlobs),
        purgedUploads: Object.freeze(state.report.purgedUploads),
        interruptedAdmissions: Object.freeze(state.report.interruptedAdmissions),
        leasedBlobs: Object.freeze(state.report.leasedBlobs),
      });
    },
  );
}
