/**
 * A session run's tool approval while its approve is in flight (COR-1613). The decision in flight
 * owns the review, but the review is still pending until it lands: it stays listed, and a second
 * resolve of the same id is refused as one already being resolved, not as one that does not exist.
 * The automatic sweep is the only reader that skips a review being resolved.
 */
import { stopWhen, type Toolbox, createAgent } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { BureauError } from './create-bureau';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import { createScheduleFireHarness, pollUntil } from './schedule-fire-fixtures.test-support';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';

const harness = createScheduleFireHarness();
afterEach(async () => {
  await harness.dispose();
});

describe('a session-run approval whose approve is in flight', () => {
  it('stays listed, and a second resolve is refused as already being resolved', async () => {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const charges: number[] = [];
    const toolbox = createToolbox(
      [
        createTool({
          name: 'charge-card',
          version: '1.0.0',
          description: 'Charge a payment card',
          input: z.object({ cents: z.number() }),
          async execute({ cents }) {
            started.resolve();
            await gate.promise;
            charges.push(cents);
            return { charged: cents };
          },
        }),
      ],
      {
        approvalSecret: 'in-flight-secret',
        policy: {
          beforeExecute: () => ({
            allow: false,
            status: 'needs_approval',
            reason: 'Operator approval required',
            action: { message: 'Approve charge' },
          }),
        },
      },
    ) as unknown as Toolbox;
    const bureau = await harness.open({
      storage: await harness.sqliteStorage(harness.nextDatabasePath()),
      agents: {
        default: createAgent({
          generate: async (context) =>
            context.step === 0
              ? {
                  content: '',
                  toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 7 } }],
                }
              : { content: 'done', toolCalls: [] },
          toolbox,
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
    });
    const run = await bureau.tasks.start('default', 'charge', { principal: OWNER.alice });
    const review = await pollUntil(
      () => bureau.reviews.list().find((candidate) => candidate.runId === run.id),
      'the approval',
    );

    const first = bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
    });
    await started.promise;

    expect(bureau.reviews.list().some((candidate) => candidate.id === review.id)).toBe(true);
    const second = await rejectionOf(
      bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: OWNER.alice }),
    );
    expect((second as BureauError).code).toBe('CONFLICT');
    expect((second as Error).message).toContain('already being resolved');

    gate.resolve();
    await first;
    expect(charges).toEqual([7]);
  });
});
