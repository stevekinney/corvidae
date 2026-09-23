import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from '../../src/async-assertion-test-helpers';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { IdempotencyResolutionReceipt, ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import { createTestStore, requestContext } from './with-idempotency-fixtures';

describe('withIdempotency', () => {
  let cache: ToolResultCache;
  let callCount: number;

  beforeEach(() => {
    callCount = 0;
    cache = createToolResultCache({ store: createTestStore(), defaultTTL: 60_000 });
  });

  function createTestTool() {
    return createTool({
      name: 'add',
      description: 'Adds two numbers',
      version: '1.0.0',
      input: z.object({ a: z.number(), b: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ a, b }) {
        callCount++;
        return a + b;
      },
    });
  }

  it('bounds a stalled direct completion write by request cancellation', async () => {
    let completionStarted!: () => void;
    const completionPending = new Promise<void>((resolve) => {
      completionStarted = resolve;
    });
    const stalledCompletionCache: ToolResultCache = {
      ...cache,
      completeStarted: async () => {
        completionStarted();
        return new Promise(() => undefined);
      },
    };
    const controller = new AbortController();
    const execution = withIdempotency(createTestTool(), {
      cache: stalledCompletionCache,
      tenantId: 'tenant-a',
    }).execute({ a: 1, b: 2 }, { requestContext, signal: controller.signal });

    await completionPending;
    controller.abort('cancel stalled completion');
    await expectPromiseToReject(execution, (error) =>
      expect(() => {
        throw error;
      }).toThrow('lost its execution fence before completion'),
    );
    expect(callCount).toBe(1);
  });

  it('rejects invalid direct idempotency lease durations', () => {
    const tool = createTestTool();

    expect(() =>
      withIdempotency(tool, {
        cache,
        tenantId: 'tenant-a',
        leaseDurationMs: 0,
      }),
    ).toThrow('Idempotency lease and execution durations must be finite and positive.');
  });

  it('preserves unknown outcome when authorized replacement loses its race', async () => {
    const tool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      version: '1.0.0',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute() {
        throw new Error('provider timeout after charge');
      },
    });
    let now = 100;
    const onUnknownOutcome = mock(() => {});
    const replacementLosingCache: ToolResultCache = {
      ...cache,
      replaceUnknownStarted: async () => false,
    };
    const wrapped = withIdempotency(tool, {
      cache: replacementLosingCache,
      tenantId: 'tenant-a',
      toolRevision: 'charge:1',
      leaseDurationMs: 10,
      maximumExecutionDurationMs: 100,
      now: () => now,
      onUnknownOutcome,
      verifyResolutionReceipt: async () => true,
    });
    const key = JSON.stringify(['tenant-a', 'charge:1', 'charge', fullInputKey({ cents: 100 })]);

    await expectPromiseToReject(wrapped.execute({ cents: 100 }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('provider timeout after charge'),
    );
    const started = await cache.getState(key);
    if (started?.status !== 'started') throw new Error('Expected started cache entry');
    expect(started?.status).toBe('started');
    now = 110;
    const receipt: IdempotencyResolutionReceipt = {
      version: 1,
      key,
      attemptId: started.attemptId!,
      inputDigest: started.inputDigest!,
      tenantId: 'tenant-a',
      toolRevision: 'charge:1',
      decision: 'retry',
      evidence: 'provider confirmed no duplicate charge',
      authorizedAt: now,
      authorizedBy: 'operator-a',
      nonce: 'nonce-a',
      authorization: 'signed-approval',
    };

    await expectPromiseToReject(
      wrapped.execute({ cents: 100 }, { requestContext, resolutionReceipt: receipt }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('unknown outcome'),
    );
    expect(onUnknownOutcome).toHaveBeenCalledWith(key, started);
  });

  it('does not mark invalid inputs as started', async () => {
    const tool = createTool({
      name: 'typed-input',
      description: 'Requires a numeric input',
      input: z.object({ x: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ x }) {
        callCount++;
        return x * 2;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'typed-input:1',
    });
    const key = `["tenant-a","typed-input:1","typed-input",${JSON.stringify(fullInputKey({ x: '5' }))}]`;

    await expectPromiseToReject(wrapped.execute({ x: '5' }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow(),
    );
    expect(await cache.getState(key)).toBeUndefined();
    expect(callCount).toBe(0);
  });
});
