import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from '../../src/async-assertion-test-helpers';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import {
  createManualDeadlineTiming,
  createTestStore,
  requestContext,
} from './with-idempotency-fixtures';

describe('withIdempotency lease renewal', () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    cache = createToolResultCache({ store: createTestStore(), defaultTTL: 60_000 });
  });

  it('renews an active lease and rejects completion after losing the fence', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = createTool({
      name: 'slow-fenced',
      description: 'Slow fenced execution',
      version: '1.0.0',
      input: z.object({ value: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        await blocked;
        return value;
      },
    });
    let renewals = 0;
    const renewingCache: ToolResultCache = {
      ...cache,
      async renewStarted(key, attemptId, leaseExpiresAt, observedAt) {
        renewals++;
        return cache.renewStarted(key, attemptId, leaseExpiresAt, observedAt);
      },
    };
    const wrapped = withIdempotency(tool, {
      cache: renewingCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 10,
      maximumExecutionDurationMs: 100,
    });
    const timing = createManualDeadlineTiming();
    const execution = wrapped.execute({ value: 7 }, { requestContext, ...timing.options });
    await timing.firstTimeoutScheduled;
    expect(timing.scheduledDelays()).toEqual([5, 100]);
    timing.setNow(5);
    timing.fireTimeout();
    await Promise.resolve();
    await Promise.resolve();
    expect(renewals).toBeGreaterThan(0);
    release();
    expect(await execution).toBe(7);

    let lostFenceCallbackRuns = 0;
    const lostFenceCache: ToolResultCache = {
      ...cache,
      async renewStarted() {
        return false;
      },
    };
    const lostFenceTool = createTool({
      name: 'lost-fence',
      description: 'Loses its fence',
      version: '1.0.0',
      input: z.object({ value: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        lostFenceCallbackRuns += 1;
        return value;
      },
    });
    const lostFence = withIdempotency(lostFenceTool, {
      cache: lostFenceCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 10,
      maximumExecutionDurationMs: 100,
    });
    const lostExecution = lostFence.execute({ value: 8 }, { requestContext });
    await expectPromiseToReject(lostExecution, (error) =>
      expect(() => {
        throw error;
      }).toThrow('lost its execution fence'),
    );
    expect(lostFenceCallbackRuns).toBe(0);
  });
});
