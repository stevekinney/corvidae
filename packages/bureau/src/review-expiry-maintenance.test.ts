/**
 * COR-1613 — expired review state goes without a host calling `sweepExpiredReviews`: the Bureau's
 * own maintenance timer runs the sweep, for a schedule fire's approval and a session run's alike.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen, type Toolbox } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import { fireOnce, pollUntil, reviewOf } from './schedule-fire-fixtures.test-support';
import { scheduledFireHoldings, scheduledFireReviewStateOf } from './scheduled-fire-review-state';
import type { Bureau } from './types';

const bureaus: Bureau[] = [];
const paths: string[] = [];
let counter = 0;

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.shutdown();
  for (const path of paths.splice(0)) {
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
  }
});

describe('expired review state under the automatic maintenance profile', () => {
  it('is removed by the Bureau’s own timer, for a fire and a session run, with no host call', async () => {
    const runtime = createManualRuntimeServices();
    const path = join(tmpdir(), `bureau-expiry-maintenance-${process.pid}-${counter++}.sqlite`);
    paths.push(path);
    let calls = 0;
    const generate: GenerateFunction = async (context) => {
      if (context.step > 0) return { content: 'done', toolCalls: [] };
      calls += 1;
      return {
        content: '',
        toolCalls: [{ id: `charge-${calls}`, name: 'charge-card', arguments: { cents: 100 } }],
      };
    };
    const toolbox = createToolbox(
      [
        createTool({
          name: 'charge-card',
          version: '1.0.0',
          description: 'Charge a payment card',
          input: z.object({ cents: z.number() }),
          async execute({ cents }) {
            return { charged: cents };
          },
        }),
      ],
      {
        approvalSecret: 'expiry-maintenance-secret',
        approvalBindingTtlMs: 1000,
        runtime,
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
    const bureau = await createBureau({
      id: 'expiry-maintenance-bureau',
      agents: {},
      storage: { type: 'sqlite', path },
      durableExecution: true,
      // The default profile: the Bureau runs its own maintenance timer.
      runtime,
      generate,
      toolbox,
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
    });
    bureaus.push(bureau);

    const { fireId } = await fireOnce(bureau, OWNER.alice, 'maintenance-session');
    const fireReview = await reviewOf(bureau, fireId);
    const run = await bureau.createRun({ message: 'charge', principal: OWNER.alice });
    const runReview = await pollUntil(
      () => bureau.listPendingReviews().find((review) => review.runId === run.id),
      'the session run’s approval',
    );

    // Both approvals expire, and one maintenance interval passes. No host call sweeps them.
    await runtime.advance(1500);
    expect(bureau.listPendingReviews()).toEqual([]);
    await runtime.advance(300_000);

    await pollUntil(async () => {
      const fire = await bureau.getReview(fireReview.id);
      const sessionRun = await bureau.getReview(runReview.id);
      return fire?.status === 'expired' && sessionRun?.status === 'expired' ? true : undefined;
    }, 'the maintenance pass to expire both approvals');
    await pollUntil(
      () =>
        scheduledFireHoldings(scheduledFireReviewStateOf(bureau), fireId).length === 0
          ? true
          : undefined,
      'the fire’s approval state to be released',
    );
    const session = await bureau.getSession('maintenance-session');
    expect(Object.keys((session?.metadata['pendingApprovalOverrides'] as object) ?? {})).toEqual(
      [],
    );
  });
});
