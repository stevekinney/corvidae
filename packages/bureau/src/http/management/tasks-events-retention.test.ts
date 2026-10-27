/**
 * `bureau.tasks.events` below the retention floor: a resume that asks for events the
 * history has dropped yields exactly one gap element and then what remains, and a
 * subscription that names no cursor is unaffected.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from '../../create-bureau.ts';
import { waitForCondition } from '../../test';
import { createSqliteStorageFixture } from '../../test/storage-fixtures';
import { createBureauHandler } from '../create-bureau-handler.ts';
import {
  approvalToolbox,
  authentication,
  chargesOnce,
  OWNER,
  readFrames,
  subscribeRequest,
} from './management-fixtures.test-support.ts';
import { createMemoryAssetStorage } from '../../assets/storage';
import type { AgentDefinitions } from '../../agent-catalog';

const ORIGIN = '2026-10-18T00:00:00.000Z';
const DAY_MS = 86_400_000;
const finishes: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });

describe('bureau.tasks.events below the retention floor', () => {
  it('yields exactly one gap element for a resume below the floor, then the retained events', async () => {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const fixture = createSqliteStorageFixture({ runtime });
    const bureau = await createBureau<AgentDefinitions>({
      assets: { storage: createMemoryAssetStorage() },
      id: 'retention-bureau',
      agents: {
        default: createAgent({
          generate: finishes,
          stopWhen: stopWhen.noToolCalls(),
          toolbox: createToolbox<readonly Tool[]>([]),
        }),
      },
      runtime,
      storage: fixture.configuration,
      durable: true,
      durableOwnership: { ownership: 'none' },
      maintenance: 'manual',
    });
    try {
      const handler = createBureauHandler(bureau, { authentication });
      const first = await bureau.tasks.start('default', 'first', { principal: OWNER.alice });
      await waitForCondition(() => bureau.tasks.detail(first.id)?.status === 'completed', 'first');
      await runtime.deferred.drain();

      const whole = await readFrames(
        await handler(subscribeRequest('bureau.tasks.events', { taskId: first.id }, 'alice-key')),
      );
      expect(whole.map((frame) => frame.event)).toEqual(['task.snapshot', 'task.status']);

      // Everything the first task recorded is now older than the window, and a later
      // task's events sit above the floor the maintenance pass leaves.
      runtime.setTime(Date.parse(ORIGIN) + 7 * DAY_MS + 1);
      await bureau.runDurableMaintenance();
      const second = await bureau.tasks.start('default', 'second', { principal: OWNER.alice });
      await waitForCondition(
        () => bureau.tasks.detail(second.id)?.status === 'completed',
        'second',
      );
      await runtime.deferred.drain();

      const resumed = await readFrames(
        await handler(
          subscribeRequest('bureau.tasks.events', { taskId: first.id }, 'alice-key', '0'),
        ),
      );
      const fresh = await readFrames(
        await handler(subscribeRequest('bureau.tasks.events', { taskId: first.id }, 'alice-key')),
      );

      expect(resumed.map((frame) => frame.event)).toEqual(['task.gap']);
      expect(resumed[0]?.data).toMatchObject({
        taskId: first.id,
        requestedCursor: '0',
        firstRetainedCursor: expect.any(String) as unknown,
      });
      // A subscription that names no cursor asks for no history, so there is nothing to lose.
      expect(fresh.map((frame) => frame.event)).not.toContain('task.gap');
      expect(fresh[0]?.event).toBe('task.snapshot');
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });

  it('yields the gap and then the events that remain, ending at the terminal status', async () => {
    let calls = 0;
    const parksThenAnswers: GenerateFunction = async () => {
      calls += 1;
      return calls === 1
        ? {
            content: '',
            toolCalls: [
              {
                id: 'wait-1',
                name: 'requestHumanInput',
                arguments: { signalName: 'human-response', prompt: 'Approve?' },
              },
            ],
          }
        : { content: 'resolved', toolCalls: [] };
    };
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const fixture = createSqliteStorageFixture({ runtime });
    const bureau = await createBureau<AgentDefinitions>({
      assets: { storage: createMemoryAssetStorage() },
      id: 'retention-bureau-two',
      agents: {
        default: createAgent({
          generate: parksThenAnswers,
          toolbox: createToolbox<readonly Tool[]>([]),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
      runtime,
      storage: fixture.configuration,
      durable: true,
      durableOwnership: { ownership: 'none' },
      maintenance: 'manual',
    });
    try {
      const handler = createBureauHandler(bureau, { authentication });
      const run = await bureau.tasks.start('default', 'park', { principal: OWNER.alice });
      await waitForCondition(
        () => bureau.reviews.list().some((review) => review.runId === run.id),
        'the run never parked',
      );
      await runtime.deferred.drain();
      await waitForCondition(async () => {
        const page = await bureau.tasks.events(run.id);
        return 'events' in page && page.events.some((event) => event.kind === 'review.requested');
      }, 'review.requested never reached the history');

      // The request for input falls out of the window, and the answer arrives after it.
      runtime.setTime(Date.parse(ORIGIN) + 7 * DAY_MS + 1);
      await bureau.runDurableMaintenance();
      const [review] = bureau.reviews.list();
      await bureau.reviews.resolve({
        id: review!.id,
        decision: 'approve',
        principal: OWNER.alice,
        payload: 'yes',
      });
      await waitForCondition(
        () => bureau.tasks.detail(run.id)?.status === 'completed',
        'completion',
      );
      await runtime.deferred.drain();

      const frames = await readFrames(
        await handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key', '0'),
        ),
      );

      expect(frames.map((frame) => frame.event)).toEqual([
        'task.gap',
        'task.status',
        'task.status',
      ]);
      expect(frames.filter((frame) => frame.event === 'task.gap')).toHaveLength(1);
      expect(frames.slice(1).map((frame) => (frame.data as { status: string }).status)).toEqual([
        'working',
        'completed',
      ]);

      // A subscription that names no cursor reads the same retained events behind its snapshot.
      const fresh = await readFrames(
        await handler(subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key')),
      );
      expect(fresh.map((frame) => frame.event)).toEqual([
        'task.snapshot',
        'task.status',
        'task.status',
      ]);
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });

  it('does not undo a terminal snapshot with a retained review event whose settlement was pruned', async () => {
    const charges: number[] = [];
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const fixture = createSqliteStorageFixture({ runtime });
    const bureau = await createBureau<AgentDefinitions>({
      assets: { storage: createMemoryAssetStorage() },
      id: 'retention-bureau-three',
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
      runtime,
      storage: fixture.configuration,
      durable: true,
      // A short window, so the floor passes the settlement while the approval is still valid.
      retention: { events: { olderThan: 1_000 } },
      durableOwnership: { ownership: 'none' },
      maintenance: 'manual',
    });
    try {
      const handler = createBureauHandler(bureau, { authentication });
      const run = await bureau.tasks.start('default', 'charge', { principal: OWNER.alice });
      await waitForCondition(
        () => bureau.reviews.list().some((review) => review.runId === run.id),
        'the approval never became pending',
      );
      await waitForCondition(async () => {
        const page = await bureau.tasks.events(run.id);
        return 'events' in page && page.events.some((event) => event.kind === 'run.completed');
      }, 'run.completed never reached the history');
      await runtime.deferred.drain();

      // The request and the settlement fall out of the window; the decision comes after it.
      runtime.setTime(Date.parse(ORIGIN) + 2_000);
      await bureau.runDurableMaintenance();
      const [review] = bureau.reviews.list();
      await bureau.reviews.resolve({ id: review!.id, decision: 'deny', principal: OWNER.alice });
      await waitForCondition(async () => {
        let page = await bureau.tasks.events(run.id);
        if ('outcome' in page && page.outcome === 'gap') {
          page = await bureau.tasks.events(run.id, {
            since: String(page.firstRetainedSequence - 1),
          });
        }
        return 'events' in page && page.events.some((event) => event.kind === 'review.denied');
      }, 'review.denied never reached the history');
      await runtime.deferred.drain();
      const task = await bureau.internals.taskRegistry.get(run.id);

      const frames = await readFrames(
        await handler(subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key')),
      );

      expect(task?.status).toBe('completed');
      const statuses = frames.map((frame) => (frame.data as { status: string }).status);
      expect(statuses[0]).toBe('completed');
      expect(statuses).not.toContain('working');
      expect(statuses.at(-1)).toBe('completed');
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });
});
