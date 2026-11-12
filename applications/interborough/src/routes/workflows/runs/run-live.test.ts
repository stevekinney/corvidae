/**
 * A run page while the run has not ended (COR-2017: rows 54l, 54s, 54w, 55n, 55s, 55u, 55x, 56i):
 * the status line says how long a live run has run and what a waiting one needs, an approval is
 * decided under What you can do and nowhere else, What happened lists the run's entries in order,
 * the reply out says why it is not there yet, and the header is drawn at once while the run loads.
 */
import { HttpClient } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import { TASK_COPY } from '../../../app/copy/tasks.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import {
  goalAttemptFixture,
  goalFixture,
  taskFixture,
  toolApprovalFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import type { Goal } from '../../../lib/bureau-goals.ts';
import type { BureauReview } from '../../../lib/bureau-reviews.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';

let stub: BureauWorldStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open(task: TaskView, extras: { reviews?: BureauReview[]; goals?: Goal[] } = {}) {
  stub = installBureauWorld(emptyBureauWorld({ tasks: [task], reviews: extras.reviews ?? [] }));
  stub.on('bureau.goals.list', () => ({ goals: extras.goals ?? [], nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  landAt(`/runs/${task.id}`);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
      queryClient: new QueryClient(),
    },
  } as never);
}

/** An ISO time the given number of milliseconds before now. */
function ago(milliseconds: number): string {
  return new Date(Date.now() - milliseconds).toISOString();
}

/** The text of the page's header, which holds the status line. */
function headerText(view: ReturnType<typeof open>): string {
  return view.container.querySelector('[data-run-header]')?.textContent ?? '';
}

describe('a run that is still going', () => {
  test('says how long it has run so far, offers no Run again, and ends What happened on a reply not run yet (54l, 06b)', async () => {
    const view = open(
      taskFixture({
        id: 'run-1',
        agentName: 'echo',
        status: 'working',
        createdAt: ago(40_000),
        updatedAt: ago(1_000),
      }),
    );

    await view.findByRole('heading', { level: 1, name: 'echo' });
    await waitFor(() => expect(headerText(view)).toMatch(/\d+ s so far/));
    expect(view.queryByRole('link', { name: 'Run again' })).toBeNull();
    expect(await view.findByRole('heading', { level: 2, name: 'What happened' })).not.toBeNull();
    expect(view.getByText(/^Started \d+:\d{2}\s[AP]M$/)).not.toBeNull();
    expect(view.getByText('Replied')).not.toBeNull();
    expect(view.getByText('Not run yet')).not.toBeNull();
  });
});

describe('a run waiting on a person', () => {
  test('waiting on an approval: the line says how long and what it needs, and the approval is decided once, under What you can do (55n, 55s)', async () => {
    const approval = toolApprovalFixture({ id: 'approval:run-1:call-1', runId: 'run-1' });
    const view = open(
      taskFixture({
        id: 'run-1',
        agentName: 'tool-runner',
        status: 'input-required',
        createdAt: ago(250_000),
        updatedAt: ago(240_000),
        openWaits: [{ kind: 'tool-approval', reviewId: approval.id, callId: 'call-1' }],
      }),
      { reviews: [approval] },
    );

    expect(await view.findByRole('heading', { level: 2, name: 'What you can do' })).not.toBeNull();
    expect(view.getByText('This run is waiting on one approval.')).not.toBeNull();
    await waitFor(() => expect(headerText(view)).toContain('waiting 4 min'));
    expect(headerText(view)).toContain('needs your approval to continue');
    expect(headerText(view)).toContain('Waiting on you');
    // One decision for the one approval, though the call is also listed under How it ran.
    expect(view.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    expect(view.getByText('No reply yet. It’s waiting for your approval.')).not.toBeNull();
    expect(view.getByText('Asked for approval')).not.toBeNull();
    expect(view.getByText('Continue once you’ve approved or denied')).not.toBeNull();
  });

  test('waiting on a question: the line says that it needs an answer, and the reply is waiting for it (54s, 54w)', async () => {
    const view = open(
      taskFixture({
        id: 'run-1',
        agentName: 'request-human-input',
        status: 'input-required',
        createdAt: ago(3_700_000),
        updatedAt: ago(3_600_000),
        openWaits: [
          { kind: 'human-wait', reviewId: 'human-wait:run-1:environment:0', signalName: 'x' },
        ],
      }),
    );

    expect(await view.findByText('This run is waiting on one question.')).not.toBeNull();
    await waitFor(() => expect(headerText(view)).toContain('waiting 1 h'));
    expect(headerText(view)).toContain('needs an answer to continue');
    expect(view.getByText('No reply yet. It’s waiting for your answer.')).not.toBeNull();
    expect(view.getByText('Asked a question')).not.toBeNull();
  });
});

describe('a goal attempt checking its result', () => {
  test('reads Running with that qualifier and says which attempt it is and how long the agent took (56i)', async () => {
    const goal = goalFixture('goal-1', {
      attempts: [goalAttemptFixture('goal-1-a0', { status: 'evaluating' })],
    });
    const view = open(
      taskFixture({
        id: 'goal-1-a0',
        contextId: 'goal-1-a0',
        kind: 'catalog',
        agentName: 'assistant',
        status: 'completed',
        origin: { kind: 'goal', goalRunId: 'goal-1', attemptId: 'goal-1:a0' },
        createdAt: ago(72_000),
        updatedAt: ago(0),
      }),
      { goals: [goal] },
    );

    await waitFor(() => expect(headerText(view)).toContain('Running, checking the result'));
    expect(headerText(view)).toMatch(/attempt 1 of \d+/);
    expect(headerText(view)).toContain('Agent took 1 min 12 s');
    expect(headerText(view).match(/took/g)).toHaveLength(1);
    expect(view.queryByRole('link', { name: 'Run again' })).toBeNull();
  });
});

describe('a run while it loads', () => {
  test('draws its header at once, named by its identifier, and What happened under it (55x)', async () => {
    stub = installBureauWorld(emptyBureauWorld({ tasks: [] }));
    stub.on('bureau.tasks.get', () => new Promise(() => {}));
    stub.on('bureau.goals.list', () => ({ goals: [], nextOffset: null }));
    stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
    stub.on('bureau.agents.list', () => ({ agents: [] }));
    landAt('/runs/run-71c9d0');
    const view = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
        queryClient: new QueryClient(),
      },
    } as never);

    expect(
      await view.findByRole('heading', {
        level: 1,
        name: RUN_DETAIL_COPY.runHeading('run-71c9d0'),
      }),
    ).not.toBeNull();
    expect(view.getByRole('heading', { level: 2, name: 'What happened' })).not.toBeNull();
    // No status, no time and no control waits on the data but the menu of what can be done to any run.
    expect(view.container.querySelector('[data-status-word]')).toBeNull();
    expect(view.queryByRole('button', { name: TASK_COPY.cancelAction })).toBeNull();
  });
});
