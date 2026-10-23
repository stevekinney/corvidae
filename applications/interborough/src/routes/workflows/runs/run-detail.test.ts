/**
 * `/runs/:id` as a person uses it: where the run came from and how it stands, the answer the
 * task's stream carries, what the page says when it cannot follow the run live, and a goal's
 * attempt, which the Bureau holds no task for. Through the route outlet, over a Bureau that
 * answers from a table.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { TASK_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import {
  goalAttemptFixture,
  goalFixture,
  taskFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import type { Goal } from '../../../lib/bureau-goals.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  snapshotElement,
  statusElement,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type AuthorizationScope } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';

let stub: BureauWorldStub | undefined;

beforeEach(() => {
  // The follower keeps a task's cursor and answer here, and every test names the same run.
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  sessionStorage.clear();
});

function open(
  path: string,
  options: {
    tasks?: TaskView[];
    goals?: readonly Goal[];
    scopes?: readonly AuthorizationScope[];
  } = {},
) {
  stub = installBureauWorld(emptyBureauWorld({ tasks: options.tasks ?? [] }));
  const goals = options.goals ?? [];
  stub.on('bureau.goals.list', () => ({ goals, nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: options.scopes ?? AUTHORIZATION_SCOPES,
    },
  } as never);
}

const BUREAU_ONLY: readonly AuthorizationScope[] = [];
const origin = (container: HTMLElement) => container.querySelector('.ib-run__origin');

describe('where a run came from', () => {
  test('a run started from a chat links to the chat, and opens it in place', async () => {
    const view = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', contextId: 'session-1', agentName: 'echo' })],
    });

    const openChat = await view.findByRole('link', { name: TASK_COPY.openChat });
    await waitFor(() =>
      expect(origin(view.container)?.textContent).toContain(TASK_COPY.startedFromChat),
    );
    // A modified click is the browser's.
    expect(await fireEvent.click(openChat, { button: 0, metaKey: true })).toBe(true);
    expect(router.pathname).toBe('/runs/run-1');

    expect(await fireEvent.click(openChat, { button: 0 })).toBe(false);
    expect(router.pathname).toContain('session-1');
  });

  test('the chat named in the origin line opens in place too', async () => {
    const view = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', contextId: 'session-1', agentName: 'echo' })],
    });

    await waitFor(() => expect(origin(view.container)?.querySelector('a')).toBeTruthy());
    const link = origin(view.container)?.querySelector('a') as HTMLAnchorElement;
    expect(await fireEvent.click(link, { button: 0, shiftKey: true })).toBe(true);
    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toContain('session-1');
  });

  test('a run no chat has is said to have started directly, and an unnamed agent is “An agent”', async () => {
    const view = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', contextId: 'handle-1', agentName: null })],
    });
    stub?.on('bureau.contexts.get', () => {
      throw new Error('No such chat');
    });

    await view.findByRole('heading', { level: 1, name: TASK_COPY.unknownAgent });
    await waitFor(() =>
      expect(origin(view.container)?.textContent).toContain(TASK_COPY.startedDirectly),
    );
    expect(view.queryByRole('link', { name: TASK_COPY.openChat })).toBeNull();
  });

  test('a finished run says how long it took', async () => {
    const view = open('/runs/run-1', {
      tasks: [
        taskFixture({
          id: 'run-1',
          status: 'completed',
          createdAt: '2026-10-19T08:00:00.000Z',
          updatedAt: '2026-10-19T08:02:05.000Z',
        }),
      ],
    });

    await waitFor(() => expect(origin(view.container)?.textContent).toContain('2m'));
  });
});

describe('the answer', () => {
  test('is the stream’s, rendered as Markdown, and the page says so when it was cut short', async () => {
    const view = open('/runs/run-1', { tasks: [taskFixture({ id: 'run-1', status: 'working' })] });
    await view.findByText(TASK_COPY.noAnswerYet);
    await waitFor(() => expect(stub?.streams.length).toBeGreaterThan(0));

    stub?.streams[0]?.push(
      statusElement('run-1', '7', 'working', {
        artifact: { artifactId: 'answer', text: 'The release is **ready**.', truncated: true },
      }),
    );

    await waitFor(() =>
      expect(view.container.querySelector('.ib-run__answer strong')?.textContent).toBe('ready'),
    );
    expect(view.getByText(TASK_COPY.answerTruncated)).not.toBeNull();
    expect(view.queryByText(TASK_COPY.noAnswerYet)).toBeNull();
  });

  test('a finished run with no answer says it finished without one', async () => {
    const view = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', status: 'completed' })],
    });

    await view.findByText(TASK_COPY.noAnswer);
  });

  test('the badge follows a status the stream reports that the page has not read yet', async () => {
    const view = open('/runs/run-1', { tasks: [taskFixture({ id: 'run-1', status: 'working' })] });
    await view.findByRole('heading', { level: 1 });
    await waitFor(() => expect(stub?.streams.length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(view.container.querySelector('.ib-run__heading')?.textContent).toContain(
        TASK_COPY.states.working,
      ),
    );

    stub?.streams[0]?.push(snapshotElement('run-1', 'completed', { artifact: null }));

    await waitFor(() =>
      expect(view.container.querySelector('.ib-run__heading')?.textContent).toContain(
        TASK_COPY.states.completed,
      ),
    );
  });
});

describe('a run that cannot be followed live', () => {
  test('says so when the Bureau keeps no history to follow, or will not show this caller the task’s', async () => {
    const view = open('/runs/run-1', { tasks: [taskFixture({ id: 'run-1', status: 'working' })] });
    stub?.refuseStreams(403);

    expect(await view.findByText(TASK_COPY.followUnavailable)).not.toBeNull();
  });

  test('says it is reconnecting when the connection drops', async () => {
    const view = open('/runs/run-1', { tasks: [taskFixture({ id: 'run-1', status: 'working' })] });
    stub?.refuseStreams('offline');

    expect(await view.findByText(TASK_COPY.followReconnecting)).not.toBeNull();
  });
});

describe('a goal’s attempt', () => {
  const attempt = (status: Goal['attempts'][number]['status']) =>
    goalFixture('goal-1', {
      agentName: 'planner',
      attempts: [goalAttemptFixture('goal-1-a0', { status })],
    });

  test.each([
    ['passed', 'completed'],
    ['failed', 'failed'],
    ['aborted', 'canceled'],
    ['running', 'working'],
  ] as const)('an attempt that %s is shown as %s', async (status, state) => {
    const view = open('/runs/goal-1-a0', { goals: [attempt(status)], scopes: BUREAU_ONLY });

    await view.findByRole('heading', { level: 1, name: 'planner' });
    expect(view.container.querySelector('.ib-run__heading')?.textContent).toContain(
      TASK_COPY.states[state],
    );
    expect(view.getByText(TASK_COPY.goalAttemptNoteBureauOnly)).not.toBeNull();
  });

  test('names the goal, which opens in place', async () => {
    const view = open('/runs/goal-1-a0', { goals: [attempt('passed')], scopes: BUREAU_ONLY });

    const link = (await view.findByRole('link', { name: 'goal-1' })) as HTMLAnchorElement;
    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/goals');
  });
});
