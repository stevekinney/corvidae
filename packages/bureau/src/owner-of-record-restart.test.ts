import {
  type GenerateFunction,
  stopWhen,
  SESSION_OWNER_METADATA_KEY,
  createAgent,
} from '@lostgradient/operative';
import type { Storage } from '@lostgradient/storage';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import {
  answering,
  createCheckValidator,
  goalRequest,
  pollUntil,
  TERMINAL_STATUSES,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import { waitForCondition } from './test';
import type { AgentDefinitions } from './agent-catalog';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const ALICE = 'api-key:alice';

/** Parks on `requestHumanInput` the first time it is asked, and finishes after that. */
function parkingGenerate(): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls > 1) return { content: 'approved and processed', toolCalls: [] };
    return {
      content: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'requestHumanInput',
          arguments: { signalName: 'human-response', prompt: 'Approve this?' },
        },
      ],
    };
  };
}

async function openBureau(storage: Storage) {
  return createBureau<AgentDefinitions>({
    id: 'owner-restart',
    agents: {
      worker: workerAgent(answering('done')),
      default: createAgent({
        generate: parkingGenerate(),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      }),
    },
    validators: [createCheckValidator()],
    storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
}

describe('every kind of resource keeps its owner across a restart (COR-718)', () => {
  it('reads back the owner of a run, session, child run, goal, schedule, review, and audit entry', async () => {
    const database = createSqliteStorageFixture();
    const first = await openBureau(database.storage);
    let reopened: Awaited<ReturnType<typeof openBureau>> | undefined;
    try {
      const run = await first.tasks.start('default', 'park', { principal: ALICE });
      await waitForCondition(
        () => first.reviews.list().some((review) => review.runId === run.id),
        'the run never parked on a human wait',
      );
      const [review] = first.reviews.list();

      const dispatched = await first.children.dispatch({
        parentRunId: run.id,
        agentName: 'worker',
        input: 'help',
        childRunId: 'owner-child',
      });
      expect(dispatched).toMatchObject({ outcome: 'started', child: { principal: ALICE } });
      await first.children.wait({ parentRunId: run.id, childRunId: 'owner-child' });

      expect(
        await first.goals.create(goalRequest({ goalRunId: 'g-owned', principal: ALICE })),
      ).toMatchObject({
        outcome: 'created',
      });
      expect(
        await pollUntil(async () => {
          const goal = await first.goals.get('g-owned');
          return (TERMINAL_STATUSES as readonly string[]).includes(goal?.status ?? '');
        }),
      ).toBe(true);

      const schedule = await first.schedules.create({
        agentName: 'worker',
        input: 'tick',
        spec: '1h',
        principal: ALICE,
      });
      if (schedule === undefined) throw new Error('expected a schedule');

      await first.reviews.resolve({
        id: review!.id,
        decision: 'approve',
        principal: 'api-key:reviewer',
      });
      await waitForCondition(
        () => first.tasks.detail(run.id)?.status !== 'running',
        'the approved run never finished',
      );
      await first.dispose();

      const second = await openBureau(await database.reopen());
      reopened = second;
      const owner = (resource: Parameters<typeof second.ownerOf>[0]) => second.ownerOf(resource);

      expect(await owner({ kind: 'run', id: run.id })).toBe(ALICE);
      expect(await owner({ kind: 'session', id: run.contextId })).toBe(ALICE);
      const session = await second.contexts.get(run.contextId);
      expect(session?.metadata[SESSION_OWNER_METADATA_KEY]).toBe(ALICE);
      expect(await owner({ kind: 'run', id: 'owner-child' })).toBe(ALICE);
      expect(await owner({ kind: 'goal', id: 'g-owned' })).toBe(ALICE);
      expect(await owner({ kind: 'schedule', id: schedule.id })).toBe(ALICE);
      expect(await owner({ kind: 'review', id: review!.id })).toBe(ALICE);
      expect(await owner({ kind: 'audit', runId: run.id })).toBe(ALICE);
      expect(await owner({ kind: 'audit', runId: `schedule:${schedule.id}` })).toBe(ALICE);

      // The actor on the review's audit entry is whoever resolved it, not the owner.
      const decisions = await second.internals.auditTrail?.query({ runId: run.id });
      expect(
        decisions
          ?.filter((entry) => entry.type.startsWith('review.'))
          .map((entry) => entry.principal),
      ).toEqual(['api-key:reviewer']);
    } finally {
      await reopened?.dispose();
      await database.dispose();
    }
  });
});
