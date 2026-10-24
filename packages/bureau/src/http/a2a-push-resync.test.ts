/**
 * Push after a lost `run.completed` append (COR-1669, part 2b-3b): the Bureau repairs the history
 * with a `task.resynced`, and the push pump delivers that repair as the task's final status, so a
 * webhook still receives exactly one COMPLETED.
 */
import type { GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { faultyStorage } from './a2a-faulty-storage.test-support.ts';
import {
  call,
  eventually,
  message,
  openPushBureau,
  type PushFixture,
  webhook,
} from './a2a-push.test-support.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const answering: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });

describe('push across a lost run.completed append', () => {
  it('delivers the repair as the final status: exactly one COMPLETED', async () => {
    const { storage, faults } = await faultyStorage(cleanups);
    faults.failCompletions = 1;
    const fixture: PushFixture = await openPushBureau(answering, { bureauStorage: storage });
    cleanups.push(() => fixture.dispose());
    fixture.startDelivery();

    const sent = await call(fixture, 'SendMessage', {
      message: message('go'),
      configuration: { returnImmediately: true, taskPushNotificationConfig: webhook(fixture) },
    });
    expect(sent.error).toBeUndefined();

    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));
    // Give a second, wrongly duplicated delivery time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      fixture.receiver.kinds().filter((kind) => kind === 'status:TASK_STATE_COMPLETED'),
    ).toHaveLength(1);
    expect(faults.failCompletions).toBe(0);
  });
});
