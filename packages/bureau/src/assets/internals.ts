/**
 * The shared state the asset service's modules operate on (COR-794):
 * storage, policy, ports, runtime services, the started-work registry,
 * digest leases, per-key locks, and event/audit emission. `asset-service.ts`
 * builds one of these; `admission.ts` and `lifecycle.ts` only consume it.
 */
import type { RuntimeServices } from '@lostgradient/lifecycle';

import {
  AssetAdmissionError,
  AssetIntegrityError,
  AssetNotFoundError,
  AssetUnavailableError,
  AssetWorkAbortedError,
} from './errors';
import type { AssetWorkRegistry } from './operation';
import type { AssetStorage } from './storage';
import type { AssetEvent, AssetPolicy, AssetPorts, AssetRejection } from './types';

export type AssetEventInput = Omit<AssetEvent, 'at' | 'sequence'>;

/**
 * In-process leases on a digest's blob. A resolution reading a blob, or an
 * admission staging one before its commit, holds a lease; garbage collection
 * never purges a leased blob, even one no asset owns any more.
 */
export interface DigestLeases {
  acquire(digest: string): () => void;
  isLeased(digest: string): boolean;
}

export function createDigestLeases(): DigestLeases {
  const counts = new Map<string, number>();
  return {
    acquire(digest) {
      counts.set(digest, (counts.get(digest) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (counts.get(digest) ?? 1) - 1;
        if (remaining <= 0) counts.delete(digest);
        else counts.set(digest, remaining);
      };
    },
    isLeased: (digest) => (counts.get(digest) ?? 0) > 0,
  };
}

/** Serializes the bodies run under one key, in call order, within this process. */
export type KeyedLock = <T>(key: string, body: () => Promise<T>) => Promise<T>;

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, body: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(body, body);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

export interface AssetInternals {
  readonly storage: AssetStorage;
  readonly policy: AssetPolicy;
  readonly ports: AssetPorts;
  readonly runtime: RuntimeServices;
  readonly registry: AssetWorkRegistry;
  readonly leases: DigestLeases;
  readonly withLock: KeyedLock;
  /** Asset ids whose admission work is live in this process — never treated as interrupted. */
  readonly pendingAdmissions: Set<string>;
  /** Delivers to listeners synchronously and persists an audit record. Never throws. */
  readonly emit: (event: AssetEventInput) => Promise<void>;
  readonly now: () => number;
  readonly nowIso: () => string;
  readonly isoAfter: (milliseconds: number) => string;
}

/**
 * Classifies a failure into a rejection whose message is ours, never the
 * failing component's (which may echo a URL, a path, or content).
 */
export function classifyFailure(
  error: unknown,
  fallback: AssetRejection['code'] = 'storage-failure',
): AssetRejection {
  if (error instanceof AssetAdmissionError) return error.rejection;
  if (error instanceof AssetWorkAbortedError)
    return { code: 'aborted', message: 'The operation was aborted.' };
  if (
    error instanceof AssetNotFoundError ||
    error instanceof AssetUnavailableError ||
    error instanceof AssetIntegrityError
  ) {
    return { code: 'source-not-available', message: 'The source asset is not available.' };
  }
  const messages: Partial<Record<AssetRejection['code'], string>> = {
    'storage-failure': 'A storage operation failed.',
    'fetch-failed': 'The host fetch failed.',
    'provider-transfer-failed': 'The provider transfer failed.',
    'transform-failed': 'The transform failed.',
    'safety-gate-error': 'A safety gate failed to return a verdict.',
    'metadata-extraction-failed': 'Metadata extraction failed.',
  };
  return { code: fallback, message: messages[fallback] ?? 'The operation failed.' };
}
