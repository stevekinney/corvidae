/**
 * COR-1613 — expired review state goes without a host calling `sweepExpiredReviews`: the Bureau's
 * own maintenance timer runs the sweep, for a schedule fire's approval and a session run's alike.
 */

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen, type Toolbox } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

import { createBureau, EXPIRY_SWEEP_INTERVAL_MILLISECONDS } from './create-bureau';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import { fireOnce, pollUntil, reviewOf } from './schedule-fire-fixtures.test-support';
import { scheduledFireHoldings, scheduledFireReviewStateOf } from './scheduled-fire-review-state';
import type { Bureau } from './types';

const bureaus: Bureau[] = [];
const paths: string[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.shutdown();
  for (const path of paths.splice(0)) {
    removeTemporaryPath(path);
  }
});

describe('expired review state under the automatic maintenance profile', () => {
  it('is removed by the Bureau’s own timer, for a fire and a session run, with no host call', async () => {
    const runtime = createManualRuntimeServices();
    const path = createTemporaryPath('bureau-expiry-maintenance', '.sqlite');
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
    const run = await bureau.createRun({
      agentName: 'bureau',
      message: 'charge',
      principal: OWNER.alice,
    });
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

/** A tool whose every call waits on operator approval, bound for one second. */
function gatedToolbox(runtime: ReturnType<typeof createManualRuntimeServices>): Toolbox {
  return createToolbox(
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
      approvalSecret: 'expiry-lazy-secret',
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
}

const chargesOnce: GenerateFunction = async (context) =>
  context.step > 0
    ? { content: 'done', toolCalls: [] }
    : {
        content: '',
        toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 100 } }],
      };

describe('expired review state of a Bureau with no maintenance timer of its own', () => {
  it('is swept by a timer armed while a tool approval is held, and none is armed once it is gone', async () => {
    const runtime = createManualRuntimeServices();
    // In memory: no durable engine, no governed memory, no audit retention.
    const bureau = await createBureau({
      id: 'expiry-lazy-bureau',
      agents: {},
      storage: { type: 'memory' },
      runtime,
      generate: chargesOnce,
      toolbox: gatedToolbox(runtime),
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
    });
    bureaus.push(bureau);
    // Nothing is held, so no timer keeps the process alive.
    expect(runtime.pendingTimers()).toEqual([]);

    const run = await bureau.createRun({
      agentName: 'bureau',
      message: 'charge',
      principal: OWNER.alice,
    });
    const review = await pollUntil(
      () => bureau.listPendingReviews().find((listed) => listed.runId === run.id),
      'the session run’s approval',
    );
    expect(runtime.pendingTimers()).toHaveLength(1);

    // The approval's binding runs out, and one sweep interval passes. No host call sweeps it.
    await runtime.advance(1500);
    expect(bureau.listPendingReviews()).toEqual([]);
    await runtime.advance(EXPIRY_SWEEP_INTERVAL_MILLISECONDS);
    await pollUntil(async () => {
      const expired = await bureau.getReview(review.id);
      return expired?.status === 'expired' ? true : undefined;
    }, 'the sweep to expire the approval');

    // The sweep found nothing held, so it stopped itself.
    await pollUntil(
      () => (runtime.pendingTimers().length === 0 ? true : undefined),
      'the timer to stop with the last approval',
    );
  });

  it('leaves no timer armed once the approval it was armed for is decided, before any tick', async () => {
    const runtime = createManualRuntimeServices();
    const bureau = await createBureau({
      id: 'expiry-lazy-decided-bureau',
      agents: {},
      storage: { type: 'memory' },
      runtime,
      generate: chargesOnce,
      toolbox: gatedToolbox(runtime),
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({
      agentName: 'bureau',
      message: 'charge',
      principal: OWNER.alice,
    });
    const review = await pollUntil(
      () => bureau.listPendingReviews().find((listed) => listed.runId === run.id),
      'the approval',
    );
    expect(runtime.pendingTimers()).toHaveLength(1);

    await bureau.resolveReview({ id: review.id, decision: 'deny', principal: OWNER.alice });

    // The last approval left, so the timer is gone now, not at the next tick.
    expect(runtime.pendingTimers()).toEqual([]);
  });

  it('keeps its timer armed through a tick that finds the expired approval being decided, and stops it when that ends', async () => {
    const runtime = createManualRuntimeServices();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
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
            return { charged: cents };
          },
        }),
      ],
      {
        approvalSecret: 'expiry-lazy-inflight-secret',
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
      id: 'expiry-lazy-inflight-bureau',
      agents: {},
      storage: { type: 'memory' },
      runtime,
      generate: chargesOnce,
      toolbox,
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({
      agentName: 'bureau',
      message: 'charge',
      principal: OWNER.alice,
    });
    const review = await pollUntil(
      () => bureau.listPendingReviews().find((listed) => listed.runId === run.id),
      'the approval',
    );
    const deciding = bureau.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
    });
    await started.promise;

    // The binding runs out while the tool is still running, and a tick finds the decision in
    // flight: the sweep leaves the approval alone, and the timer, which it still needs, stays.
    await runtime.advance(1500);
    await runtime.advance(EXPIRY_SWEEP_INTERVAL_MILLISECONDS);
    expect(runtime.pendingTimers()).toHaveLength(1);

    gate.resolve();
    await deciding;
    expect(runtime.pendingTimers()).toEqual([]);
  });

  it('is swept by a manual host’s own durable maintenance', async () => {
    const runtime = createManualRuntimeServices();
    const path = createTemporaryPath('bureau-expiry-manual', '.sqlite');
    paths.push(path);
    const bureau = await createBureau({
      id: 'expiry-manual-bureau',
      agents: {},
      storage: { type: 'sqlite', path },
      durableExecution: true,
      durableBackgroundTasks: 'manual',
      runtime,
      generate: chargesOnce,
      toolbox: gatedToolbox(runtime),
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({
      agentName: 'bureau',
      message: 'charge',
      principal: OWNER.alice,
    });
    const review = await pollUntil(
      () => bureau.listPendingReviews().find((listed) => listed.runId === run.id),
      'the session run’s approval',
    );
    // A manual host runs no timer of the Bureau's.
    expect(runtime.pendingTimers()).toEqual([]);

    await runtime.advance(1500);
    await bureau.runDurableMaintenance();

    const expired = await bureau.getReview(review.id);
    expect(expired?.status).toBe('expired');
  });
});
