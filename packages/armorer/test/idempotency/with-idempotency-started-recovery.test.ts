import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type {
  IdempotencyResolutionReceipt,
  LegacyIdempotencyResolutionReceipt,
  ToolResultCache,
} from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import { expectPromiseToReject } from '../helpers/async-assertions';
import { createTestStore, requestContext } from './with-idempotency-fixtures';
describe('withIdempotency', () => {
  let cache: ToolResultCache;
  let callCount: number;

  beforeEach(() => {
    callCount = 0;
    cache = createToolResultCache({ store: createTestStore(), defaultTTL: 60_000 });
  });
  it('keeps started state when execution throws after claiming a key', async () => {
    const sideEffects: number[] = [];
    const tool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ cents }) {
        callCount++;
        sideEffects.push(cents);
        throw new Error('provider timeout after charge');
      },
    });

    const onUnknownOutcome = mock(() => {});
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'charge:1',
      onUnknownOutcome,
    });
    const key = `["tenant-a","charge:1","charge",${JSON.stringify(fullInputKey({ cents: 100 }))}]`;
    await expectPromiseToReject(wrapped.execute({ cents: 100 }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('provider timeout after charge'),
    );
    expect(callCount).toBe(1);
    expect(sideEffects).toEqual([100]);
    await expectPromiseToReject(wrapped.execute({ cents: 100 }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('unknown outcome'),
    );
    expect(callCount).toBe(1);
    expect(sideEffects).toEqual([100]);
    expect(onUnknownOutcome).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ status: 'started', toolName: 'charge' }),
    );
  });
  it('replaces a fenced started marker with an authorized resolution receipt', async () => {
    const tool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      version: '1.0.0',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ cents }) {
        callCount++;
        if (callCount === 1) throw new Error('provider timeout after charge');
        return cents;
      },
    });
    let now = 100;
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'charge:1',
      leaseDurationMs: 10,
      maximumExecutionDurationMs: 100,
      now: () => now,
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
    expect(started?.attemptId).toBeString();
    expect(started?.inputDigest).toBeString();
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
    const result = await wrapped.execute(
      { cents: 100 },
      { requestContext, resolutionReceipt: receipt },
    );

    expect(result).toBe(100);
    expect(callCount).toBe(2);
    const completed = await cache.getState(key);
    expect(completed?.status).toBe('completed');
  });
  it('migrates direct legacy started markers only with an authorized legacy receipt', async () => {
    const legacyStore = createTestStore();
    const legacyCache = createToolResultCache({ store: legacyStore, defaultTTL: 60_000 });
    const tool = createTool({
      name: 'legacy-direct',
      description: 'Migrates a legacy direct marker',
      version: '1.0.0',
      input: z.object({ value: z.number() }),
      idempotencyKey: () => 'legacy-direct',
      async execute({ value }) {
        callCount += 1;
        return value;
      },
    });
    const key = JSON.stringify(['tenant-a', 'legacy-direct:1', tool.name, 'legacy-direct']);
    await legacyStore.set(
      key,
      JSON.stringify({ status: 'started', toolName: tool.name, startedAt: 1_000, ttl: 60_000 }),
    );
    const wrapped = withIdempotency(tool, {
      cache: legacyCache,
      tenantId: 'tenant-a',
      toolRevision: 'legacy-direct:1',
      now: () => 2_000,
      verifyLegacyResolutionReceipt: async (receipt) => receipt.authorization === 'authorized',
    });
    const receipt: LegacyIdempotencyResolutionReceipt = {
      version: 1,
      key,
      tenantId: 'tenant-a',
      toolRevision: 'legacy-direct:1',
      toolName: tool.name,
      legacyStartedAt: 1_000,
      decision: 'retry',
      evidence: 'provider confirmed no side effect',
      authorizedAt: 2_000,
      authorizedBy: 'operator-a',
      nonce: 'legacy-direct-receipt',
      authorization: 'denied',
    };
    await expectPromiseToReject(
      wrapped.execute({ value: 7 }, { requestContext, legacyResolutionReceipt: receipt }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('unknown outcome'),
    );
    expect(callCount).toBe(0);

    const result = await wrapped.execute(
      { value: 7 },
      {
        requestContext,
        legacyResolutionReceipt: { ...receipt, authorization: 'authorized' },
      },
    );
    expect(result).toBe(7);
    expect(callCount).toBe(1);
    expect(await legacyCache.getState(key)).toEqual(
      expect.objectContaining({ status: 'completed' }),
    );
  });
  it('fails closed when a direct legacy marker replacement loses its compare-and-set race', async () => {
    const tool = createTool({
      name: 'legacy-direct-race',
      description: 'Loses a legacy marker migration race',
      version: '1.0.0',
      input: z.object({}),
      idempotencyKey: () => 'legacy-direct-race',
      async execute() {
        callCount += 1;
        return 'unexpected';
      },
    });
    const key = JSON.stringify([
      'tenant-a',
      'legacy-direct-race:1',
      tool.name,
      'legacy-direct-race',
    ]);
    const started = {
      status: 'started' as const,
      toolName: tool.name,
      startedAt: 1_000,
      ttl: 60_000,
    };
    const racingCache: ToolResultCache = {
      ...cache,
      getState: async () => started,
      replaceLegacyStarted: async () => false,
    };
    const wrapped = withIdempotency(tool, {
      cache: racingCache,
      tenantId: 'tenant-a',
      toolRevision: 'legacy-direct-race:1',
      now: () => 2_000,
      verifyLegacyResolutionReceipt: async () => true,
    });
    await expectPromiseToReject(
      wrapped.execute(
        {},
        {
          requestContext,
          legacyResolutionReceipt: {
            version: 1,
            key,
            tenantId: 'tenant-a',
            toolRevision: 'legacy-direct-race:1',
            toolName: tool.name,
            legacyStartedAt: 1_000,
            decision: 'retry',
            evidence: 'provider confirmed no side effect',
            authorizedAt: 2_000,
            authorizedBy: 'operator-a',
            nonce: 'legacy-direct-race-receipt',
            authorization: 'authorized',
          },
        },
      ),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('unknown outcome'),
    );
    expect(callCount).toBe(0);
  });
});
