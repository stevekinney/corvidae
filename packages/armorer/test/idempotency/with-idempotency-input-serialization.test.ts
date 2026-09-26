import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from '../../src/async-assertion-test-helpers';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { IdempotencyResolutionReceipt, ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import {
  acceptsAnySchema,
  createManualDeadlineTiming,
  createTestStore,
  requestContext,
} from './with-idempotency-fixtures';

describe('withIdempotency', () => {
  let cache: ToolResultCache;
  let callCount: number;

  beforeEach(() => {
    callCount = 0;
    cache = createToolResultCache({ store: createTestStore(), defaultTTL: 60_000 });
  });

  it('re-arms long async schema prevalidation deadlines without overflowing timer delay', async () => {
    const maximumTimerDelay = 2_147_483_647;
    const timing = createManualDeadlineTiming();
    const controller = new AbortController();
    let startPrevalidation!: () => void;
    const prevalidationStarted = new Promise<void>((resolve) => {
      startPrevalidation = resolve;
    });
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        throw new Error('cache read should not run before long deadline prevalidation settles');
      },
      claimStarted: async () => {
        throw new Error('cache claim should not run before long deadline prevalidation settles');
      },
    };
    const tool = createTool({
      name: 'long-prevalidation-deadline',
      description: 'Stalls during a long idempotency deadline prevalidation',
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
        requestContext: { ...requestContext, deadline: maximumTimerDelay + 1_000 },
        signal: controller.signal,
        ...timing.options,
      },
    );
    const pendingResult = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    await prevalidationStarted;

    expect(timing.scheduledDelays()).toEqual([maximumTimerDelay]);
    timing.fireTimeout();
    expect(await Promise.race([pendingResult, Promise.resolve('pending')])).toBe('pending');
    expect(timing.scheduledDelays()).toEqual([maximumTimerDelay, maximumTimerDelay]);

    controller.abort('stop long prevalidation');

    await expectPromiseToReject(pending, (error) =>
      expect(() => {
        throw error;
      }).toThrow('stop long prevalidation'),
    );
    expect(callCount).toBe(0);
  });

  it('rejects non-finite async schema prevalidation deadlines before scheduling or cache access', async () => {
    const timing = createManualDeadlineTiming();
    let cacheReads = 0;
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        throw new Error('cache read should not run for a non-finite deadline');
      },
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run for a non-finite deadline');
      },
    };
    const tool = createTool({
      name: 'non-finite-prevalidation-deadline',
      description: 'Rejects unsupported idempotency prevalidation deadlines',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {}),
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

    await expectPromiseToReject(
      wrapped.execute(
        { value: 'blocked' },
        {
          requestContext: { ...requestContext, deadline: Infinity },
          ...timing.options,
        },
      ),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('Execution deadline must be finite.'),
    );
    expect(timing.scheduledDelays()).toEqual([]);
    expect(cacheReads).toBe(0);
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('serializes accepted direct inputs before claiming an idempotency key or executing', async () => {
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run before input serialization');
      },
    };
    const tool = createTool({
      name: 'json-serializable-input',
      description: 'Requires idempotent inputs to be JSON serializable',
      version: '1.0.0',
      input: acceptsAnySchema(),
      inputSchema: {},
      idempotencyKey: () => 'same-operation',
      async execute(value: unknown) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });
    const circularInput: Record<string, unknown> = { value: 'circular' };
    circularInput['self'] = circularInput;

    await expectPromiseToReject(wrapped.execute(1n, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('BigInt is not valid JSON at idempotency input'),
    );
    await expectPromiseToReject(
      wrapped.execute(function rootFunction() {}, { requestContext }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('Function is not valid JSON at idempotency input'),
    );
    await expectPromiseToReject(wrapped.execute(circularInput, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('Circular reference detected at idempotency input.self'),
    );
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('serializes an accepted input exactly once before admission', async () => {
    let reads = 0;
    const tool = createTool({
      name: 'single-serialization',
      description: 'Counts input serialization reads',
      version: '1.0.0',
      input: acceptsAnySchema(),
      inputSchema: {},
      idempotencyKey: () => 'single-serialization',
      async execute(value: unknown) {
        return value;
      },
    });
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });
    const input = {
      get value() {
        reads += 1;
        return 'stable';
      },
    };

    await wrapped.execute(input, { requestContext });
    expect(reads).toBe(6);
  });

  it('serializes accepted retry inputs before replacing an unknown started marker', async () => {
    let replacements = 0;
    const key = JSON.stringify([
      'tenant-a',
      'serializable-retry:1',
      'serializable-retry',
      'same-operation',
    ]);
    const started = {
      status: 'started',
      toolName: 'serializable-retry',
      startedAt: 0,
      ttl: 60_000,
      attemptId: 'attempt-a',
      leaseExpiresAt: 50,
    } as const;
    const replacementGuardedCache: ToolResultCache = {
      ...cache,
      getState: async () => started,
      replaceUnknownStarted: async () => {
        replacements++;
        throw new Error('started marker replacement should not run before input serialization');
      },
    };
    const tool = createTool({
      name: 'serializable-retry',
      description: 'Requires retry inputs to be JSON serializable before replacement',
      version: '1.0.0',
      input: acceptsAnySchema(),
      inputSchema: {},
      idempotencyKey: () => 'same-operation',
      async execute(value: unknown) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: replacementGuardedCache,
      tenantId: 'tenant-a',
      toolRevision: 'serializable-retry:1',
      now: () => 100,
      verifyResolutionReceipt: async () => true,
    });
    const receipt: IdempotencyResolutionReceipt = {
      version: 1,
      key,
      attemptId: 'attempt-a',
      inputDigest: 'unused-input-digest',
      tenantId: 'tenant-a',
      toolRevision: 'serializable-retry:1',
      decision: 'retry',
      evidence: 'operator verified no external effect',
      authorizedAt: 100,
      authorizedBy: 'operator-a',
      nonce: 'nonce-a',
      authorization: 'signed-retry',
    };
    const circularInput: Record<string, unknown> = { value: 'retry' };
    circularInput['self'] = circularInput;

    await expectPromiseToReject(
      wrapped.execute(circularInput, { requestContext, resolutionReceipt: receipt }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('Circular reference detected at idempotency input.self'),
    );
    expect(replacements).toBe(0);
    expect(callCount).toBe(0);
  });
});
