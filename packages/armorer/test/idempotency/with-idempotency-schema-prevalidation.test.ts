import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import {
  createManualDeadlineTiming,
  createTestStore,
  errorProperty,
  requestContext,
} from './with-idempotency-fixtures';

describe('withIdempotency', () => {
  let cache: ToolResultCache;
  let callCount: number;

  beforeEach(() => {
    callCount = 0;
    cache = createToolResultCache({ store: createTestStore(), defaultTTL: 60_000 });
  });

  it('cancels pre-aborted async schema prevalidation before reading the cache', async () => {
    let cacheReads = 0;
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        throw new Error('cache read should not run after pre-abort');
      },
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run after pre-abort');
      },
    };
    const tool = createTool({
      name: 'preaborted-prevalidation',
      description: 'Checks pre-aborted idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {
        await new Promise<void>(() => {});
      }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });
    const controller = new AbortController();
    controller.abort(new Error('already aborted prevalidation'));

    let thrown: unknown;
    try {
      await wrapped.execute({ value: 'blocked' }, { requestContext, signal: controller.signal });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(errorProperty(thrown, 'message')).toBe('already aborted prevalidation');
    expect(errorProperty(thrown, 'category')).toBe('cancelled');
    expect(errorProperty(thrown, 'code')).toBe('CANCELLED');
    expect(cacheReads).toBe(0);
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('times out stalled async schema prevalidation before reading the cache', async () => {
    const timing = createManualDeadlineTiming();
    let startPrevalidation!: () => void;
    const prevalidationStarted = new Promise<void>((resolve) => {
      startPrevalidation = resolve;
    });
    let cacheReads = 0;
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        throw new Error('cache read should not run before deadline');
      },
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run before deadline');
      },
    };
    const tool = createTool({
      name: 'stalled-prevalidation-deadline',
      description: 'Stalls during idempotency deadline prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {
        startPrevalidation();
        await new Promise<void>(() => {});
      }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });

    const pending = wrapped.execute(
      { value: 'blocked' },
      {
        requestContext: { ...requestContext, deadline: 10 },
        ...timing.options,
      },
    );
    await prevalidationStarted;
    timing.setNow(10);
    timing.fireTimeout();

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(errorProperty(thrown, 'message')).toBe('Execution deadline exceeded');
    expect(errorProperty(thrown, 'category')).toBe('timeout');
    expect(errorProperty(thrown, 'code')).toBe('TIMEOUT');
    expect(cacheReads).toBe(0);
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('times out already-expired async schema prevalidation before reading the cache', async () => {
    let cacheReads = 0;
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        throw new Error('cache read should not run after deadline');
      },
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run after deadline');
      },
    };
    const tool = createTool({
      name: 'expired-prevalidation',
      description: 'Checks expired idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {
        await new Promise<void>(() => {});
      }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });

    let thrown: unknown;
    try {
      await wrapped.execute(
        { value: 'blocked' },
        {
          requestContext: { ...requestContext, deadline: 10 },
          now: () => 10,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(errorProperty(thrown, 'message')).toBe('Execution deadline exceeded');
    expect(errorProperty(thrown, 'category')).toBe('timeout');
    expect(errorProperty(thrown, 'code')).toBe('TIMEOUT');
    expect(cacheReads).toBe(0);
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('continues after async schema prevalidation passes under a live signal and deadline', async () => {
    const timing = createManualDeadlineTiming();
    const controller = new AbortController();
    const tool = createTool({
      name: 'successful-prevalidation',
      description: 'Completes async idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {}),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    expect(
      await wrapped.execute(
        { value: 'allowed' },
        {
          requestContext: { ...requestContext, deadline: 10 },
          signal: controller.signal,
          ...timing.options,
        },
      ),
    ).toBe('allowed');
    expect(callCount).toBe(1);
    expect(timing.clearCount()).toBeGreaterThan(0);
  });
});
