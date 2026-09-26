import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from '../../src/async-assertion-test-helpers';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { CachedToolResult, ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import {
  acceptsAnySchema,
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

  it('supports tools with non-Zod input schemas', async () => {
    const tool = createTool({
      name: 'jsonSchemaInput',
      description: 'Uses a JSON schema input',
      input: acceptsAnySchema(),
      inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute(input: unknown) {
        const value =
          typeof input === 'object' && input !== null ? Reflect.get(input, 'x') : undefined;
        if (typeof value !== 'number') {
          throw new Error('invalid input');
        }
        callCount++;
        return value * 2;
      },
    });
    Object.defineProperty(tool, 'input', {
      configurable: true,
      value: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'json-schema-input:1',
    });

    expect(await wrapped.execute({ x: 5 }, { requestContext })).toBe(10);
    expect(await wrapped.execute({ x: 5 }, { requestContext })).toBe(10);
    expect(callCount).toBe(1);
  });

  it('preserves the idempotency key callback receiver', async () => {
    let receiverMatches = false;
    const tool = createTool({
      name: 'receiver-sensitive',
      description: 'Checks idempotency callback receiver',
      version: '1.0.0',
      input: z.object({ value: z.number() }),
      idempotencyKey(this: unknown) {
        receiverMatches = this === tool;
        return 'receiver-sensitive';
      },
      async execute({ value }) {
        return value;
      },
    });
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });

    await wrapped.execute({ value: 1 }, { requestContext });
    expect(receiverMatches).toBe(true);
  });

  it('surfaces an unknown outcome when a key was started without a result', async () => {
    const runtime = createManualRuntimeServices();
    // A locally-scoped cache sharing this test's manual clock, rather than the
    // shared beforeEach `cache` (which uses the real default clock): startedAt
    // has to be read through the same clock the cache's own TTL check uses.
    const flakyCache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 60_000,
      now: runtime.clock.now,
    });
    const tool = createTool({
      name: 'flaky',
      description: 'A flaky tool',
      input: z.object({ x: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ x }) {
        callCount++;
        return x * 2;
      },
    });
    const key = `["tenant-a","flaky:1","flaky",${JSON.stringify(fullInputKey({ x: 5 }))}]`;
    await flakyCache.claimStarted(key, {
      status: 'started',
      toolName: 'flaky',
      startedAt: runtime.clock.now(),
      ttl: 60_000,
    });

    const onUnknownOutcome = mock(() => {});
    const wrapped = withIdempotency(tool, {
      cache: flakyCache,
      tenantId: 'tenant-a',
      toolRevision: 'flaky:1',
      onUnknownOutcome,
    });

    await expectPromiseToReject(wrapped.execute({ x: 5 }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('unknown outcome'),
    );
    expect(onUnknownOutcome).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ status: 'started', toolName: 'flaky' }),
    );
    expect(callCount).toBe(0);
  });

  it('throws when tool has no idempotencyKey', () => {
    const tool = createTool({
      name: 'no-key',
      version: '1.0.0',
      description: 'Tool without idempotency key',
      input: z.object({ x: z.number() }),
      async execute({ x }) {
        return x;
      },
    });

    expect(() => withIdempotency(tool, { cache, tenantId: 'tenant-a' })).toThrow(
      'does not have an idempotencyKey',
    );
  });

  it('requires a tenant and complete tool revision', () => {
    const tool = createTestTool();
    expect(() => withIdempotency(tool, { cache, tenantId: '' })).toThrow(
      'requires tenantId and a versioned tool definition revision',
    );
    expect(() => withIdempotency(tool, { cache, tenantId: 'tenant-a', toolRevision: '' })).toThrow(
      'requires tenantId and a versioned tool definition revision',
    );
  });

  it('rejects an unversioned tool without an explicit durable revision', () => {
    const tool = createTool({
      name: 'unversioned-charge',
      description: 'Charges a card',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ cents }) {
        return cents;
      },
    });

    expect(() => withIdempotency(tool, { cache, tenantId: 'tenant-a' })).toThrow(
      'versioned tool definition revision',
    );
  });

  it('requires matching request authority and dedupes logical retries across request identity', async () => {
    const wrapped = withIdempotency(createTestTool(), { cache, tenantId: 'tenant-a' });

    await expectPromiseToReject(wrapped({ a: 1, b: 2 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('requires request-scoped execution authority'),
    );
    await expectPromiseToReject(wrapped.execute({ a: 1, b: 2 }, {}), (error) =>
      expect(() => {
        throw error;
      }).toThrow('requires request-scoped execution authority'),
    );
    await expectPromiseToReject(
      wrapped.execute(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            authority: { ...requestContext.authority, tenantId: 'tenant-b' },
          },
        },
      ),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('tenantId must match request authority tenantId'),
    );

    expect(await wrapped.execute({ a: 1, b: 2 }, { requestContext })).toBe(3);
    expect(
      await wrapped.execute(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            runId: 'run-b',
            agentId: 'agent-b',
            authority: {
              ...requestContext.authority,
              principalId: 'principal-b',
              ownerId: 'owner-b',
              capabilities: ['payments:charge', 'tools:execute'],
              authorizationRevision: 'authorization:2',
            },
          },
        },
      ),
    ).toBe(3);
    expect(callCount).toBe(1);

    await expectPromiseToReject(
      wrapped.execute(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            authority: { ...requestContext.authority, tenantId: 'tenant-b' },
          },
        },
      ),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('tenantId must match request authority tenantId'),
    );
    expect(callCount).toBe(1);
  });

  it('keeps direct cached results tenant-isolated when request identity fields change', async () => {
    const tenantA = withIdempotency(createTestTool(), { cache, tenantId: 'tenant-a' });
    const tenantB = withIdempotency(createTestTool(), { cache, tenantId: 'tenant-b' });
    const tenantBRequestContext = {
      ...requestContext,
      runId: 'run-b',
      agentId: 'agent-b',
      authority: {
        ...requestContext.authority,
        tenantId: 'tenant-b',
        principalId: 'principal-b',
        ownerId: 'owner-b',
        authorizationRevision: 'authorization:2',
      },
    };

    expect(await tenantA.execute({ a: 1, b: 2 }, { requestContext })).toBe(3);
    expect(await tenantB.execute({ a: 9, b: 9 }, { requestContext: tenantBRequestContext })).toBe(
      18,
    );

    expect(callCount).toBe(2);
  });

  it('uses the injected clock for started and completed cache timestamps', async () => {
    const cacheHits: CachedToolResult[] = [];
    const runtime = createManualRuntimeServices();
    const timestamp = runtime.clock.now();
    const wrapped = withIdempotency(createTestTool(), {
      cache,
      tenantId: 'tenant-a',
      now: () => timestamp,
      onCacheHit: (_key, entry) => cacheHits.push(entry),
    });

    await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    await wrapped.execute({ a: 1, b: 2 }, { requestContext });

    expect(cacheHits).toHaveLength(1);
    expect(cacheHits[0]?.executedAt).toBe(timestamp);
  });
});
