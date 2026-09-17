import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { isPreExecutionResult } from '../../src/idempotency/direct-idempotency-support';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import { expectPromiseToReject } from '../helpers/async-assertions';
import {
  createManualDeadlineTiming,
  createManualRuntimeServices,
  createTestStore,
  greetingSchema,
  requestContext,
  waitUntil,
} from './with-idempotency-fixtures';

describe('withIdempotency', () => {
  let cache: ToolResultCache;
  let callCount: number;

  beforeEach(() => {
    callCount = 0;
    cache = createToolResultCache({ store: createTestStore(), defaultTTL: 60_000 });
  });

  it('normalizes non-Error async schema prevalidation rejections', async () => {
    const tool = createTool({
      name: 'rejected-prevalidation',
      description: 'Rejects async idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {
        throw 'schema rejected';
      }),
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

    await expectPromiseToReject(
      wrapped.execute(
        { value: 'blocked' },
        {
          requestContext: { ...requestContext, deadline: 10 },
          ...createManualDeadlineTiming().options,
        },
      ),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('schema rejected'),
    );
    expect(callCount).toBe(0);
  });

  it('does not coerce non-string error categories while classifying pre-execution results', () => {
    const category = {
      toString() {
        throw new Error('category must not be coerced');
      },
    };

    expect(isPreExecutionResult({ outcome: 'error', errorCategory: category })).toBe(false);
  });

  it('normalizes synchronous schema prevalidation throws before cache access', async () => {
    let cacheReads = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        return undefined;
      },
    };
    const baseTool = createTool({
      name: 'sync-throwing-prevalidation',
      description: 'Throws synchronously during idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute() {
        return 'unreachable';
      },
    });
    const tool = baseTool;
    Object.defineProperty(tool, 'input', {
      configurable: true,
      value: {
        safeParseAsync() {
          throw 'synchronous schema failure';
        },
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });

    await expectPromiseToReject(
      wrapped.execute({ value: 'blocked' }, { requestContext }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('synchronous schema failure'),
    );
    expect(cacheReads).toBe(0);
  });

  it('NEUTER CHECK: a sync `safeParse` on the wrapped schema throws (proves the fix is load-bearing)', () => {
    const tool = createTool({
      name: 'greet-neuter',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });
    const input = Reflect.get(tool, 'input');
    const safeParse = Reflect.get(input, 'safeParse');
    if (typeof safeParse !== 'function') throw new Error('Expected a synchronous safeParse');
    expect(() => Reflect.apply(safeParse, input, [{ name: 'ada' }])).toThrow(
      'Encountered Promise during synchronous parse',
    );
  });

  describe('AB-92/AB-254: RuntimeServices composition', () => {
    it('drives lease-renewal timing entirely through ManualRuntimeServices.advance, with no real timer', async () => {
      const runtime = createManualRuntimeServices();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tool = createTool({
        name: 'slow-fenced-manual-runtime',
        description: 'Slow fenced execution driven by a manual runtime',
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
        runtime,
      });

      const execution = wrapped.execute({ value: 7 }, { requestContext });

      // The renewal timer is armed at half the lease duration (5ms) — wait
      // for it to appear on the manual runtime's own bookkeeping rather than
      // a real timer.
      await waitUntil(
        () => runtime.pendingTimers().length > 0,
        'lease-renewal timer armed on the manual runtime',
      );
      const renewalsBeforeAdvance = renewals;
      await runtime.advance(5);
      expect(renewals).toBeGreaterThan(renewalsBeforeAdvance);

      release();
      expect(await execution).toBe(7);
    });
  });
});
