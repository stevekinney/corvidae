// COR-1481 — a review becoming pending is a durable event, so a task stream can show a
// task entering `input-required` the way an A2A status update does.

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { createSqliteStorageFixture } from './test/storage-fixtures';

type HistoryEvent = { kind: string; payload: unknown };

async function runEvents(
  bureau: Awaited<ReturnType<typeof createBureau>>,
  runId: string,
): Promise<HistoryEvent[]> {
  const page = await bureau.eventHistory({ kind: 'run', id: runId });
  if (!('events' in page)) throw new Error(`no event page: ${JSON.stringify(page)}`);
  return page.events.map((event) => ({ kind: event.kind, payload: event.payload }));
}

describe('review.requested', () => {
  it('records a human wait as a durable event holding ids and the signal name, never the prompt', async () => {
    let calls = 0;
    const generate: GenerateFunction = async () => {
      calls++;
      return calls === 1
        ? {
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'requestHumanInput',
                arguments: { signalName: 'human-response', prompt: 'Secret prompt text?' },
              },
            ],
          }
        : { content: 'done', toolCalls: [] };
    };
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    const bureau = await createBureau({
      id: 'review-requested-human',
      agents: {},
      generate,
      toolbox: createToolbox([]),
      storage: fixture.configuration,
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });
    try {
      const run = await bureau.createRun({ message: 'park-me', principal: 'api-key:tester' });
      await waitForCondition(
        () => bureau.listPendingReviews().some((review) => review.runId === run.id),
        'expected the run to park',
      );
      const [review] = bureau.listPendingReviews();
      await waitForCondition(async () => {
        const events = await runEvents(bureau, run.id);
        return events.some((event) => event.kind === 'review.requested');
      }, 'expected review.requested to reach the durable history');

      const recorded = await runEvents(bureau, run.id);
      const requested = recorded.filter((event) => event.kind === 'review.requested');
      expect(requested).toHaveLength(1);
      expect(requested[0]?.payload).toEqual({
        reviewId: review?.id,
        runId: run.id,
        principal: 'api-key:tester',
        kind: 'human-wait',
        signalName: 'human-response',
      });
      expect(JSON.stringify(requested)).not.toContain('Secret prompt text');
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });

  it('records a tool approval as a durable event holding ids and the call id, never the arguments', async () => {
    const charges: number[] = [];
    const toolbox = createToolbox(
      [
        createTool({
          name: 'charge-card',
          version: '1.0.0',
          description: 'Charge a payment card',
          input: z.object({ cents: z.number() }),
          async execute({ cents }) {
            charges.push(cents);
            return { charged: cents };
          },
        }),
      ],
      {
        approvalSecret: 'review-requested-secret',
        policy: {
          beforeExecute() {
            return {
              allow: false,
              status: 'needs_approval',
              reason: 'Operator approval required',
              action: { message: 'Approve charge' },
            };
          },
        },
      },
    ) as unknown as Toolbox;
    const generate: GenerateFunction = async () => ({
      content: '',
      toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 424242 } }],
    });
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    const bureau = await createBureau({
      id: 'review-requested-approval',
      agents: {},
      generate,
      toolbox,
      storage: fixture.configuration,
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'charge', principal: 'api-key:tester' });
      await waitForCondition(
        () => bureau.listPendingReviews().some((review) => review.runId === run.id),
        'expected the approval to be pending',
      );
      const [review] = bureau.listPendingReviews();
      await waitForCondition(async () => {
        const events = await runEvents(bureau, run.id);
        return events.some((event) => event.kind === 'review.requested');
      }, 'expected review.requested to reach the durable history');

      const recorded = await runEvents(bureau, run.id);
      const requested = recorded.filter((event) => event.kind === 'review.requested');
      expect(requested).toHaveLength(1);
      expect(requested[0]?.payload).toEqual({
        reviewId: review?.id,
        runId: run.id,
        principal: 'api-key:tester',
        kind: 'tool-approval',
        callId: 'charge-1',
      });
      // The tool arguments (`{ cents: 424242 }`) never reach the event. Matched by the key, not the
      // number, which a clock reading or an id can contain by chance.
      expect(JSON.stringify(requested)).not.toContain('"cents"');
      expect(charges).toEqual([]);
    } finally {
      await bureau.dispose();
      await fixture.dispose();
    }
  });
});
