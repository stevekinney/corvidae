/**
 * What a run used and cost, on `/runs/:run` (COR-2525): the rail says the tokens and the cost of a
 * run the Bureau counted, writes an amount under one cent as `< $0.01`, and says neither for a run
 * with nothing to report: a run with no cost shows no Cost fact, never `$0.00`.
 */
import { HttpClient } from '@lostgradient/weft/testing';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { COST_COPY } from '../../../app/copy/cost.ts';
import { RUN_PAGE_COPY } from '../../../app/copy/runs.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';

let stub: BureauWorldStub | undefined;

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  sessionStorage.clear();
});

function open(task: TaskView) {
  stub = installBureauWorld(emptyBureauWorld({ tasks: [task] }));
  stub.on('bureau.goals.list', () => ({ goals: [], nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  landAt(`/runs/${task.id}`);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

/** The words of one fact of the rail, by its term, or `undefined` when the rail has none. */
function fact(rail: HTMLElement, term: string): string | undefined {
  const terms = [...rail.querySelectorAll('dt')];
  const found = terms.find((candidate) => candidate.textContent.trim() === term);
  return found?.nextElementSibling?.textContent.trim();
}

const usage = (totalTokens: number, costUsd: number | null) => ({
  promptTokens: Math.floor(totalTokens / 2),
  completionTokens: Math.ceil(totalTokens / 2),
  totalTokens,
  costUsd,
});

describe('a run’s tokens and cost on its page', () => {
  test('AC2: the rail says the tokens and the cost of the run', async () => {
    const view = open(
      taskFixture({ id: 'run-1', status: 'completed', usage: usage(1500, 0.1234) }),
    );

    const rail = await view.findByRole('complementary');
    await waitFor(() => expect(fact(rail, RUN_PAGE_COPY.facts.tokens)).toBe('1,500'));
    expect(fact(rail, COST_COPY.label)).toBe('$0.12');
  });

  test('AC5: says a cost under one cent as `< $0.01`', async () => {
    const view = open(taskFixture({ id: 'run-1', status: 'completed', usage: usage(40, 0.003) }));

    const rail = await view.findByRole('complementary');
    await waitFor(() => expect(fact(rail, COST_COPY.label)).toBe('< $0.01'));
  });

  test('AC4: a run with tokens and no cost shows its tokens and no Cost fact', async () => {
    const view = open(taskFixture({ id: 'run-1', status: 'completed', usage: usage(1500, null) }));

    const rail = await view.findByRole('complementary');
    await waitFor(() => expect(fact(rail, RUN_PAGE_COPY.facts.tokens)).toBe('1,500'));
    expect(fact(rail, COST_COPY.label)).toBeUndefined();
    expect(rail.textContent).not.toContain('$');
  });

  test('AC4: a run that has recorded no usage shows neither fact', async () => {
    const view = open(taskFixture({ id: 'run-1', status: 'completed', usage: null }));

    const rail = await view.findByRole('complementary');
    await waitFor(() => expect(rail.textContent).toContain(RUN_PAGE_COPY.facts.agent));
    expect(fact(rail, RUN_PAGE_COPY.facts.tokens)).toBeUndefined();
    expect(fact(rail, COST_COPY.label)).toBeUndefined();
    expect(rail.textContent).not.toContain('$');
  });
});
