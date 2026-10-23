import { HttpClient } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';
import { afterEach, describe, expect, test } from 'bun:test';

import { goalFixture, taskFixture } from '../lib/bureau-fixtures.test-support.ts';
import { installBureauStub, type BureauStub } from '../lib/bureau-stub.test-support.ts';
import { probeFor, RUNS_RECHECK_MS } from './view-probes.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

async function probeRuns(options: { tasks?: unknown[]; goals?: unknown[] }) {
  stub = installBureauStub({
    'bureau.tasks.list': () => ({ tasks: options.tasks ?? [], nextPageToken: null }),
    'bureau.goals.list': () => ({ goals: options.goals ?? [], nextOffset: null }),
  });
  const probe = probeFor('runs', {});
  if (probe === undefined) throw new Error('The runs list has a probe.');
  return probe(new HttpClient({ baseUrl: 'http://localhost/api' }), new QueryClient());
}

describe('the runs probe', () => {
  test('asks again while the runs are empty, so a first run is noticed without leaving the page', async () => {
    expect(await probeRuns({})).toEqual({ empty: true, recheckMs: RUNS_RECHECK_MS });
  });

  test('stops asking once the Bureau has a task or a goal', async () => {
    expect(await probeRuns({ tasks: [taskFixture()] })).toEqual({ empty: false });
    expect(await probeRuns({ goals: [goalFixture('goal-1')] })).toEqual({ empty: false });
  });
});
