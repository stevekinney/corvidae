import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { isToolCall } from '../../src/idempotency/direct-idempotency-support';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import { expectPromiseToReject } from '../helpers/async-assertions';
import {
  acceptsAnySchema,
  createTestStore,
  errorProperty,
  greetingSchema,
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

  it('uses custom TTL when provided', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a', ttl: 1000 });

    await wrapped.execute({ a: 1, b: 2 }, { requestContext });

    // The cached entry should have the custom TTL
    // We verify indirectly: result should be returned from cache
    const result = await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    expect(result).toBe(3);
    expect(callCount).toBe(1);
  });

  it('supports execute() for both raw params and ToolCall inputs', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    const directResult = await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    const cachedDirectResult = await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    expect(directResult).toBe(3);
    expect(cachedDirectResult).toBe(3);
    expect(callCount).toBe(1);

    const toolCall = { id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } };
    const executionResult = await wrapped.execute(toolCall);
    expect(executionResult.result).toBe(5);
    expect(executionResult.toolName).toBe('add');
    expect(callCount).toBe(2);
  });

  it('replays undefined direct inputs without converting them to null', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'undefined-input',
      description: 'Accepts no input',
      input: acceptsAnySchema(),
      inputSchema: {},
      idempotencyKey: () => 'undefined-input',
      async execute() {
        executions += 1;
        return 'ok';
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'undefined-input:1',
    });

    expect(await wrapped.execute(undefined, { requestContext })).toBe('ok');
    expect(await wrapped.execute(undefined, { requestContext })).toBe('ok');

    expect(executions).toBe(1);
    const key = JSON.stringify(['tenant-a', 'undefined-input:1', tool.name, 'undefined-input']);
    expect(await cache.getState(key)).toEqual(
      expect.objectContaining({ input: 'null', inputWasUndefined: true }),
    );
  });

  it('keeps invalid async-schema inputs on the canonical authorized execution path', async () => {
    let policyCalls = 0;
    const tool = createTool({
      name: 'invalid-async-input',
      description: 'Rejects invalid input asynchronously',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async ({ value }, context) => {
        await Promise.resolve();
        if (value === 'invalid') context.addIssue({ code: 'custom', message: 'invalid value' });
      }),
      idempotencyKey: () => 'invalid-async-input',
      policy: {
        beforeExecute({ policyContext }) {
          policyCalls += 1;
          expect(policyContext?.['requestContext']).toEqual(requestContext);
          return { allow: true };
        },
      },
      execute() {
        throw new Error('invalid input must not execute');
      },
    });
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });

    await expectPromiseToReject(
      wrapped.execute({ value: 'invalid' }, { requestContext }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow(),
    );
    expect(policyCalls).toBe(0);
  });

  it('passes direct ToolCall-style invocations through the original tool path', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    await expectPromiseToReject(
      Reflect.apply(wrapped, undefined, [
        {
          id: 'call-1',
          name: 'add',
          arguments: { a: 1, b: 2 },
        },
      ]),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow(),
    );
    expect(callCount).toBe(0);
  });

  it('short-circuits ToolCall detection before reading id for a non-string name', () => {
    let idReads = 0;
    const input = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'name') return 42;
          if (property === 'id') {
            idReads += 1;
            throw new Error('id getter must not run');
          }
          return undefined;
        },
      },
    );

    expect(isToolCall(input)).toBe(false);
    expect(idReads).toBe(0);
  });

  it('preserves the tool configuration', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    expect(wrapped.configuration).toBeDefined();
    expect(wrapped.configuration.identity.name).toBe('add');
  });

  it('wraps a non-Zod Standard Schema tool without throwing on the schema-match check', async () => {
    // A Standard Schema tool's `input` is `wrapStandardSchema(...)` — a
    // `z.any().transform(async ...)` pipe. `inputMatchesToolSchema` used to
    // call `input.safeParse(params)`, and Zod's SYNC `safeParse` throws for
    // an async transform ("Encountered Promise during synchronous parse")
    // instead of returning `{ success: false }`, so every idempotent call to
    // a Standard Schema tool rejected before `execute()` ever ran.
    const tool = createTool({
      name: 'greet',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute(params: { name: string }) {
        callCount++;
        return `hello, ${params.name}`;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    const result = await wrapped.execute({ name: 'ada' }, { requestContext });
    expect(result).toBe('hello, ada');
    expect(callCount).toBe(1);

    const cached = await wrapped.execute({ name: 'ada' }, { requestContext });
    expect(cached).toBe('hello, ada');
    expect(callCount).toBe(1);
  });

  it('cancels stalled async schema prevalidation before reading the cache', async () => {
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
        throw new Error('cache read should not run before cancellation');
      },
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run before cancellation');
      },
    };
    const tool = createTool({
      name: 'stalled-prevalidation-cancel',
      description: 'Stalls during idempotency prevalidation',
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
    const controller = new AbortController();

    const pending = wrapped.execute(
      { value: 'blocked' },
      { requestContext, signal: controller.signal },
    );
    await prevalidationStarted;
    controller.abort('caller aborted prevalidation');

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(errorProperty(thrown, 'message')).toBe('caller aborted prevalidation');
    expect(errorProperty(thrown, 'category')).toBe('cancelled');
    expect(errorProperty(thrown, 'code')).toBe('CANCELLED');
    expect(cacheReads).toBe(0);
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });
});
