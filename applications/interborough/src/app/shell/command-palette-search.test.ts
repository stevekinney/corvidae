/**
 * The command palette's search. It searches schedules only when the principal
 * holds `schedules:read`, which `weft.schedules.list` requires; without it the
 * read is skipped rather than sent and answered with a fault.
 */
import type { HttpClient } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { searchConsole } from './command-palette-search.ts';

const OPEN = { disabled: false, title: undefined } as const;
const LOCKED = { disabled: true, title: 'Requires schedules:read' } as const;

function fakeClient(calls: { schedules: number }): HttpClient {
  return {
    list: async () => ({
      items: [
        { id: 'nightly-order', type: 'order' },
        { id: 'weekly-order', type: 'order' },
      ],
      total: 2,
    }),
    listSchedules: async () => {
      calls.schedules += 1;
      return {
        items: [
          { id: 'nightly-rollup', workflowType: 'sweep' },
          { id: 'weekly-digest', workflowType: 'digest' },
        ],
      };
    },
    listReviews: async () => [{ reviewId: 'nightly-review' }, { reviewId: 'other-review' }],
    operations: {
      'weft.workers.list': async () => ({
        items: [
          { id: 'nightly-worker', queue: 'default' },
          { id: 'other-worker', queue: 'default' },
        ],
      }),
    },
  } as unknown as HttpClient;
}

describe('searchConsole', () => {
  test('searches workflows, schedules, workers, and reviews with schedules:read', async () => {
    const calls = { schedules: 0 };

    const results = await searchConsole(fakeClient(calls), 'nightly', { scheduleReadGate: OPEN });

    expect(results.workflows.map((workflow) => workflow.id)).toEqual(['nightly-order']);
    expect(results.schedules.map((schedule) => schedule.id)).toEqual(['nightly-rollup']);
    expect(results.workers.map((worker) => worker.id)).toEqual(['nightly-worker']);
    expect(results.reviews.map((review) => review.reviewId)).toEqual(['nightly-review']);
    expect(calls.schedules).toBe(1);
  });

  test('skips the schedule read, and returns no schedules, without schedules:read', async () => {
    const calls = { schedules: 0 };

    const results = await searchConsole(fakeClient(calls), 'nightly', {
      scheduleReadGate: LOCKED,
    });

    expect(calls.schedules).toBe(0);
    expect(results.schedules).toEqual([]);
    // The other domains are unaffected.
    expect(results.workers.map((worker) => worker.id)).toEqual(['nightly-worker']);
  });

  test('returns nothing for an empty query, and does not call the client', async () => {
    const calls = { schedules: 0 };

    const results = await searchConsole(fakeClient(calls), '', { scheduleReadGate: OPEN });

    expect(results).toEqual({ workflows: [], schedules: [], workers: [], reviews: [] });
    expect(calls.schedules).toBe(0);
  });

  test('does not search workflows by id prefix for a query that is not an id prefix', async () => {
    const results = await searchConsole(fakeClient({ schedules: 0 }), 'nightly rollup', {
      scheduleReadGate: OPEN,
    });

    expect(results.workflows).toEqual([]);
  });

  test('treats a domain whose search fails (for example a 403) as no results, not an error', async () => {
    const refuse = async (): Promise<never> => {
      throw new Error('403 Forbidden');
    };
    const failing = {
      list: refuse,
      listSchedules: refuse,
      listReviews: refuse,
      operations: { 'weft.workers.list': refuse },
    } as unknown as HttpClient;

    const results = await searchConsole(failing, 'nightly', { scheduleReadGate: OPEN });

    expect(results).toEqual({ workflows: [], schedules: [], workers: [], reviews: [] });
  });
});
