import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from '../../src/async-assertion-test-helpers';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
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

  it('uses the cache wall clock for TTL expiration when execution uses another clock', async () => {
    let cacheClock = 1_000;
    const wallClockCache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 100,
      now: () => cacheClock,
    });
    const wrapped = withIdempotency(createTestTool(), {
      cache: wallClockCache,
      tenantId: 'tenant-a',
      ttl: 100,
      now: () => 10_000_000,
    });

    expect(await wrapped.execute({ a: 1, b: 2 }, { requestContext })).toBe(3);
    expect(await wrapped.execute({ a: 1, b: 2 }, { requestContext })).toBe(3);
    expect(callCount).toBe(1);

    cacheClock = 1_101;
    expect(await wrapped.execute({ a: 1, b: 2 }, { requestContext })).toBe(3);
    expect(callCount).toBe(2);
  });

  it('clears claims when policy stops execution before the callback runs', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'approval-gated',
      description: 'Requires approval before execution',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute: () => ({
          status: 'needs_approval' as const,
          reason: 'Operator approval required',
          action: { message: 'Approve execution' },
        }),
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'approval-gated:1',
    });

    const first = wrapped.execute({ value: 'one' }, { requestContext });
    const second = wrapped.execute({ value: 'one' }, { requestContext });

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(outcomes.map((outcome) => outcome.status)).toContain('rejected');
    expect(executions).toBe(0);
  });

  it('clears callable claims when policy stops execution before the callback runs', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'callable-approval-gated',
      description: 'Requires approval before callable execution',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute: () => ({
          status: 'needs_approval' as const,
          reason: 'Callable approval required',
          action: { message: 'Approve callable execution' },
        }),
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'callable-approval-gated:1',
    });
    const input = { value: 'one' };
    const key = JSON.stringify([
      'tenant-a',
      'callable-approval-gated:1',
      'callable-approval-gated',
      fullInputKey(input),
    ]);

    await expectPromiseToReject(wrapped.execute(input, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('Callable approval required'),
    );
    expect(await cache.getState(key)).toBeUndefined();
    await expectPromiseToReject(wrapped.execute(input, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('Callable approval required'),
    );
    expect(await cache.getState(key)).toBeUndefined();
    expect(executions).toBe(0);
  });

  it('clears claims when policy denies execution before the callback runs', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'policy-denied',
      description: 'Is denied before execution',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute: () => ({ allow: false, reason: 'Execution denied' }),
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'policy-denied:1',
    });

    await expectPromiseToReject(wrapped.execute({ value: 'one' }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('Execution denied'),
    );
    await expectPromiseToReject(wrapped.execute({ value: 'one' }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('Execution denied'),
    );
    expect(executions).toBe(0);
  });

  it('clears callable claims when policy denies execution before the callback runs', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'callable-policy-denied',
      description: 'Callable path is denied before execution',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute: () => ({ allow: false, reason: 'Callable execution denied' }),
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'callable-policy-denied:1',
    });
    const input = { value: 'one' };
    const key = JSON.stringify([
      'tenant-a',
      'callable-policy-denied:1',
      'callable-policy-denied',
      fullInputKey(input),
    ]);

    await expectPromiseToReject(wrapped.execute(input, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('Callable execution denied'),
    );
    expect(await cache.getState(key)).toBeUndefined();
    await expectPromiseToReject(wrapped.execute(input, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('Callable execution denied'),
    );
    expect(await cache.getState(key)).toBeUndefined();
    expect(executions).toBe(0);
  });
});
