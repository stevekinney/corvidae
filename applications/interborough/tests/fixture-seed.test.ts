/**
 * Contract test for `fixtures/workflows.ts`'s `seed()`, run against a REAL `Engine`: the dev
 * harness and the Playwright server seed one run of every demo workflow, and the specs assert on
 * the state each run settles in. If a fixture stops reaching its state, a spec fails on a UI
 * assertion; this test fails with the reason, and runs every fixture's activities and handlers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing';
import { Engine, isWeftFault } from '@lostgradient/weft/testing';

import { FORK_COMPARISON_RUN_ID } from '../fixtures/fork-comparison-ids.ts';
import {
  ORDER_PROCESSING_CANDIDATE_REVISION,
  seedWorkflowRevisions,
} from '../fixtures/workflow-revisions.ts';
import { seed, workflows } from '../fixtures/workflows.ts';

/** One seeded engine for the file: seeding runs every fixture, which takes a second or so. */
let engine: Awaited<ReturnType<typeof createEngine>>;
let items: Awaited<ReturnType<typeof engine.list>>['items'] = [];

function createEngine() {
  return Engine.create({ workflows });
}

beforeAll(async () => {
  engine = await createEngine();
  await seed(engine);
  const listing = await engine.list({});
  items = listing.items;
});

afterAll(async () => {
  await engine[Symbol.asyncDispose]();
});

/** The status of each seeded run, keyed by workflow type, sorted. */
function statusesByType(): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  for (const run of items) {
    byType.set(run.type, [...(byType.get(run.type) ?? []), run.status].toSorted());
  }
  return byType;
}

describe('seed', () => {
  it('settles every run that is meant to end, and leaves the rest running', () => {
    const byType = statusesByType();

    // Runs that end: awaited by the seeder, so their state is committed before it returns.
    expect(byType.get('order-processing')).toEqual(['completed']);
    expect(byType.get('payment-failing')).toEqual(['failed']);
    expect(byType.get('trip-booking-saga')).toEqual(['failed']);
    expect(byType.get('checkout-coordination')).toEqual(['completed']);
    expect(byType.get('audit-trail-sweep')).toEqual(['completed']);
    expect(byType.get('validate-shipment')).toEqual(['completed']);
    expect(byType.get('fulfillment-parent')).toEqual(['completed']);
    expect(byType.get('system-failure-demo')).toEqual(['failed']);
    expect(byType.get('timeout-failure-demo')).toEqual(['failed']);
    expect(byType.get('resource-failure-demo')).toEqual(['failed']);
    expect(byType.get('cancellation-failure-demo')).toEqual(['failed']);
    expect(byType.get('sandbox-session')).toEqual(['cancelled']);

    // Runs that wait by design.
    expect(byType.get('long-sleeper')).toEqual(['running']);
    expect(byType.get('review-gate')).toEqual(['running']);
    expect(byType.get('markdown-review')).toEqual(['running']);
    expect(byType.get('signal-stepped')).toEqual(['running']);
    expect(byType.get('ship-package-async')).toEqual(['running']);
    expect(byType.get('monitor-delivery')).toEqual(['running']);
  });

  it('records the long history the timeline views are built to virtualize', async () => {
    const sweep = items.find((run) => run.type === 'audit-trail-sweep');
    expect(sweep).toBeDefined();
    const state = await engine.get(sweep!.id);
    expect(state).toMatchObject({ status: 'completed', result: { finalValue: 220 } });
  });

  it('seeds a run whose newest checkpoint, the first row of the checkpoint list, keeps one step and runs one again (COR-2538)', async () => {
    const checkpoints = await engine.listCheckpoints(FORK_COMPARISON_RUN_ID);
    // The list is newest first, so the first row is the one the end-to-end spec forks from.
    const newest = checkpoints[0];
    expect(newest).toBeDefined();

    const preview = await engine.previewFork(FORK_COMPARISON_RUN_ID, { fromStep: newest!.step });

    expect(preview.keptSteps.map((step) => step.label)).toEqual(['reserveStock']);
    expect(preview.rerunSteps.map((step) => step.label)).toEqual(['issueTicket']);
  });

  it('refuses a fork dry run for the candidate revision the fork spec picks, as the fork itself is refused (COR-2538)', async () => {
    await seedWorkflowRevisions(engine);
    const order = items.find((run) => run.type === 'order-processing');
    expect(order).toBeDefined();

    const refusal = await rejectionOf(
      engine.previewFork(order!.id, { revision: ORDER_PROCESSING_CANDIDATE_REVISION }),
    );

    // The dialog frames a refused preview as a revision conflict by this error's reason, which the
    // server's JSON-RPC fault carries as `data.reason` beside the coarse `Conflict`.
    expect(isWeftFault(refusal, 'WorkflowRevisionUnavailableError')).toBe(true);
    expect(Reflect.get(refusal as object, 'reason')).toBe('not-registered');
  });

  it('seeds a run whose fork from the last checkpoint answers a different ticket than the source (COR-2538)', async () => {
    const fork = await engine.fork(FORK_COMPARISON_RUN_ID);
    await fork.result();

    const comparison = await engine.compare(fork.id);

    expect(comparison.sourceWorkflowId).toBe(FORK_COMPARISON_RUN_ID);
    const shared = comparison.steps.find((step) => step.index === 0);
    const reran = comparison.steps.find((step) => step.index === 1);
    expect(shared).toMatchObject({ shared: true });
    expect(reran?.shared).toBe(false);
    // The fork ran `issueTicket` again, so the next ticket number is in its output and not the source's.
    expect(reran?.source?.output).not.toBe(reran?.fork?.output);
    expect(reran?.source?.output).toContain('"ticket"');
    expect(reran?.fork?.output).toContain('"ticket"');
  });
});
