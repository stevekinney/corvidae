import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { CachedToolResult, ToolResultCache } from '../../src/idempotency/types';
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

  it('executes normally on the first call', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    const result = await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    expect(result).toBe(3);
    expect(callCount).toBe(1);
  });

  it('rejects streaming before claiming or executing an idempotency key', async () => {
    const wrapped = withIdempotency(createTestTool(), { cache, tenantId: 'tenant-a' });

    await expectPromiseToReject(
      wrapped.execute({ a: 1, b: 2 }, { requestContext, stream: true }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('Idempotency does not support streaming executions'),
    );
    expect(callCount).toBe(0);
  });

  it('returns cached result on duplicate call', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    const result1 = await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    const result2 = await wrapped.execute({ a: 1, b: 2 }, { requestContext });

    expect(result1).toBe(3);
    expect(result2).toBe(3);
    expect(callCount).toBe(1); // Only executed once
  });

  it('executes again for different inputs', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    await wrapped.execute({ a: 3, b: 4 }, { requestContext });

    expect(callCount).toBe(2);
  });

  it('preserves tool name and description', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    expect(wrapped.name).toBe('add');
    expect(wrapped.description).toBe('Adds two numbers');
  });

  it('preserves tool input schema', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    expect(wrapped.input).toBe(tool.input);
  });

  it('calls onCacheHit when returning a cached result', async () => {
    const tool = createTestTool();
    const onCacheHit = mock((_key: string, _result: CachedToolResult) => {});
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a', onCacheHit });

    await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    await wrapped.execute({ a: 1, b: 2 }, { requestContext });

    expect(onCacheHit).toHaveBeenCalledTimes(1);
    const firstCall = onCacheHit.mock.calls[0];
    if (firstCall === undefined) throw new Error('Expected cache hit callback');
    expect(firstCall[1].result).toBe(3);
    expect(firstCall[1].toolName).toBe('add');
  });

  it('re-runs current policy before returning a completed cache hit', async () => {
    const tool = createTool({
      name: 'policy-cached',
      description: 'Policy-protected cached tool',
      version: '1.0.0',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute(context) {
          const currentContext = context.policyContext as
            { requestContext?: typeof requestContext } | undefined;
          return currentContext?.requestContext?.authority.principalId === 'principal-a'
            ? { allow: true }
            : { allow: false, reason: 'principal denied' };
        },
      },
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });
    const deniedContext = {
      ...requestContext,
      authority: { ...requestContext.authority, principalId: 'principal-b' },
    };

    expect(await wrapped.execute({ value: 'cached' }, { requestContext })).toBe('cached');
    await expectPromiseToReject(
      wrapped.execute({ value: 'cached' }, { requestContext: deniedContext }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('principal denied'),
    );
    expect(callCount).toBe(1);
  });
});
