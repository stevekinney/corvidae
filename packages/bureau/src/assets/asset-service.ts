/**
 * `createAssetService` — Bureau's managed-asset owner (COR-794).
 *
 * One service per Bureau (composed through `BureauOptions.assets`, reachable
 * as `bureau.assets`, and shut down by `bureau.shutdown()` as the `assets`
 * owner), over injected storage, policy, and ports. See `types.ts` for the
 * contract, `admission.ts` for the admission pipeline, and `lifecycle.ts`
 * for every later transition.
 *
 * Authorization. Every operation and both projections check the asset's
 * persisted authorization (owner plus readers) first; a principal it does
 * not reach is told the asset does not exist. The privileged projection and
 * holds additionally require `principal.privileged` — a capability layered
 * on top of resource authorization, never a substitute for it. Operations
 * that return a descriptor return the projection the principal may see.
 *
 * Shutdown. After `shutdown()` every operation refuses with
 * `AssetServiceClosedError`, except looking up, listing, and aborting work,
 * subscribing to events, and reading audit records.
 *
 * Events and audit. Every event is delivered synchronously to subscribers
 * and persisted as an audit record under a monotonic sequence that
 * continues across restarts regardless of the wall clock. Events carry
 * identifiers, states, codes, digests, and URL origins only.
 */
import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import {
  beginAdmission,
  createAggregateBudget,
  preflightAdmission,
  readVerifiedBytes,
} from './admission';
import { AssetServiceClosedError, AssetUnavailableError } from './errors';
import {
  type AssetEventInput,
  type AssetInternals,
  createDigestLeases,
  createKeyedLock,
} from './internals';
import * as lifecycle from './lifecycle';
import { createAssetWorkRegistry } from './operation';
import { resolveAssetPolicy } from './policy';
import {
  authorize,
  authorizePrivileged,
  KEYS,
  loadRecord,
  projectFor,
  toGeneralDescriptor,
} from './records';
import type { AssetStorage } from './storage';
import type {
  AssetAdmission,
  AssetAuditRecord,
  AssetEvent,
  AssetPolicyInput,
  AssetPorts,
  AssetService,
  ManagedAssetSource,
  ResolvedAsset,
} from './types';
import * as uploads from './uploads';

export interface AssetServiceOptions {
  readonly storage: AssetStorage;
  /** Defaults to real globals. Bureau passes its own composed runtime services. */
  readonly runtime?: RuntimeServices | undefined;
  readonly policy?: AssetPolicyInput | undefined;
  readonly ports?: AssetPorts | undefined;
  /** Arms a `RuntimeServices.timers` interval that starts garbage collection; cleared by `shutdown()`. */
  readonly garbageCollectionIntervalMilliseconds?: number | undefined;
}

/** `AssetServiceOptions` as `BureauOptions.assets` takes them — Bureau supplies the runtime. */
export type BureauAssetOptions = Omit<AssetServiceOptions, 'runtime'>;

/** The `managed-asset` `ContentSource` naming a descriptor's asset at its revision. */
export function managedAssetSource(descriptor: {
  readonly assetId: string;
  readonly revision: number;
}): ManagedAssetSource {
  return { kind: 'managed-asset', assetId: descriptor.assetId, revision: descriptor.revision };
}

/**
 * Event delivery and the durable audit log. The sequence resumes from the
 * highest persisted audit key, so it keeps increasing across restarts even
 * when the wall clock moves backwards. Every audit write is tracked (and
 * registered with `RuntimeServices.deferred` as `asset-audit-write`) so
 * `shutdown()` awaits it rather than leaving it in flight.
 */
function createAuditLog(
  storage: AssetStorage,
  listeners: Set<(event: AssetEvent) => void>,
  runtime: RuntimeServices,
) {
  let counter = 0;
  const pending = new Set<Promise<void>>();

  async function persist(event: AssetEvent): Promise<void> {
    try {
      await storage.set(KEYS.audit(event.sequence), JSON.stringify(event));
    } catch {
      // Audit persistence is best-effort: the transition it records has already committed.
    }
  }

  return {
    /** Resumes the sequence after the highest persisted audit key. */
    async initialize(): Promise<void> {
      const keys = await storage.list(KEYS.auditPrefix);
      const last = keys.at(-1);
      counter = last === undefined ? 0 : Number(last.slice(KEYS.auditPrefix.length));
    },
    /** Delivers to subscribers synchronously, then persists. */
    emit(input: AssetEventInput): Promise<void> {
      const event: AssetEvent = Object.freeze({
        ...input,
        at: runtime.clock.nowISO(),
        sequence: ++counter,
      });
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // A throwing subscriber must not break the operation that emitted.
        }
      }
      const written = persist(event);
      pending.add(written);
      runtime.deferred.track(written, 'asset-audit-write');
      void written.then(() => pending.delete(written));
      return written;
    },
    async drain(): Promise<void> {
      while (pending.size > 0) await Promise.all(pending);
    },
    async records(): Promise<readonly AssetAuditRecord[]> {
      const records: AssetAuditRecord[] = [];
      for (const key of await storage.list(KEYS.auditPrefix)) {
        const raw = await storage.get(key);
        if (raw !== null) records.push(Object.freeze(JSON.parse(raw) as AssetAuditRecord));
      }
      return Object.freeze(records);
    },
  };
}

export async function createAssetService(options: AssetServiceOptions): Promise<AssetService> {
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const storage = options.storage;
  const policy = resolveAssetPolicy(options.policy);
  const listeners = new Set<(event: AssetEvent) => void>();
  const audit = createAuditLog(storage, listeners, runtime);
  await audit.initialize();
  let closed = false;

  const registry = createAssetWorkRegistry(runtime, {
    started: (snapshot) => {
      void audit.emit({
        type: 'asset.work.started',
        assetId: snapshot.assetId,
        workId: snapshot.id,
        workKind: snapshot.workKind,
        principal: snapshot.owner,
      });
    },
    settled: (snapshot) => {
      void audit.emit({
        type: 'asset.work.settled',
        assetId: snapshot.assetId,
        workId: snapshot.id,
        workKind: snapshot.workKind,
        outcome: snapshot.result?.outcome,
        code: snapshot.result?.outcome === 'failed' ? snapshot.result.rejection.code : undefined,
      });
    },
  });

  const internals: AssetInternals = {
    storage,
    policy,
    ports: options.ports ?? {},
    runtime,
    registry,
    leases: createDigestLeases(),
    withLock: createKeyedLock(),
    pendingAdmissions: new Set(),
    emit: (event) => audit.emit(event),
    now: () => runtime.clock.now(),
    nowIso: () => runtime.clock.nowISO(),
    isoAfter: (milliseconds) => new Date(runtime.clock.now() + milliseconds).toISOString(),
  };

  function open(): void {
    if (closed) throw new AssetServiceClosedError();
  }

  // Calls that passed `open()` but have not yet registered work or finished writing: shutdown
  // waits for them, so nothing they start or commit lands after it returns.
  const inFlightCalls = new Set<Promise<unknown>>();
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    open();
    const call = operation();
    inFlightCalls.add(call);
    try {
      return await call;
    } finally {
      inFlightCalls.delete(call);
    }
  }

  let collectionTimer: unknown;
  const interval = options.garbageCollectionIntervalMilliseconds;
  if (interval !== undefined) {
    collectionTimer = runtime.timers.setInterval(() => {
      const running = registry
        .active()
        .some((snapshot) => snapshot.workKind === 'garbage-collection');
      if (!closed && !running) lifecycle.startGarbageCollection(internals);
    }, interval);
  }

  return {
    durability: storage.durability,
    policy,

    admit: (request, principal) =>
      guarded(() => beginAdmission(internals, principal, request, undefined, 0)),

    admitAll: (requests, principal) =>
      guarded(async () => {
        // Every part is refused or accepted up front, so a refusal never strands parts already started.
        for (const request of requests)
          await preflightAdmission(internals, principal, request.source);
        const budget = createAggregateBudget(policy.limits, requests.length);
        const admissions: AssetAdmission[] = [];
        try {
          for (const [slot, request] of requests.entries()) {
            admissions.push(
              await beginAdmission(internals, principal, request, budget, slot, {
                preflighted: true,
              }),
            );
          }
        } catch (error) {
          // A later part failed to persist: the caller gets no handles, so the started parts are aborted.
          for (const admission of admissions) admission.work.abort('admitAll failed');
          throw error;
        }
        return admissions;
      }),

    beginUpload: (principal, request) =>
      guarded(() => uploads.beginUpload(internals, principal, request)),
    appendUpload: (uploadId, principal, bytes) =>
      guarded(() => uploads.appendUpload(internals, uploadId, principal, bytes)),
    abortUpload: (uploadId, principal) =>
      guarded(() => uploads.abortUpload(internals, uploadId, principal)),
    inspectUpload: (uploadId, principal) =>
      guarded(() => uploads.inspectUpload(internals, uploadId, principal)),
    completedUploadAssetId: (uploadId, principal) =>
      guarded(() => uploads.completedUploadAssetId(internals, uploadId, principal)),

    async inspect(assetId, principal, inspectOptions) {
      open();
      const projection = inspectOptions?.projection ?? 'general';
      const loaded = await loadRecord(storage, assetId);
      const record =
        projection === 'privileged'
          ? authorizePrivileged(
              loaded?.record,
              assetId,
              principal,
              'read the privileged projection of',
            )
          : authorize(loaded?.record, assetId, principal);
      return projectFor(record, principal, projection);
    },

    async resolve(reference, principal): Promise<ResolvedAsset> {
      open();
      const loaded = await loadRecord(storage, reference.assetId);
      const record = authorize(loaded?.record, reference.assetId, principal);
      if (reference.revision !== undefined && reference.revision > record.revision) {
        throw new AssetUnavailableError(reference.assetId, record.state);
      }
      if (record.state !== 'available')
        throw new AssetUnavailableError(reference.assetId, record.state);
      const descriptor = toGeneralDescriptor(record, principal);
      if (record.custody === 'provider-fetch') {
        const resolved: ResolvedAsset = {
          descriptor,
          content: { kind: 'provider-fetch', url: record.providerFetchUrl ?? '' },
        };
        return Object.freeze(resolved);
      }
      const bytes = await readVerifiedBytes(internals, record);
      const resolved: ResolvedAsset = { descriptor, content: { kind: 'bytes', bytes } };
      return Object.freeze(resolved);
    },

    retain: (assetId, principal, reference) =>
      guarded(() => lifecycle.retain(internals, assetId, principal, reference)),
    release: (assetId, principal, holderId) =>
      guarded(() => lifecycle.release(internals, assetId, principal, holderId)),
    heldClaims: ({ holderPrefix }) => guarded(() => lifecycle.heldClaims(internals, holderPrefix)),
    releaseClaim: (assetId, principal, holderId) =>
      guarded(async () => {
        const released = await lifecycle.releaseHolder(internals, assetId, principal, holderId);
        return released.removed;
      }),
    placeHold: (assetId, principal, hold) =>
      guarded(() => lifecycle.placeHold(internals, assetId, principal, hold)),
    releaseHold: (assetId, principal, holdId) =>
      guarded(() => lifecycle.releaseHold(internals, assetId, principal, holdId)),
    expire: (assetId, principal) => guarded(() => lifecycle.expire(internals, assetId, principal)),

    delete(assetId, principal) {
      open();
      return lifecycle.startDeletion(internals, assetId, principal);
    },

    transform: (assetId, principal, request) =>
      guarded(() =>
        beginAdmission(
          internals,
          principal,
          { source: { kind: 'derived', sourceAssetId: assetId, transform: request.transform } },
          undefined,
          0,
        ),
      ),

    transferToProvider(assetId, principal, request) {
      open();
      return lifecycle.startProviderTransfer(internals, assetId, principal, request.provider);
    },

    collectGarbage() {
      open();
      return lifecycle.startGarbageCollection(internals);
    },

    work: (workId) => registry.get(workId),
    abort(workId, reason) {
      const handle = registry.get(workId);
      if (!handle || handle.snapshot().status !== 'pending') return false;
      handle.abort(reason);
      return true;
    },
    activeWork: () => registry.active(),
    activeTimers: () =>
      collectionTimer === undefined ? [] : ['asset-garbage-collection-interval'],

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    auditRecords: () => audit.records(),

    async shutdown() {
      closed = true;
      if (collectionTimer !== undefined) {
        runtime.timers.clearInterval(collectionTimer);
        collectionTimer = undefined;
      }
      // Work those calls register is then aborted with the rest.
      await Promise.allSettled(inFlightCalls);
      const report = await registry.abortAll('shutdown');
      await audit.drain();
      return report;
    },
  };
}
