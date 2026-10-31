/**
 * A host registers a document activity either as a bare handler or as a definition that also
 * declares how Weft runs it (retry, per-attempt timeout, verification). The settings must reach
 * the step: a definition that only ever contributed its `execute` would run once, unbounded.
 */
import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';

import { Engine } from '../core/engine/index.ts';
import { waitForParityCondition } from '../core/parity/real-timer-wait.test-support.ts';
import type { ActivityContext } from '../core/types.ts';
import { TestEngine } from '../testing/test-engine.ts';
import type { DocumentActivity, DocumentWorkflowHost } from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

function hostWith(activity: DocumentActivity): DocumentWorkflowHost {
  return { activities: { work: activity }, triggerKinds: { manual: () => undefined } };
}

const document = {
  name: 'settings',
  trigger: { kind: 'manual' },
  steps: [{ kind: 'activity', handler: 'work' }],
};

async function resultOf(activity: DocumentActivity, id: string): Promise<unknown> {
  await using engine = new Engine();
  await registerWorkflowDocuments(engine, hostWith(activity), { active: [document] });
  const handle = await engine.start('settings', null, { id });
  return await handle.result();
}

describe('a document activity registered as a definition', () => {
  it('runs a bare handler as it always did', async () => {
    expect(await resultOf(() => 'plain', 'bare')).toBe('plain');
  });

  it('runs a definition without settings once', async () => {
    expect(await resultOf({ execute: () => 'defined' }, 'defined')).toBe('defined');
  });

  it('retries by its own retry policy and succeeds on the third attempt', async () => {
    using engine = new TestEngine({ startTime: 0 });
    const attempts: number[] = [];
    await registerWorkflowDocuments(
      engine,
      hostWith({
        retry: { maxAttempts: 3, initialBackoff: 100, backoffMultiplier: 2, maxBackoff: 1_000 },
        execute: () => {
          attempts.push(engine.now);
          if (attempts.length < 3) throw new Error(`attempt ${attempts.length} failed`);
          return `succeeded after ${attempts.length}`;
        },
      }),
      { active: [document] },
    );
    const handle = await engine.start('settings', null, { id: 'retried' });
    await waitForParityCondition(() => attempts.length === 1, { label: 'the first attempt' });
    await engine.advanceTime(100);
    await waitForParityCondition(() => attempts.length === 2, { label: 'the second attempt' });
    await engine.advanceTime(200);
    expect(await handle.result()).toBe('succeeded after 3');
    expect(attempts).toEqual([0, 100, 300]);
  });

  it('fails with the last error when the retry policy is exhausted', async () => {
    using engine = new TestEngine({ startTime: 0 });
    let attempts = 0;
    await registerWorkflowDocuments(
      engine,
      hostWith({
        retry: { maxAttempts: 2, initialBackoff: 50, backoffMultiplier: 2, maxBackoff: 500 },
        execute: () => {
          attempts += 1;
          throw new Error(`failure ${attempts}`);
        },
      }),
      { active: [document] },
    );
    const handle = await engine.start('settings', null, { id: 'exhausted' });
    await waitForParityCondition(() => attempts === 1, { label: 'the first attempt' });
    await engine.advanceTime(50);
    expect(await throwingRejectionOf(handle.result())).toThrow('failure 2');
    expect(attempts).toBe(2);
  });

  it('bounds an attempt by its own timeout, and aborts the signal its activity was given', async () => {
    let sawAbort = false;
    await using engine = new Engine();
    await registerWorkflowDocuments(
      engine,
      hostWith({
        timeout: 50,
        execute: (_argument: unknown, context?: ActivityContext) =>
          new Promise<never>((_resolve, reject) => {
            context?.signal.addEventListener('abort', () => {
              sawAbort = true;
              reject(new Error('aborted'));
            });
          }),
      }),
      { active: [document] },
    );
    const handle = await engine.start('settings', null, { id: 'timed-out' });
    expect(await throwingRejectionOf(handle.result())).toThrow('per-attempt timeout of 50ms');
    expect(sawAbort).toBe(true);
  });

  it('gives a bare handler the activity context as well', async () => {
    let signal: unknown;
    const result = await resultOf((_argument, context) => {
      signal = context?.signal;
      return 'ran';
    }, 'context');
    expect(result).toBe('ran');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('holds a result to its verifier', async () => {
    await using engine = new Engine();
    await registerWorkflowDocuments(
      engine,
      hostWith({
        verify: () => false,
        execute: () => 'unverified',
      }),
      { active: [document] },
    );
    const handle = await engine.start('settings', null, { id: 'verified' });
    expect(await throwingRejectionOf(handle.result())).toThrow();
  });
});
