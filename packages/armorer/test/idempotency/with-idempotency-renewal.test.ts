import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import { expectPromiseToReject } from '../helpers/async-assertions';
import { createTestStore, requestContext, waitUntil } from './with-idempotency-fixtures';

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

  it('settles cancellation without waiting for an in-flight direct lease renewal', async () => {
    let signalRenewalStarted!: () => void;
    const renewalStarted = new Promise<void>((resolve) => {
      signalRenewalStarted = resolve;
    });
    let releaseRenewal!: () => void;
    const renewalReleased = new Promise<boolean>((resolve) => {
      releaseRenewal = () => resolve(true);
    });
    let renewalCalls = 0;
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const pendingRenewalCache: ToolResultCache = {
      ...cache,
      async renewStarted() {
        renewalCalls += 1;
        if (renewalCalls === 1) return true;
        signalRenewalStarted();
        return renewalReleased;
      },
    };
    const tool = createTool({
      name: 'pending-direct-renewal',
      description: 'Waits while its lease renewal remains pending',
      version: '1.0.0',
      input: z.object({}),
      idempotencyKey: () => 'pending-direct-renewal',
      async execute() {
        await toolReleased;
        return 'done';
      },
    });
    const controller = new AbortController();
    const execution = withIdempotency(tool, {
      cache: pendingRenewalCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 4,
      maximumExecutionDurationMs: 100,
    }).execute({}, { requestContext, signal: controller.signal });

    await renewalStarted;
    controller.abort('cancel pending renewal');
    releaseTool();
    // Proves settlement without waiting for the in-flight renewal: a bounded
    // microtask poll (waitUntil throws loudly on its own cap rather than
    // silently reporting "blocked") replaces racing a real timer.
    let settled = false;
    void execution.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );
    await waitUntil(() => settled, 'execution to settle without waiting for pending renewal');
    releaseRenewal();
  });

  it('cleans up direct admission claims that expire or are cancelled during initial renewal', async () => {
    const expiringTool = createTestTool();
    let expirationClockReads = 0;
    const expiring = withIdempotency(expiringTool, {
      cache,
      tenantId: 'tenant-a',
      maximumExecutionDurationMs: 5,
      now: () => [0, 5][expirationClockReads++] ?? 5,
    });
    await expectPromiseToReject(
      expiring.execute({ value: 'expired' }, { requestContext }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('exceeded its maximum execution duration'),
    );

    let resolveRenewal!: (owned: boolean) => void;
    const renewal = new Promise<boolean>((resolve) => {
      resolveRenewal = resolve;
    });
    let renewalStarted!: () => void;
    const renewalDidStart = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    let deletes = 0;
    const controller = new AbortController();
    const pending = withIdempotency(createTestTool(), {
      cache: {
        ...cache,
        renewStarted: () => {
          renewalStarted();
          return renewal;
        },
        deleteStarted: async () => {
          deletes += 1;
          return true;
        },
      },
      tenantId: 'tenant-a',
    }).execute({ value: 'cancelled' }, { requestContext, signal: controller.signal });
    await renewalDidStart;
    controller.abort('cancel initial renewal');
    await expectPromiseToReject(pending, (error) =>
      expect(() => {
        throw error;
      }).toThrow('cancel initial renewal'),
    );
    resolveRenewal(true);
    await renewal;
    await Promise.resolve();
    expect(deletes).toBe(1);

    const rejected = withIdempotency(createTestTool(), {
      cache: {
        ...cache,
        renewStarted: async () => {
          throw new Error('renewal rejected');
        },
      },
      tenantId: 'tenant-a',
    });
    await expectPromiseToReject(
      rejected.execute({ value: 'rejected' }, { requestContext }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('lost its execution fence before admission'),
    );
  });

  it('clears a direct idempotency claim when execution throws a pre-execution error', async () => {
    const tool = createTestTool();
    const throwingTool = new Proxy(tool, {
      get(target, property, receiver) {
        if (property === 'executeWith') {
          return async () => {
            throw Object.assign(new Error('current authority denied'), {
              category: 'permission',
            });
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const wrapped = withIdempotency(throwingTool, {
      cache,
      tenantId: 'tenant-a',
    });
    const key = JSON.stringify(['tenant-a', tool.id, 'add', fullInputKey({ a: 1, b: 2 })]);

    await expectPromiseToReject(wrapped.execute({ a: 1, b: 2 }, { requestContext }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('current authority denied'),
    );
    expect(await cache.getState(key)).toBeUndefined();
  });

  it('clears a direct idempotency claim when cancellation wins before the callback starts', async () => {
    let callbackRuns = 0;
    const tool = createTool({
      name: 'cancel-before-callback',
      description: 'Stalls in policy before the callback',
      version: '1.0.0',
      input: z.object({}),
      idempotencyKey: () => 'cancel-before-callback',
      policy: { beforeExecute: () => new Promise(() => {}) },
      async execute() {
        callbackRuns += 1;
        return 'unexpected';
      },
    });
    const controller = new AbortController();
    let deleteAttempts = 0;
    const trackedCache: ToolResultCache = {
      ...cache,
      async deleteStarted(key, attemptId) {
        deleteAttempts += 1;
        return cache.deleteStarted(key, attemptId);
      },
    };
    const wrapped = withIdempotency(tool, { cache: trackedCache, tenantId: 'tenant-a' });
    const key = JSON.stringify([
      'tenant-a',
      tool.id,
      'cancel-before-callback',
      'cancel-before-callback',
    ]);
    const execution = wrapped.execute({}, { requestContext, signal: controller.signal });

    while ((await cache.getState(key)) === undefined) await Promise.resolve();
    controller.abort('cancel before callback');
    await expectPromiseToReject(execution, (error) =>
      expect(() => {
        throw error;
      }).toThrow('cancel before callback'),
    );
    expect(callbackRuns).toBe(0);
    expect(deleteAttempts).toBe(1);
    expect(await cache.getState(key)).toBeUndefined();
  });
});
