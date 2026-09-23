import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from '../../src/async-assertion-test-helpers';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { CachedToolResult, ToolResultCache } from '../../src/idempotency/types';
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

  it('fails closed for completed cache entries without original input', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });
    await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    const key = JSON.stringify(['tenant-a', tool.id, tool.name, fullInputKey({ a: 1, b: 2 })]);
    const cached = await cache.getState(key);
    expect(cached?.status).toBe('completed');
    if (cached?.status !== 'completed') throw new Error('Expected completed cache entry');
    const { input: _input, ...cachedWithoutInput } = cached;
    await cache.set(key, cachedWithoutInput);

    await expectPromiseToReject(wrapped.execute({ a: 1, b: 2 }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('original input'),
    );
    expect(callCount).toBe(1);
  });

  it('fails closed for completed cache entries with invalid original input', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });
    await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    const key = JSON.stringify(['tenant-a', tool.id, tool.name, fullInputKey({ a: 1, b: 2 })]);
    const cached = await cache.getState(key);
    expect(cached?.status).toBe('completed');
    if (cached?.status !== 'completed') throw new Error('Expected completed cache entry');
    const cachedResult: CachedToolResult = { ...cached, input: '{invalid' };
    await cache.set(key, cachedResult);

    await expectPromiseToReject(wrapped.execute({ a: 1, b: 2 }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('invalid original input'),
    );
    expect(callCount).toBe(1);
  });

  it('reauthorizes completed cache hits against the original input', async () => {
    let allowAll = true;
    const tool = createTool({
      name: 'input-bound-cache',
      description: 'Input-sensitive cached tool',
      version: '1.0.0',
      input: z.object({ value: z.string() }),
      idempotencyKey: () => 'same-operation',
      policy: {
        beforeExecute({ policyContext }) {
          const value = (policyContext as { params?: { value?: string } } | undefined)?.params
            ?.value;
          return allowAll || value === 'safe'
            ? { allow: true }
            : { allow: false, reason: 'unsafe original input' };
        },
      },
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });

    expect(await wrapped.execute({ value: 'unsafe' }, { requestContext })).toBe('unsafe');
    allowAll = false;
    await expectPromiseToReject(wrapped.execute({ value: 'safe' }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('unsafe original input'),
    );
    expect(callCount).toBe(1);
  });
});
