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
 * - a deletion's provider copies → deleted after the tombstone commits,
 *   best-effort; collection deletes an expired asset's copies, and retries
 *   any copy a provider did not confirm;
 * - any terminal record with no hold and no provider copy left to delete →
 *   purged once its `tombstoneUntil` passes; a hold keeps the record (a quarantined asset under legal hold,
 *   say) until the hold is released;
 * - `pending` with no live admission in this process → `rejected`
 *   (`interrupted`) — the recovery path for an admission a failed process
 *   left behind;
 * - a blob with no owner key and no lease → purged; an expired upload
 *   session → purged with its chunks; a chunk with no session → purged.
 */
import {
  AssetAdmissionError,
  AssetHeldError,
  AssetUnavailableError,
  AssetWorkAbortedError,
} from './errors';
import { type AssetInternals, classifyFailure } from './internals';
import type { AssetWorkContext } from './operation';
import { readVerifiedBytes } from './admission';
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
import type { UploadSessionRecord } from './uploads';

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
      const refuseIfAborted = () => {
        if (context.signal.aborted) throw new AssetWorkAbortedError('The deletion was aborted.');
      };
      refuseIfAborted();
      const record = await transition(
        internals,
        assetId,
        (current) => {
          refuseIfAborted();
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
          const extra =
            current.state === 'available' ? await releaseOwnership(internals, current) : [];
          // The last point an abort is honoured: once the tombstone write starts, the deletion stands.
          refuseIfAborted();
          return {
            next: bump(internals, current, {
              state: 'deleted',
              deletedAt: now,
              tombstoneUntil: internals.isoAfter(internals.policy.tombstoneRetentionMilliseconds),
            }),
            extra,
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
      // The deletion is done once the tombstone commits; provider copies are cleanup that collection retries.
      const latest = await deleteProviderCopies(internals, context, record);
      return projectFor(latest, principal);
    },
  );
}

function deletableCopies(internals: AssetInternals, record: AssetRecord): AssetProviderCopy[] {
  return record.providerCopies.filter(
    (copy) => internals.ports.providers?.[copy.provider]?.delete !== undefined,
  );
}

/**
 * Deletion of a tombstone's provider copies. Each copy a provider confirms
 * deleting is removed from the record (one revision per copy). A copy whose
 * deletion fails stays listed on the privileged projection and the work
 * still completes — the asset is deleted — while garbage collection retries
 * the copy before it will purge the tombstone. A targeted abort settles the
 * work as aborted (the tombstone stands; collection retries what is left).
 * Returns the latest record.
 */
async function deleteProviderCopies(
  internals: AssetInternals,
  context: AssetWorkContext,
  record: AssetRecord,
): Promise<AssetRecord> {
  let latest = record;
  for (const copy of record.providerCopies) {
    const transport = internals.ports.providers?.[copy.provider];
    if (!transport?.delete) continue;
    try {
      await context.track(
        transport.delete({ providerFileId: copy.providerFileId, signal: context.signal }),
      );
    } catch (error) {
      if (context.signal.aborted) throw error;
      continue;
    }
    latest = await internals.withLock(record.assetId, async () => {
      const loaded = await loadRecord(internals.storage, record.assetId);
      if (!loaded) return latest;
      const next = bump(internals, loaded.record, {
        providerCopies: loaded.record.providerCopies.filter(
          (entry) =>
            entry.provider !== copy.provider || entry.providerFileId !== copy.providerFileId,
        ),
      });
      await replaceRecord(internals.storage, loaded, next);
      return next;
    });
    await internals.emit({
      type: 'asset.provider-copy.deleted',
      assetId: record.assetId,
      revision: latest.revision,
      state: latest.state,
      provider: copy.provider,
    });
  }
  return latest;
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
      let committed: AssetRecord;
      try {
        committed = await transition(
          internals,
          assetId,
          (current) => requireAvailable(authorize(current, assetId, principal)),
          ({ record: current }) => ({
            next: bump(internals, current, { providerCopies: [...current.providerCopies, copy] }),
          }),
        );
      } catch (error) {
        // The copy exists at the provider but no record will list it (the asset was deleted or
        // expired meanwhile, or the write failed), so nothing could clean it up later: delete it now.
        await transport
          .delete?.({ providerFileId: copy.providerFileId, signal: new AbortController().signal })
          .catch(() => undefined);
        throw error;
      }
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

/**
 * Deletes (or retries deleting) the provider copies a deleted or expired
 * record still lists — either way the asset is gone, so its copies are too.
 */
async function retryProviderCopies(
  internals: AssetInternals,
  context: AssetWorkContext,
  assetId: string,
): Promise<void> {
  const loaded = await context.track(loadRecord(internals.storage, assetId));
  const state = loaded?.record.state;
  if (!loaded || (state !== 'deleted' && state !== 'expired')) return;
  if (deletableCopies(internals, loaded.record).length === 0) return;
  await deleteProviderCopies(internals, context, loaded.record);
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
      record.holds.length === 0 &&
      // Any listed copy keeps the record, even one no transport can delete now:
      // purging it would lose the provider file id that cleanup needs later.
      record.providerCopies.length === 0 &&
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

/** Deletes a session's chunks and the session itself, under the session's lock, if it is still collectible; reports whether anything was deleted. */
async function purgeUpload(
  internals: AssetInternals,
  uploadId: string,
  collectible: (session: UploadSessionRecord | undefined) => boolean,
): Promise<boolean> {
  const { storage } = internals;
  return internals.withLock(`upload:${uploadId}`, async () => {
    const raw = await storage.get(KEYS.upload(uploadId));
    const session = raw === null ? undefined : (JSON.parse(raw) as UploadSessionRecord);
    if (!collectible(session)) return false;
    const chunks = await storage.list(KEYS.chunkPrefix(uploadId));
    for (const chunk of chunks) await storage.delete(chunk);
    if (session) await storage.delete(KEYS.upload(uploadId));
    // Nothing to report when a completion retired the session between the listing and this lock.
    return session !== undefined || chunks.length > 0;
  });
}

/**
 * Purges expired upload sessions with their chunks, then any chunk whose
 * session no longer exists (a chunk a failed process left behind). Each
 * purge re-reads the session under its lock, so a session renewed, appended
 * to, or completed since the listing is left alone.
 */
async function collectUploads(
  internals: AssetInternals,
  context: AssetWorkContext,
  state: CollectionState,
): Promise<void> {
  const { storage } = internals;
  const expired = (session: UploadSessionRecord | undefined) =>
    session !== undefined && Date.parse(session.expiresAt) <= state.now;
  for (const key of await context.track(storage.list(KEYS.uploadPrefix))) {
    const uploadId = key.slice(KEYS.uploadPrefix.length);
    if (await context.track(purgeUpload(internals, uploadId, expired))) {
      state.report.purgedUploads.push(uploadId);
      await internals.emit({ type: 'asset.upload.purged', uploadId });
    }
  }
  const orphaned = new Set<string>();
  for (const key of await context.track(storage.list(KEYS.chunkRootPrefix))) {
    const rest = key.slice(KEYS.chunkRootPrefix.length);
    orphaned.add(rest.slice(0, rest.lastIndexOf(':')));
  }
  for (const uploadId of orphaned) {
    if (await context.track(purgeUpload(internals, uploadId, (session) => session === undefined))) {
      state.report.purgedUploads.push(uploadId);
      await internals.emit({ type: 'asset.upload.purged', uploadId });
    }
  }
}

/**
 * Purges every blob no asset owns and no lease protects. Each decision and
 * delete runs under the blob's lock — the one an admission's commit stages
 * the blob under — so a commit reusing a blob never observes it present and
 * then loses it to a delete already in flight. Leases and locks are
 * in-process: collection assumes one collecting process per storage.
 */
async function collectBlobs(
  internals: AssetInternals,
  context: AssetWorkContext,
  state: CollectionState,
): Promise<void> {
  const { storage } = internals;
  for (const key of await context.track(storage.list(KEYS.blobPrefix))) {
    const digest = key.slice(KEYS.blobPrefix.length);
    const outcome = await context.track(
      internals.withLock(key, async () => {
        const owners = await storage.list(KEYS.ownerPrefix(digest));
        if (owners.length > 0) return 'owned';
        if (internals.leases.isLeased(digest)) return 'leased';
        await storage.delete(key);
        return 'purged';
      }),
    );
    if (outcome === 'leased') state.report.leasedBlobs.push(digest);
    if (outcome !== 'purged') continue;
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
        const assetId = key.slice(KEYS.recordPrefix.length);
        await retryProviderCopies(internals, context, assetId);
        await collectRecord(internals, context, assetId, state);
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
