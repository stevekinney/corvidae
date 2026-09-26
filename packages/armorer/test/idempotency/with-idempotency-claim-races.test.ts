import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from '../../src/async-assertion-test-helpers';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { CachedToolResult, ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import {
  createManualRuntimeServices,
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

  it('keeps delimiter-bearing tenant and revision tuples in distinct cache scopes', async () => {
    const first = withIdempotency(createTestTool(), {
      cache,
      tenantId: 'tenant:a',
      toolRevision: 'revision',
    });
    const second = withIdempotency(createTestTool(), {
      cache,
      tenantId: 'tenant',
      toolRevision: 'a:revision',
    });

    expect(
      await first.execute(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            authority: { ...requestContext.authority, tenantId: 'tenant:a' },
          },
        },
      ),
    ).toBe(3);
    expect(
      await second.execute(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            authority: { ...requestContext.authority, tenantId: 'tenant' },
          },
        },
      ),
    ).toBe(3);

    const firstKey = `["tenant:a","revision","add",${JSON.stringify(fullInputKey({ a: 1, b: 2 }))}]`;
    const secondKey = `["tenant","a:revision","add",${JSON.stringify(fullInputKey({ a: 1, b: 2 }))}]`;
    expect(firstKey).not.toBe(secondKey);
    expect(await cache.getState(firstKey)).toBeDefined();
    expect(await cache.getState(secondKey)).toBeDefined();
  });

  it('honors atomic claim races and rejects a lost completion fence', async () => {
    const tool = createTestTool();
    const completed: CachedToolResult = {
      result: 99,
      toolName: 'add',
      executedAt: createManualRuntimeServices().clock.now(),
      ttl: 60_000,
      input: JSON.stringify({ a: 1, b: 2 }),
    };
    const completedRace: ToolResultCache = {
      ...cache,
      getState: async () => undefined,
      claimStarted: async () => ({ outcome: 'existing', entry: completed }),
    };
    expect(
      await withIdempotency(tool, { cache: completedRace, tenantId: 'tenant-a' }).execute(
        { a: 1, b: 2 },
        { requestContext },
      ),
    ).toBe(99);

    const startedRace: ToolResultCache = {
      ...cache,
      getState: async () => undefined,
      claimStarted: async (_key, execution) => ({ outcome: 'existing', entry: execution }),
    };
    await expectPromiseToReject(
      withIdempotency(tool, { cache: startedRace, tenantId: 'tenant-a' }).execute(
        { a: 1, b: 2 },
        { requestContext },
      ),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('unknown outcome'),
    );

    const lostFence: ToolResultCache = {
      ...cache,
      completeStarted: async () => false,
    };
    await expectPromiseToReject(
      withIdempotency(tool, { cache: lostFence, tenantId: 'tenant-a' }).execute(
        { a: 3, b: 4 },
        { requestContext },
      ),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('lost its execution fence'),
    );
  });

  it('reauthorizes completed claim-race cache entries before returning cached data', async () => {
    let executions = 0;
    const onCacheHit = mock((_key: string, _result: CachedToolResult) => {});
    const tool = createTool({
      name: 'claim-race-policy',
      description: 'Policy-protected claim race',
      version: '1.0.0',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute(context) {
          const currentContext = context.policyContext as
            { requestContext?: typeof requestContext } | undefined;
          return currentContext?.requestContext?.authority.principalId === 'principal-a'
            ? { allow: true }
            : { allow: false, reason: 'claim race principal denied' };
        },
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const completed: CachedToolResult = {
      result: 'cached-sensitive-data',
      toolName: 'claim-race-policy',
      executedAt: createManualRuntimeServices().clock.now(),
      ttl: 60_000,
      input: JSON.stringify({ value: 'cached' }),
    };
    const completedRace: ToolResultCache = {
      ...cache,
      getState: async () => undefined,
      claimStarted: async () => ({ outcome: 'existing', entry: completed }),
    };
    const wrapped = withIdempotency(tool, {
      cache: completedRace,
      tenantId: 'tenant-a',
      onCacheHit,
    });
    const deniedContext = {
      ...requestContext,
      authority: { ...requestContext.authority, principalId: 'principal-b' },
    };

    await expectPromiseToReject(
      wrapped.execute({ value: 'cached' }, { requestContext: deniedContext }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('claim race principal denied'),
    );
    expect(onCacheHit).not.toHaveBeenCalled();
    expect(executions).toBe(0);
  });
});
