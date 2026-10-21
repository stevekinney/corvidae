/**
 * COR-1594 — a schedule fire's end reaches a `bureau.tasks.events` subscriber on a Bureau that did
 * not settle it. Two Bureaus open one SQLite database under `workflow-lease` ownership: one runs
 * the fire, the other serves the stream.
 */
import { stopWhen, type GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  OWNER,
  readFrames,
  subscribeRequest,
} from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  fireOnce,
  handlerOf,
  pollUntil,
} from './schedule-fire-fixtures.test-support';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;

describe('a fire settled on another Bureau ends the stream this one serves', () => {
  it('delivers exactly one terminal status and ends', async () => {
    const path = harness.nextDatabasePath();
    const gate = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<void>();
    const generate: GenerateFunction = async () => {
      parked.resolve();
      await gate.promise;
      return { content: 'all done', toolCalls: [] };
    };
    const options = {
      generate,
      stopWhen: stopWhen.noToolCalls(),
      durableOwnership: OWNERSHIP,
      durableBackgroundTasks: 'automatic' as const,
    };
    const holder = await harness.open({ ...options, storage: await harness.sqliteStorage(path) });
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    const peer = await harness.open({ ...options, storage: await harness.sqliteStorage(path) });

    const reading = readFrames(
      await handlerOf(peer)(
        subscribeRequest('bureau.tasks.events', { taskId: fireId }, 'alice-key'),
      ),
      { timeoutMs: 3_000 },
    );
    reading.catch(() => undefined);
    gate.resolve();
    // The fire is over for the peer too: its task view, read from the shared record, says so.
    await pollUntil(async () => {
      const view = await peer.tasks.get(fireId);
      return view?.status === 'completed' ? true : undefined;
    }, 'the peer to read the fire as completed');
    const frames = await reading;

    expect(frames.map((frame) => frame.event)).toEqual(['task.snapshot', 'task.status']);
    expect(frames.map((frame) => (frame.data as { status?: string }).status)).toEqual([
      'working',
      'completed',
    ]);
  });
});
