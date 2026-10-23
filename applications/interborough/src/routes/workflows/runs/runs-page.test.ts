/**
 * `/runs` and `/runs/:id` through the route outlet, over a Bureau that answers from a table
 * (`bureau-world.test-support.ts`): the list and a run's page are the Bureau's, so a caller without
 * the engine's scope still sees them; every page of the goals is read; a status or an agent is
 * asked of the Bureau and Load more stays reachable when what the pages hold does not match; and a
 * run the Bureau cannot read is told apart from one it does not know, or has removed.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { RETRY_LABEL, TASK_COPY, VIEW_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import {
  goalAttemptFixture,
  goalFixture,
  taskFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import type { Goal } from '../../../lib/bureau-goals.ts';
import { StubFault } from '../../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { AUTHORIZATION_SCOPES, type AuthorizationScope } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';

let stub: BureauWorldStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

/** The scopes of a caller who may read the engine, and of one who may not. */
const WITH_ENGINE: readonly AuthorizationScope[] = AUTHORIZATION_SCOPES;
const WITHOUT_ENGINE: readonly AuthorizationScope[] = [];

function open(
  path: string,
  options: {
    world?: Partial<BureauWorld>;
    goals?: readonly Goal[];
    /** How many goals the Bureau puts on one page, however many are asked for. */
    goalsPageSize?: number;
    scopes?: readonly AuthorizationScope[];
    /** Makes the Bureau fail to list goals for as long as this says so. */
    goalsFail?: () => boolean;
  } = {},
) {
  stub = installBureauWorld(emptyBureauWorld(options.world));
  const goals = options.goals ?? [];
  const pageSize = options.goalsPageSize ?? 100;
  stub.on('bureau.goals.list', (params) => {
    if (options.goalsFail?.()) throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
    const offset = typeof params['offset'] === 'number' ? params['offset'] : 0;
    return {
      goals: goals.slice(offset, offset + pageSize),
      nextOffset: offset + pageSize < goals.length ? offset + pageSize : null,
    };
  });
  stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: options.scopes ?? WITH_ENGINE,
    },
  } as never);
}

const frameState = (container: HTMLElement) =>
  container.querySelector('[data-view="runs"]')?.getAttribute('data-state');
const rowIds = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-run]')].map((row) => row.getAttribute('data-run'));

describe('the runs list', () => {
  test('is the Bureau’s, so a caller without the engine’s scope reads it, and the engine is never asked', async () => {
    const { container } = open('/runs', {
      scopes: WITHOUT_ENGINE,
      world: { tasks: [taskFixture({ id: 'run-1', status: 'completed' })] },
    });

    await waitFor(() => expect(rowIds(container)).toEqual(['run-1']));
    expect(frameState(container)).toBe('ready');
    expect(stub?.callsTo('bureau.tasks.list')[0]?.params).toEqual({ limit: 1 });
  });

  test('is not empty when the Bureau has a goal’s attempt and nothing else does', async () => {
    const { container } = open('/runs', {
      goals: [goalFixture('goal-1', { attempts: [goalAttemptFixture('goal-1-a0')] })],
    });

    await waitFor(() => expect(rowIds(container)).toEqual(['goal-1-a0']));
    expect(frameState(container)).toBe('ready');
  });

  test('is empty only when the Bureau has no task and no goal', async () => {
    const { container, findByRole } = open('/runs');

    await findByRole('heading', { level: 1, name: VIEW_COPY.runs.empty?.title ?? '' });
    expect(frameState(container)).toBe('empty');
  });

  test('reads every page of the goals, so an attempt past the first page is a row', async () => {
    const goals = ['goal-1', 'goal-2', 'goal-3', 'goal-4', 'goal-5'].map((id) =>
      goalFixture(id, { attempts: [goalAttemptFixture(`${id}-a0`)] }),
    );
    const { container } = open('/runs', { goals, goalsPageSize: 2 });

    await waitFor(() => expect(rowIds(container)).toHaveLength(5));
    expect(rowIds(container)).toContain('goal-5-a0');
  });

  test('asks the Bureau for the status and the agent, and keeps every agent to choose from', async () => {
    const { container, findByLabelText } = open('/runs?status=failed&agent=echo', {
      world: {
        tasks: [
          taskFixture({ id: 'run-1', agentName: 'echo', status: 'failed' }),
          taskFixture({ id: 'run-2', agentName: 'assistant', status: 'failed' }),
        ],
      },
    });
    stub?.on('bureau.agents.list', () => ({
      agents: ['assistant', 'echo'].map((name) => ({
        name,
        displayName: name,
        description: null,
        definitionRevision: 1,
        kind: 'code',
        publishState: 'published',
      })),
    }));

    await waitFor(() => expect(rowIds(container)).toEqual(['run-1']));
    const asked = stub?.callsTo('bureau.tasks.list').filter((call) => call.params['limit'] === 100);
    expect(asked?.[0]?.params).toMatchObject({ status: 'failed', agentName: 'echo' });
    // The list is narrowed to one agent, and the others are still there to choose.
    const agent = await findByLabelText(TASK_COPY.agentLabel);
    await waitFor(() =>
      expect([...agent.querySelectorAll('option')].map((option) => option.value)).toEqual([
        '',
        'assistant',
        'echo',
      ]),
    );
  });

  test('keeps Load more when what the pages hold is all narrowed out and the Bureau has more', async () => {
    // 101 tasks none of which a goal started: the first page of 100 has no row for "A goal".
    const tasks = Array.from({ length: 101 }, (_, index) =>
      taskFixture({ id: `run-${String(index)}`, status: 'completed' }),
    );
    const { container, findByRole } = open('/runs?startedBy=goal', { world: { tasks } });

    const more = await findByRole('button', { name: TASK_COPY.loadMore });
    expect(rowIds(container)).toEqual([]);
    expect(container.textContent).toContain(TASK_COPY.noMatch.title);

    await fireEvent.click(more);
    await waitFor(() =>
      expect(
        stub
          ?.callsTo('bureau.tasks.list')
          .some((call) => typeof call.params['pageToken'] === 'string'),
      ).toBe(true),
    );
  });
});

describe('a run’s page', () => {
  const TASK = taskFixture({ id: 'run-1', agentName: 'echo', status: 'completed' });

  test('has the Engine tab for a caller who may read the engine, and none for one who may not', async () => {
    const withEngine = open('/runs/run-1', { world: { tasks: [TASK] } });
    await waitFor(() =>
      expect(withEngine.queryByRole('heading', { level: 1 })?.textContent).toContain('echo'),
    );
    expect(withEngine.queryByRole('tab', { name: TASK_COPY.tabs.engine })).not.toBeNull();
    cleanup();
    stub?.restore();

    const without = open('/runs/run-1', { world: { tasks: [TASK] }, scopes: WITHOUT_ENGINE });
    await waitFor(() =>
      expect(without.queryByRole('heading', { level: 1 })?.textContent).toContain('echo'),
    );
    expect(without.queryByRole('tab', { name: TASK_COPY.tabs.summary })).not.toBeNull();
    expect(without.queryByRole('tab', { name: TASK_COPY.tabs.engine })).toBeNull();
  });

  test('is a run that was not found when the Bureau has no task or goal for it and the caller may not ask the engine', async () => {
    const { findByRole } = open('/runs/run-9', { scopes: WITHOUT_ENGINE });

    await findByRole('heading', { level: 1, name: TASK_COPY.notFound.title });
  });

  test('is a goal’s attempt even when the goal is past the first page of goals', async () => {
    const goals = ['goal-1', 'goal-2', 'goal-3'].map((id) =>
      goalFixture(id, { attempts: [goalAttemptFixture(`${id}-a0`)] }),
    );
    const { findByRole, container } = open('/runs/goal-3-a0', {
      goals,
      goalsPageSize: 1,
      scopes: WITHOUT_ENGINE,
    });

    await findByRole('heading', { level: 1, name: 'assistant' });
    expect(container.textContent).toContain('goal-3');
  });

  test('is an error with a retry, and not a search for a goal, when the Bureau fails to read the task', async () => {
    let failing = true;
    const view = open('/runs/run-1', { world: { tasks: [TASK] } });
    stub?.on('bureau.tasks.get', () => {
      if (failing) throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
      return TASK;
    });

    await view.findByRole('heading', { level: 1, name: TASK_COPY.loadFailed.title });
    expect(stub?.callsTo('bureau.goals.list')).toEqual([]);

    failing = false;
    await fireEvent.click(await view.findByRole('button', { name: RETRY_LABEL }));
    await view.findByRole('heading', { level: 1, name: 'echo' });
  });

  test('is an error with a retry, and not a missing run, when the goals could not be read for a run the Bureau lacks', async () => {
    const goals = [goalFixture('goal-1', { attempts: [goalAttemptFixture('goal-1-a0')] })];
    let failing = true;
    const { findByRole } = open('/runs/goal-1-a0', {
      goals,
      scopes: WITHOUT_ENGINE,
      goalsFail: () => failing,
    });

    await findByRole('heading', { level: 1, name: TASK_COPY.loadFailed.title });

    failing = false;
    await fireEvent.click(await findByRole('button', { name: RETRY_LABEL }));
    await findByRole('heading', { level: 1, name: 'assistant' });
  });

  test('is a run that was not found once the Bureau says the task was removed', async () => {
    const { findByRole } = open('/runs/run-1', { world: { tasks: [TASK] } });
    await findByRole('heading', { level: 1, name: 'echo' });
    await waitFor(() => expect(stub?.streams.length).toBeGreaterThan(0));

    stub?.streams[0]?.push({ taskId: 'run-1', cursor: '31', emittedAtMs: 1, kind: 'task.removed' });

    await findByRole('heading', { level: 1, name: TASK_COPY.notFound.title });
  });
});
