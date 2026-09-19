import { createManualRuntimeServices } from '@corvidae/lifecycle';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from './helpers/async-assertions';

import { createTool } from '../src/create-tool';
import { internalRetryTestUtilities, retry } from '../src/utilities/retry';

/**
 * Polls a microtask-only predicate to completion, capped so a regression
 * that never satisfies it fails the test fast instead of hanging CI in an
 * unbounded busy-wait loop.
 */
async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const maximumAttempts = 1_000;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`waitUntil timed out after ${maximumAttempts} microtask ticks: ${description}`);
}

const makeRawTool = (execute: (input: unknown) => Promise<unknown>) => {
  return createTool({
    name: 'raw-tool-fixture',
    description: 'raw tool',
    input: z.object({ value: z.number() }),
    tags: ['raw'],
    metadata: { tier: 'test' },
    execute,
  });
};

describe('retry coverage edges', () => {
  it('throws immediately when shouldRetry returns false', async () => {
    let attempts = 0;
    let shouldRetryCalls = 0;
    const failing = makeRawTool(async () => {
      attempts += 1;
      throw 'stop';
    });

    const wrapped = retry(failing, {
      attempts: 2,
      shouldRetry: async () => {
        shouldRetryCalls += 1;
        return false;
      },
    });

    await expectPromiseToReject(wrapped({ value: 1 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('stop'),
    );
    expect(attempts).toBe(1);
    expect(shouldRetryCalls).toBe(1);
  });

  it('normalizes string errors when attempts are exhausted', async () => {
    const failing = makeRawTool(async () => {
      throw 'nope';
    });

    const wrapped = retry(failing, { attempts: 1 });
    await expectPromiseToReject(wrapped({ value: 1 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('nope'),
    );
  });

  it('stringifies thrown objects when attempts are exhausted', async () => {
    const failing = makeRawTool(async () => {
      throw { code: 'OBJ_FAIL' };
    });

    const wrapped = retry(failing, { attempts: 1 });
    await expectPromiseToReject(wrapped({ value: 1 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow(JSON.stringify({ code: 'OBJ_FAIL' })),
    );
  });

  it('falls back when thrown objects are not serializable', async () => {
    const circular: any = { code: 'CYCLE' };
    circular.self = circular;
    const failing = makeRawTool(async () => {
      throw circular;
    });

    const wrapped = retry(failing, { attempts: 1 });
    await expectPromiseToReject(wrapped({ value: 1 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('[object Object]'),
    );
  });

  it('throws when the signal is already aborted', async () => {
    const failing = makeRawTool(async () => {
      throw new Error('boom');
    });
    const wrapped = retry(failing, { attempts: 2 });
    const controller = new AbortController();
    controller.abort('cancelled');

    await expectPromiseToReject(
      wrapped.execute(
        { value: 1 },
        {
          signal: controller.signal,
          timeout: 10,
        },
      ),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('cancelled'),
    );
  });

  it('aborts after a failed attempt when the signal is triggered', async () => {
    const failing = makeRawTool(async () => {
      throw new Error('boom');
    });
    const wrapped = retry(failing, { attempts: 2 });

    let checks = 0;
    const signal = new Proxy(new AbortController().signal, {
      get(target, property, receiver) {
        if (property === 'aborted') {
          checks += 1;
          return checks > 1;
        }
        if (property === 'reason') return 'stop';
        if (property === 'addEventListener' || property === 'removeEventListener') {
          return target[property].bind(target);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await expectPromiseToReject(wrapped.execute({ value: 1 }, { signal }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('stop'),
    );
  });

  it('aborts during retry delays when the signal is triggered', async () => {
    const failing = makeRawTool(async () => {
      throw new Error('boom');
    });
    const controller = new AbortController();
    const wrapped = retry(failing, {
      attempts: 3,
      delayMs: 50,
      async sleep(milliseconds, signal) {
        expect(milliseconds).toBe(50);
        controller.abort('delay-stop');
        if (signal?.aborted) {
          throw new Error(String(signal.reason));
        }
      },
    });

    await expectPromiseToReject(
      wrapped.execute({ value: 1 }, { signal: controller.signal }),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('delay-stop'),
    );
  });

  it('uses the default delay before a successful retry', async () => {
    let attempts = 0;
    const flaky = makeRawTool(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('retry once');
      return 'ok';
    });
    const wrapped = retry(flaky, { attempts: 2, delayMs: 1 });

    expect(await wrapped({ value: 1 })).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('supports the retry wait helper without a cancellation signal', async () => {
    expect(await internalRetryTestUtilities.wait(0)).toBeUndefined();
  });

  describe('AB-92/AB-254: RuntimeServices composition', () => {
    it('drives exponential backoff entirely through ManualRuntimeServices.advance, with no real timer', async () => {
      const runtime = createManualRuntimeServices();
      let attempts = 0;
      const failing = makeRawTool(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
        return 'ok';
      });

      const wrapped = retry(failing, {
        attempts: 3,
        delayMs: 100,
        backoff: 'exponential',
        runtime,
      });

      const resultPromise = wrapped({ value: 1 });

      // First failure schedules a 100ms delay before attempt 2.
      await waitUntil(
        () => runtime.pendingTimers().length > 0,
        'retry delay timer armed before attempt 2',
      );
      expect(attempts).toBe(1);
      await runtime.advance(100);
      await waitUntil(() => attempts >= 2, 'attempt 2 to run after the first advance');

      // Second failure schedules the exponential-backoff 200ms delay before
      // attempt 3.
      await waitUntil(
        () => runtime.pendingTimers().length > 0,
        'retry delay timer armed before attempt 3',
      );
      await runtime.advance(200);

      expect(await resultPromise).toBe('ok');
      expect(attempts).toBe(3);
    });

    it('resolves its own default RuntimeServices when none is supplied, unaffected in production behavior', async () => {
      const flaky = makeRawTool(async () => 'ok');
      const wrapped = retry(flaky, { attempts: 1 });
      expect(await wrapped({ value: 1 })).toBe('ok');
    });
  });
});
