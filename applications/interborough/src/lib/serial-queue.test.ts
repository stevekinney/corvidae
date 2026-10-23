import { rejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';

import { createSerialQueue } from './serial-queue.ts';

/** A promise settled by hand, so a test chooses when a write finishes. */
function gate<Result = void>() {
  let release!: (value: Result) => void;
  const promise = new Promise<Result>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

describe('createSerialQueue', () => {
  test('starts a write only after the one before it has settled, in the order they were queued', async () => {
    const queue = createSerialQueue();
    const first = gate();
    const started: string[] = [];

    const one = queue.run(async () => {
      started.push('one');
      await first.promise;
      return 1;
    });
    const two = queue.run(async () => {
      started.push('two');
      return 2;
    });

    await Promise.resolve();
    expect(started).toEqual(['one']);
    expect(queue.pending).toBe(2);

    first.resolve();
    expect(await Promise.all([one, two])).toEqual([1, 2]);
    expect(started).toEqual(['one', 'two']);
    expect(queue.pending).toBe(0);
  });

  test('hands a failed write to its caller and still runs the writes behind it', async () => {
    const queue = createSerialQueue();
    const failed = queue.run(() => Promise.reject(new Error('refused')));
    const next = queue.run(async () => 'ran');

    const refusal = await rejectionOf(failed);
    expect((refusal as Error).message).toBe('refused');
    expect(await next).toBe('ran');
    expect(queue.pending).toBe(0);
  });
});
