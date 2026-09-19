import { createManualRuntimeServices, type ManualRuntimeServices } from '@corvidae/lifecycle';
import { beforeEach, describe, expect, it } from 'bun:test';

import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import type { ToolResultCache } from '../../src/idempotency/types';

/**
 * Minimal in-memory KeyValueStore for testing without depending on the storage package.
 */
function createTestStore() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix: string) =>
      [...map.keys()].filter((key) => key.startsWith(prefix)).toSorted(),
    _map: map,
  };
}

describe('createToolResultCache', () => {
  let store: ReturnType<typeof createTestStore>;
  let cache: ToolResultCache;
  let runtime: ManualRuntimeServices;

  beforeEach(() => {
    store = createTestStore();
    runtime = createManualRuntimeServices();
    cache = createToolResultCache({ store, defaultTTL: 60_000, now: runtime.clock.now });
  });

  it('shares claim fencing across independent cache instances using one store', async () => {
    const first = createToolResultCache({ store, now: runtime.clock.now });
    const second = createToolResultCache({ store, now: runtime.clock.now });
    const execution = {
      status: 'started' as const,
      toolName: 'charge',
      startedAt: runtime.clock.now(),
      ttl: 60_000,
      attemptId: 'attempt-1',
    };
    const [left, right] = await Promise.all([
      first.claimStarted('shared', execution),
      second.claimStarted('shared', { ...execution, attemptId: 'attempt-2' }),
    ]);
    expect([left.outcome, right.outcome].filter((outcome) => outcome === 'claimed')).toHaveLength(
      1,
    );
  });

  it('shares claim fencing by resolved backing key across namespaces', async () => {
    const namespaced = createToolResultCache({ store, namespace: 'a', now: runtime.clock.now });
    const unnamespaced = createToolResultCache({ store, now: runtime.clock.now });
    const execution = {
      status: 'started' as const,
      toolName: 'charge',
      startedAt: runtime.clock.now(),
      ttl: 60_000,
    };

    const [left, right] = await Promise.all([
      namespaced.claimStarted('x', { ...execution, attemptId: 'namespaced' }),
      unnamespaced.claimStarted('a:x', { ...execution, attemptId: 'unnamespaced' }),
    ]);

    expect([left.outcome, right.outcome].filter((outcome) => outcome === 'claimed')).toHaveLength(
      1,
    );
    expect(await store.get('a:x')).toBeString();
  });

  it('renews and completes only for the current fencing token', async () => {
    await cache.claimStarted('fenced', {
      status: 'started',
      toolName: 'charge',
      startedAt: runtime.clock.now(),
      ttl: 60_000,
      attemptId: 'current',
      absoluteDeadline: runtime.clock.now() + 60_000,
    });
    expect(
      await cache.renewStarted(
        'fenced',
        'stale',
        runtime.clock.now() + 30_000,
        runtime.clock.now(),
      ),
    ).toBe(false);
    expect(
      await cache.renewStarted(
        'fenced',
        'current',
        runtime.clock.now() + 30_000,
        runtime.clock.now(),
      ),
    ).toBe(true);
    expect(
      await cache.completeStarted('fenced', 'stale', {
        result: 'late',
        toolName: 'charge',
        executedAt: runtime.clock.now(),
        ttl: 60_000,
      }),
    ).toBe(false);
    expect(
      await cache.completeStarted('fenced', 'current', {
        result: 'ok',
        toolName: 'charge',
        executedAt: runtime.clock.now(),
        ttl: 60_000,
      }),
    ).toBe(true);
    const completed = await cache.get('fenced');
    expect(completed?.result).toBe('ok');
  });

  it('uses the configured cache clock as the default completion observation time', async () => {
    const clockedCache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 60_000,
      now: () => 1_000,
    });
    await clockedCache.claimStarted('clocked-completion', {
      status: 'started',
      toolName: 'charge',
      startedAt: 500,
      ttl: 60_000,
      attemptId: 'clocked-attempt',
      absoluteDeadline: 1_500,
    });

    expect(
      await clockedCache.completeStarted('clocked-completion', 'clocked-attempt', {
        result: 'ok',
        toolName: 'charge',
        executedAt: 1_000,
        ttl: 60_000,
      }),
    ).toBe(true);
    expect(await clockedCache.get('clocked-completion')).toMatchObject({
      status: 'completed',
      result: 'ok',
    });
  });

  it('enforces absolute deadlines and unknown-attempt replacement fences', async () => {
    await cache.claimStarted('expired-fence', {
      status: 'started',
      toolName: 'charge',
      startedAt: runtime.clock.now() - 100,
      ttl: 60_000,
      attemptId: 'expired-attempt',
      leaseExpiresAt: runtime.clock.now() - 50,
      absoluteDeadline: runtime.clock.now() - 1,
    });
    expect(
      await cache.renewStarted(
        'expired-fence',
        'expired-attempt',
        runtime.clock.now() + 100,
        runtime.clock.now(),
      ),
    ).toBe(false);
    expect(
      await cache.completeStarted('expired-fence', 'expired-attempt', {
        result: 'late',
        toolName: 'charge',
        executedAt: runtime.clock.now(),
        ttl: 60_000,
      }),
    ).toBe(false);

    await cache.claimStarted('bounded-renewal', {
      status: 'started',
      toolName: 'charge',
      startedAt: runtime.clock.now(),
      ttl: 60_000,
      attemptId: 'bounded-attempt',
      absoluteDeadline: runtime.clock.now() + 10_000,
    });
    expect(
      await cache.renewStarted(
        'bounded-renewal',
        'bounded-attempt',
        runtime.clock.now() + 20_000,
        runtime.clock.now(),
      ),
    ).toBe(true);
    const boundedRenewal = await cache.getState('bounded-renewal');
    expect(
      boundedRenewal?.status === 'started' ? boundedRenewal.leaseExpiresAt : undefined,
    ).toBeLessThanOrEqual(runtime.clock.now() + 10_000);

    expect(await cache.deleteStarted('bounded-renewal', 'stale-attempt')).toBe(false);
    expect(
      await cache.replaceUnknownStarted(
        'bounded-renewal',
        'bounded-attempt',
        {
          status: 'started',
          toolName: 'charge',
          startedAt: runtime.clock.now(),
          ttl: 60_000,
          attemptId: 'replacement-attempt',
        },
        runtime.clock.now(),
      ),
    ).toBe(false);
    expect(await cache.deleteStarted('bounded-renewal', 'bounded-attempt')).toBe(true);
    expect(await cache.getState('bounded-renewal')).toBeUndefined();

    expect(
      await cache.replaceUnknownStarted(
        'bounded-renewal',
        'stale-attempt',
        {
          status: 'started',
          toolName: 'charge',
          startedAt: runtime.clock.now(),
          ttl: 60_000,
          attemptId: 'replacement',
        },
        runtime.clock.now(),
      ),
    ).toBe(false);
  });
});
