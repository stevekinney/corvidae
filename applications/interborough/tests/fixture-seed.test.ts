/**
 * Contract test for `fixtures/workflows.ts`'s `seed()`, run against a REAL `Engine`: the dev
 * harness and the Playwright server seed one run of every demo workflow, and the specs assert on
 * the state each run settles in. If a fixture stops reaching its state, a spec fails on a UI
 * assertion; this test fails with the reason, and runs every fixture's activities and handlers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { Engine } from '@lostgradient/weft';

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
});
