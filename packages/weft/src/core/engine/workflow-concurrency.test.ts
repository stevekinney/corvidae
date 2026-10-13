import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { rejectionOf, throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { decode } from '../codec.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { WorkflowConcurrencyLimitExceededError } from './errors.ts';
import { getInternals } from './internals.ts';
import {
  buildWorkflowConcurrencyStartOperations,
  releaseWorkflowConcurrencySlotForRun,
} from './workflow-concurrency.ts';

async function* waitForRelease(
  ctx: WorkflowContext,
  input: { value: string },
): AsyncGenerator<unknown, string, unknown> {
  const releaseValue = yield* ctx.waitForSignal<string>('release');
  return `${input.value}:${releaseValue}`;
}

describe('workflow definition concurrency', () => {
  it('rejects non-positive workflow concurrency limits at registration time', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });

    expect(() =>
      engine.register(
        workflow({ name: 'invalid-limit', concurrency: { max: 0 } }).execute(waitForRelease),
      ),
    ).toThrow('registration("invalid-limit").concurrency.max must be a positive integer');
  });

  it('rejects non-function workflow concurrency keys at registration time', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });

    expect(() =>
      engine.register(
        workflow({
          name: 'invalid-key',
          concurrency: { max: 1, key: 'customer-id' as never },
        }).execute(waitForRelease),
      ),
    ).toThrow('registration("invalid-key").concurrency.key must be a function when provided');
  });

  it('rejects excess starts immediately for a workflow-wide limit', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({ name: 'limited-global', concurrency: { max: 1 } }).execute(waitForRelease),
    );

    const first = await engine.start('limited-global', { value: 'first' });

    expect(await rejectionOf(engine.start('limited-global', { value: 'second' }))).toMatchObject({
      code: 'WorkflowConcurrencyLimitExceededError',
      workflowType: 'limited-global',
      limit: 1,
      partitionKey: 'limited-global',
    });

    try {
      await engine.start('limited-global', { value: 'third' });
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowConcurrencyLimitExceededError);
      expect(error).toHaveProperty('partitionKey', 'limited-global');
    }

    await engine.signal(first.id, 'release', 'done');
    expect(await first.result()).toBe('first:done');

    const second = await engine.start('limited-global', { value: 'second' });
    await engine.signal(second.id, 'release', 'done');
    expect(await second.result()).toBe('second:done');
  });

  it('limits starts independently per user-defined partition key', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({
        name: 'limited-by-customer',
        concurrency: {
          max: 1,
          key: (input) => (input as { customerId: string }).customerId,
        },
      }).execute(async function* (ctx: WorkflowContext, input: { customerId: string }) {
        const releaseValue = yield* ctx.waitForSignal<string>('release');
        return `${input.customerId}:${releaseValue}`;
      }),
    );

    const firstAlpha = await engine.start('limited-by-customer', { customerId: 'alpha' });
    const firstBeta = await engine.start('limited-by-customer', { customerId: 'beta' });

    expect(
      await rejectionOf(engine.start('limited-by-customer', { customerId: 'alpha' })),
    ).toMatchObject({
      code: 'WorkflowConcurrencyLimitExceededError',
      workflowType: 'limited-by-customer',
      limit: 1,
      partitionKey: 'alpha',
    });

    await engine.signal(firstAlpha.id, 'release', 'done');
    expect(await firstAlpha.result()).toBe('alpha:done');

    const secondAlpha = await engine.start('limited-by-customer', { customerId: 'alpha' });

    await engine.signal(firstBeta.id, 'release', 'done');
    await engine.signal(secondAlpha.id, 'release', 'done');
    expect(await firstBeta.result()).toBe('beta:done');
    expect(await secondAlpha.result()).toBe('alpha:done');
  });

  it('wraps thrown workflow concurrency key errors with workflow context', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({
        name: 'limited-by-throwing-key',
        concurrency: {
          max: 1,
          key: () => {
            throw new Error('missing customer id');
          },
        },
      }).execute(waitForRelease),
    );

    expect(
      await throwingRejectionOf(engine.start('limited-by-throwing-key', { value: 'first' })),
    ).toThrow(
      'workflow("limited-by-throwing-key").concurrency.key threw while resolving the partition key: missing customer id',
    );
  });

  it('does not consume another slot for a duplicate idempotent start', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({ name: 'limited-idempotent', concurrency: { max: 1 } }).execute(waitForRelease),
    );

    const first = await engine.start(
      'limited-idempotent',
      { value: 'first' },
      { idempotencyKey: 'same-key' },
    );
    const duplicate = await engine.start(
      'limited-idempotent',
      { value: 'ignored' },
      { idempotencyKey: 'same-key' },
    );

    expect(duplicate.id).toBe(first.id);
    expect(
      await rejectionOf(
        engine.start('limited-idempotent', { value: 'second' }, { idempotencyKey: 'other-key' }),
      ),
    ).toBeInstanceOf(WorkflowConcurrencyLimitExceededError);

    await engine.signal(first.id, 'release', 'done');
    expect(await first.result()).toBe('first:done');
  });

  it('releases a recovered running workflow slot when that workflow completes', async () => {
    const original = new TestEngine({ startTime: 1_000 });
    original.register(
      workflow({ name: 'limited-recovered', concurrency: { max: 1 } }).execute(waitForRelease),
    );
    const originalHandle = await original.start('limited-recovered', { value: 'first' });

    const recovered = original.recover();
    original[Symbol.dispose]();
    await using disposableRecovered = recovered;
    disposableRecovered.register(
      workflow({ name: 'limited-recovered', concurrency: { max: 1 } }).execute(waitForRelease),
    );

    const [recoveredHandle] = await disposableRecovered.recoverAll();
    expect(recoveredHandle?.id).toBe(originalHandle.id);

    await disposableRecovered.signal(originalHandle.id, 'release', 'done');
    expect(await recoveredHandle?.result()).toBe('first:done');

    const next = await disposableRecovered.start('limited-recovered', { value: 'second' });
    await disposableRecovered.signal(next.id, 'release', 'done');
    expect(await next.result()).toBe('second:done');
  });

  it('releases a run slot only while its committed state still owns the id', async () => {
    await using engine = new TestEngine({ startTime: 1_000 });
    engine.register(
      workflow({ name: 'limited-release', concurrency: { max: 2 } }).execute(waitForRelease),
    );
    const first = await engine.start('limited-release', { value: 'first' });
    const second = await engine.start('limited-release', { value: 'second' });
    const internals = getInternals(engine);
    const slotKey = KEYS.workflowConcurrency('limited-release', 'limited-release');
    const holderIds = async (): Promise<string[]> => {
      const bytes = await internals.storage.get(slotKey);
      const record = decode(bytes!) as { holders: { holderId: string }[] };
      return record.holders.map((holder) => holder.holderId);
    };
    const fenceFor = async (workflowId: string, committedState?: Uint8Array) => ({
      committedState: committedState ?? (await internals.storage.get(KEYS.workflow(workflowId)))!,
      holderMarker: internals.storage.get(KEYS.workflowConcurrencyHolder(workflowId)),
    });
    expect(await holderIds()).toEqual([first.id, second.id]);

    // Re-acquiring an id that already holds keeps every other holder intact.
    const reacquire = await buildWorkflowConcurrencyStartOperations(
      internals,
      'limited-release',
      second.id,
      { value: 'second' },
      { max: 2 },
    );
    expect(reacquire.operations.length).toBeGreaterThan(0);

    // A run whose committed state no longer owns the id leaves a shared-partition entry and its marker alone.
    await releaseWorkflowConcurrencySlotForRun(
      internals,
      second.id,
      await fenceFor(second.id, new Uint8Array([1])),
    );
    expect(await holderIds()).toEqual([first.id, second.id]);
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(second.id))).not.toBeNull();

    // A run that never held a slot has nothing to release.
    await releaseWorkflowConcurrencySlotForRun(internals, second.id, {
      committedState: new Uint8Array(),
      holderMarker: Promise.resolve(null),
    });
    expect(await holderIds()).toEqual([first.id, second.id]);

    // A marker that does not decode is dropped only by the run that owns the id.
    await internals.storage.put(KEYS.workflowConcurrencyHolder(first.id), new Uint8Array([0xc0]));
    await releaseWorkflowConcurrencySlotForRun(
      internals,
      first.id,
      await fenceFor(first.id, new Uint8Array([1])),
    );
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(first.id))).not.toBeNull();
    await releaseWorkflowConcurrencySlotForRun(internals, first.id, await fenceFor(first.id));
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(first.id))).toBeNull();
    expect(await holderIds()).toEqual([first.id, second.id]);

    // The owning run frees its own entry and marker, and only those.
    await releaseWorkflowConcurrencySlotForRun(internals, second.id, await fenceFor(second.id));
    expect(await holderIds()).toEqual([first.id]);
    expect(await internals.storage.get(KEYS.workflowConcurrencyHolder(second.id))).toBeNull();
  });
});
