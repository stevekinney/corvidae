/**
 * Started-work handles for asynchronous asset operations (COR-794).
 *
 * Every upload, fetch, scan, transform, metadata extraction, provider
 * transfer, deletion, and garbage collection — and the admission that
 * composes several of them — runs as one {@link AssetWorkHandle} with the
 * universal started-work capabilities (`documentation/operative-type-safe-api.md`
 * § "Required capabilities", the same five every Bureau started-work handle exposes):
 * a cached immutable `snapshot()`, non-consuming `subscribeSnapshot()`,
 * idempotent targeted `abort()`, a never-rejecting `result()`, and a
 * never-rejecting, memoized `closed()` cleanup acknowledgement using
 * operative's `CleanupAcknowledgement`.
 *
 * Abort is prompt and honest. A work body routes every await on a port or
 * storage call through `context.track()`, which races the call against the
 * work's signal: aborting settles `result()` as `aborted` at once, while the
 * underlying call — which may not honor the signal — keeps running.
 * `closed()` waits for every such call (and every child's own `closed()`)
 * to genuinely settle before acknowledging cleanup, so "aborted" and
 * "cleaned up" are never conflated.
 *
 * Each handle's cleanup is tracked with `RuntimeServices.deferred` under the
 * label `asset-<kind>`, and the registry lists every handle whose cleanup
 * has not yet settled — the public surface `assertBureauQuiescent` reads.
 */
import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { CleanupAcknowledgement, ClosedOptions } from '@lostgradient/operative';

import { AssetAdmissionError, AssetWorkAbortedError } from './errors';
import type {
  AssetRejection,
  AssetWorkHandle,
  AssetWorkKind,
  AssetWorkResult,
  AssetWorkSnapshot,
} from './types';

export interface AssetWorkContext {
  readonly workId: string;
  readonly signal: AbortSignal;
  /** Races `promise` against this work's abort, and keeps `closed()` waiting until it truly settles. */
  readonly track: <T>(promise: Promise<T>) => Promise<T>;
  /**
   * Runs `body` as a parent-owned child handle and returns its value. A
   * failed or aborted child throws {@link AssetAdmissionError} carrying the
   * child's rejection (`aborted` for an aborted child).
   */
  readonly child: <T>(
    kind: AssetWorkKind,
    body: (context: AssetWorkContext) => Promise<T>,
    classify: (error: unknown) => AssetRejection,
  ) => Promise<T>;
}

export interface StartWorkOptions {
  readonly kind: AssetWorkKind;
  readonly assetId?: string | undefined;
  readonly owner?: string | undefined;
  readonly parentId?: string | undefined;
  /** Maps a body failure onto a rejection; abort is classified before this is consulted. */
  readonly classify: (error: unknown) => AssetRejection;
}

export interface WorkEvents {
  started(snapshot: AssetWorkSnapshot): void;
  settled(snapshot: AssetWorkSnapshot): void;
}

export interface AssetWorkRegistry {
  start<T>(
    options: StartWorkOptions,
    body: (context: AssetWorkContext) => Promise<T>,
  ): AssetWorkHandle<T>;
  get(workId: string): AssetWorkHandle | undefined;
  active(): readonly AssetWorkSnapshot[];
  /** Aborts every handle still pending and awaits every outstanding cleanup. */
  abortAll(reason: string): Promise<{
    aborted: string[];
    acknowledgements: { workId: string; acknowledgement: CleanupAcknowledgement }[];
  }>;
}

function abortRace<T>(promise: Promise<T>, signal: AbortSignal, reason: () => string): Promise<T> {
  if (signal.aborted) return Promise.reject(new AssetWorkAbortedError(reason()));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AssetWorkAbortedError(reason()));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function rejectionFromChild(result: AssetWorkResult<unknown>): AssetAdmissionError | undefined {
  if (result.outcome === 'failed') {
    return new AssetAdmissionError(result.rejection.code, result.rejection.message);
  }
  if (result.outcome === 'aborted') {
    return new AssetAdmissionError('aborted', `A child operation was aborted: ${result.reason}`);
  }
  return undefined;
}

export function createAssetWorkRegistry(
  runtime: RuntimeServices,
  events: WorkEvents,
): AssetWorkRegistry {
  const handles = new Map<
    string,
    { handle: AssetWorkHandle<unknown>; snapshot: () => AssetWorkSnapshot }
  >();

  function start<T>(
    options: StartWorkOptions,
    body: (context: AssetWorkContext) => Promise<T>,
  ): AssetWorkHandle<T> {
    const workId = runtime.identifiers.next('asset-work');
    const startedAt = runtime.clock.nowISO();
    const controller = new AbortController();
    let abortReason = 'aborted';
    const inFlight = new Set<Promise<unknown>>();
    const observers = new Set<(snapshot: AssetWorkSnapshot<T>) => void>();
    let terminalObserverFailed = false;

    let snapshot: AssetWorkSnapshot<T> = Object.freeze({
      id: workId,
      kind: `asset-${options.kind}` as const,
      workKind: options.kind,
      assetId: options.assetId,
      parentId: options.parentId,
      owner: options.owner,
      startedAt,
      revision: 1,
      status: 'pending',
      lastTransitionAt: startedAt,
      projection: 'privileged',
      ownership: options.parentId === undefined ? 'independent' : 'parent-owned',
      detached: false,
      durability: 'process-local',
      cancellable: true,
    });

    function track<P>(promise: Promise<P>): Promise<P> {
      const settled = promise.then(
        () => undefined,
        () => undefined,
      );
      inFlight.add(settled);
      void settled.then(() => inFlight.delete(settled));
      return abortRace(promise, controller.signal, () => abortReason);
    }

    const context: AssetWorkContext = {
      workId,
      signal: controller.signal,
      track,
      child: async <C>(
        kind: AssetWorkKind,
        childBody: (childContext: AssetWorkContext) => Promise<C>,
        classify: (error: unknown) => AssetRejection,
      ): Promise<C> => {
        // An aborted parent never starts a child: an abort listener added to an already-aborted signal would never fire.
        if (controller.signal.aborted) throw new AssetWorkAbortedError(abortReason);
        const childHandle = start<C>(
          { kind, assetId: options.assetId, owner: options.owner, parentId: workId, classify },
          childBody,
        );
        const unlink = () => childHandle.abort(abortReason);
        controller.signal.addEventListener('abort', unlink, { once: true });
        // Tracked so this work's own `closed()` waits for the child's cleanup too.
        track(childHandle.closed()).catch(() => undefined);
        const result = await childHandle.result();
        controller.signal.removeEventListener('abort', unlink);
        if (controller.signal.aborted) throw new AssetWorkAbortedError(abortReason);
        const rejection = rejectionFromChild(result);
        if (rejection) throw rejection;
        return (result as Extract<AssetWorkResult<C>, { outcome: 'completed' }>).value;
      },
    };

    const handle: AssetWorkHandle<T> = {
      workId,
      snapshot: () => snapshot,
      subscribeSnapshot(observer, subscribeOptions) {
        if (subscribeOptions?.signal?.aborted) return () => {};
        observers.add(observer);
        const unsubscribe = () => observers.delete(observer);
        subscribeOptions?.signal?.addEventListener('abort', unsubscribe, { once: true });
        observer(snapshot);
        return () => {
          unsubscribe();
        };
      },
      abort(reason = 'aborted') {
        if (snapshot.status === 'settled' || controller.signal.aborted) return;
        abortReason = reason;
        controller.abort(new AssetWorkAbortedError(reason));
      },
      result: () => resultPromise,
      closed(closedOptions?: ClosedOptions) {
        const signal = closedOptions?.signal;
        if (!signal) return cleanupPromise;
        if (signal.aborted)
          return Promise.resolve({ status: 'unresolved', reason: 'timed-out' } as const);
        return new Promise<CleanupAcknowledgement>((resolve) => {
          const onAbort = () => resolve({ status: 'unresolved', reason: 'timed-out' });
          signal.addEventListener('abort', onAbort, { once: true });
          void cleanupPromise
            .then(resolve)
            .finally(() => signal.removeEventListener('abort', onAbort));
        });
      },
    };

    // Registered and announced before the body runs, so a `started` event always precedes anything the body emits.
    handles.set(workId, { handle, snapshot: () => snapshot });
    events.started(snapshot);

    const resultPromise: Promise<AssetWorkResult<T>> = (async () => {
      try {
        const value = await body(context);
        return { outcome: 'completed', value } as const;
      } catch (error) {
        if (controller.signal.aborted) return { outcome: 'aborted', reason: abortReason } as const;
        return { outcome: 'failed', rejection: options.classify(error) } as const;
      }
    })().then((result) => {
      const settledAt = runtime.clock.nowISO();
      snapshot = Object.freeze({
        ...snapshot,
        revision: snapshot.revision + 1,
        status: 'settled',
        lastTransitionAt: settledAt,
        cancellable: false,
        result: Object.freeze(result),
      });
      for (const observer of observers) {
        try {
          observer(snapshot);
        } catch {
          terminalObserverFailed = true;
        }
      }
      events.settled(snapshot);
      return result;
    });

    const cleanupPromise: Promise<CleanupAcknowledgement> = (async () => {
      await resultPromise;
      while (inFlight.size > 0) await Promise.all(inFlight);
      return terminalObserverFailed
        ? ({
            status: 'failed',
            error: new Error('A snapshot observer threw on the terminal transition.'),
          } as const)
        : ({ status: 'completed' } as const);
    })().finally(() => handles.delete(workId));
    runtime.deferred.track(cleanupPromise, `asset-${options.kind}`);

    return handle;
  }

  return {
    start,
    get: (workId) => handles.get(workId)?.handle,
    active: () => [...handles.values()].map((entry) => entry.snapshot()),
    async abortAll(reason) {
      const entries = [...handles.values()];
      const aborted: string[] = [];
      for (const { handle, snapshot } of entries) {
        if (snapshot().status === 'pending') {
          aborted.push(handle.workId);
          handle.abort(reason);
        }
      }
      const acknowledgements = await Promise.all(
        entries.map(async ({ handle }) => ({
          workId: handle.workId,
          acknowledgement: await handle.closed(),
        })),
      );
      return { aborted, acknowledgements };
    },
  };
}
