/**
 * `/runs/:run` as a person uses it: where the run came from and how it stands, the answer the
 * task's stream carries, what the page says when it cannot follow the run live, and a goal's
 * attempt, which the Bureau holds no task for. Through the route outlet, over a Bureau that
 * answers from a table.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { RUN_DETAIL_COPY, RUN_PAGE_COPY } from '../../../app/copy/runs.ts';
import { TASK_COPY } from '../../../app/copy/tasks.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import {
  contextDetailFixture,
  goalAttemptFixture,
  goalFixture,
  taskFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import type { Goal } from '../../../lib/bureau-goals.ts';
import { SCHEDULER_ACTOR, type TaskView } from '../../../lib/bureau-tasks.ts';
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
import RunDetailEngineHarness from './run-detail-engine.test-harness.svelte';
import RunInputOutputHarness from './run-input-output.test-harness.svelte';
import { durationWords } from './run-rows.ts';

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
    /** Provides the fleet feed the engine's workflow page reads, for a test that opens it. */
    withEngine?: boolean;
  } = {},
) {
  stub = installBureauWorld(emptyBureauWorld({ tasks: options.tasks ?? [] }));
  const goals = options.goals ?? [];
  stub.on('bureau.goals.list', () => ({ goals, nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  landAt(path);
  return render(options.withEngine === true ? RunDetailEngineHarness : RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: options.scopes ?? AUTHORIZATION_SCOPES,
    },
  } as never);
}

const BUREAU_ONLY: readonly AuthorizationScope[] = [];
const origin = (container: HTMLElement) => container.querySelector('[data-testid="run-lineage"]');
const header = (container: HTMLElement) => container.querySelector('[data-run-header]');
/** The words of the header's links, which rows 55f and 55j keep free of a session. */
const headerLinks = (container: HTMLElement): string[] =>
  [...(header(container)?.querySelectorAll('a') ?? [])].map((link) => link.textContent.trim());
/** The rail's Open the session link, which opens a goal's or a schedule's session. */
const railSession = (view: { getByRole: (role: string) => HTMLElement }) =>
  [...view.getByRole('complementary').querySelectorAll('a')].find(
    (link) => link.textContent.trim() === TASK_COPY.openSession,
  );

describe('where a run came from', () => {
  test('a run started from a chat links to the chat, and opens it in place', async () => {
    const view = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', contextId: 'session-1', agentName: 'echo' })],
    });

    const openChat = await view.findByRole('link', { name: TASK_COPY.openChat });
    await waitFor(() => expect(origin(view.container)?.querySelector('a')).toBeTruthy());
    // A modified click is the browser's.
    expect(await fireEvent.click(openChat, { button: 0, metaKey: true })).toBe(true);
    expect(router.pathname).toBe('/runs/run-1');

    expect(await fireEvent.click(openChat, { button: 0 })).toBe(false);
    expect(router.pathname).toContain('session-1');
  });

  test('a chat’s run opens its chat from the header, so its rail has no Session fact', async () => {
    const view = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', contextId: 'session-1', agentName: 'echo' })],
    });

    await view.findByRole('link', { name: TASK_COPY.openChat });
    expect(railSession(view)).toBeUndefined();
    expect(view.getByRole('complementary').textContent).not.toContain(RUN_PAGE_COPY.facts.session);
  });

  test('a chat’s run names the chat that started it, then itself as This run (row 06d)', async () => {
    const view = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', contextId: 'session-1', agentName: 'echo' })],
    });

    await waitFor(() => expect(origin(view.container)?.querySelector('a')).toBeTruthy());
    const items = origin(view.container)?.querySelectorAll('li.ib-run-lineage__item') ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain(TASK_COPY.list.kinds.chat);
    expect(origin(view.container)?.querySelector('li.ib-run-lineage__self')?.textContent).toContain(
      RUN_DETAIL_COPY.lineage.thisRun,
    );
  });

  test('a goal’s attempt says which attempt it is, after the goal', async () => {
    const view = open('/runs/goal-1-a0', {
      goals: [
        goalFixture('goal-1', {
          agentName: 'planner',
          attempts: [goalAttemptFixture('goal-1-a0', { status: 'aborted' })],
        }),
      ],
      scopes: BUREAU_ONLY,
    });

    await waitFor(() =>
      expect(origin(view.container)?.textContent).toContain(TASK_COPY.list.attempt(1, 3)),
    );
    expect(origin(view.container)?.textContent).toContain(TASK_COPY.list.kinds.goal);
    // The goal's own name (the fixture's "Goal goal-1"), as everywhere a goal is named.
    expect(origin(view.container)?.textContent).toContain('Goal goal-1');
    // The rail names the goal as a link, and the agent in words.
    const rail = view.getByRole('complementary');
    const goalLink = [...rail.querySelectorAll('a')].find(
      (link) => link.textContent === 'Goal goal-1',
    );
    expect(goalLink?.getAttribute('href')).toContain('goal-1');
    expect(rail.textContent).toContain(RUN_DETAIL_COPY.facts.goal);
    expect(rail.textContent).toContain('Planner');
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

  test('a run a schedule’s fire started is said so, its header offers no session or chat (55j), and Started by and the rail open the session', async () => {
    const view = open('/runs/run-1', {
      tasks: [
        taskFixture({
          id: 'run-1',
          contextId: 'fire-1',
          agentName: 'echo',
          actor: SCHEDULER_ACTOR,
        }),
      ],
    });
    stub?.on('bureau.contexts.get', () => ({
      ...contextDetailFixture('fire-1', { title: 'Daily summary' }),
      origin: 'schedule',
    }));

    await waitFor(() => expect(origin(view.container)?.textContent).toContain(TASK_COPY.schedule));
    await waitFor(() => expect(stub?.callsTo('bureau.contexts.get').length).toBeGreaterThan(0));
    // The rail's Session opens the session the fire ran in; the header links neither it nor a chat.
    await waitFor(() => expect(railSession(view)?.getAttribute('href')).toContain('fire-1'));
    expect(headerLinks(view.container)).not.toContain(TASK_COPY.openSession);
    expect(view.queryByRole('link', { name: TASK_COPY.openChat })).toBeNull();
    // The session is reached from Started by, which names it.
    const sessionLink = await waitFor(() => {
      const found = [...(origin(view.container)?.querySelectorAll('a') ?? [])].find(
        (link) => link.textContent?.trim() === 'Daily summary',
      );
      if (found === undefined) throw new Error('No session link in Started by yet.');
      return found;
    });
    expect(await fireEvent.click(sessionLink, { button: 0 })).toBe(false);
    expect(router.pathname).toContain('fire-1');
  });

  test('a fire that continued a chat session is still said to be a schedule’s', async () => {
    const view = open('/runs/run-1', {
      tasks: [
        taskFixture({
          id: 'run-1',
          contextId: 'chat-1',
          agentName: 'echo',
          actor: SCHEDULER_ACTOR,
        }),
      ],
    });
    stub?.on('bureau.contexts.get', () => ({
      ...contextDetailFixture('chat-1', { title: 'Refund order 1234' }),
      origin: 'chat',
    }));

    await waitFor(() => expect(origin(view.container)?.textContent).toContain(TASK_COPY.schedule));
    expect(origin(view.container)?.textContent).not.toContain('Refund order 1234');
  });

  test('a run a person started in a session a schedule created is said to be from a chat', async () => {
    const view = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', contextId: 'fire-1', agentName: 'echo' })],
    });
    stub?.on('bureau.contexts.get', () => ({
      ...contextDetailFixture('fire-1', { title: 'Daily summary' }),
      origin: 'schedule',
    }));

    await waitFor(() =>
      expect(origin(view.container)?.querySelector('a')?.getAttribute('href')).toContain('fire-1'),
    );
    expect(origin(view.container)?.textContent).not.toContain(TASK_COPY.schedule);
  });

  test('a fire whose session the caller cannot read is still said to be a schedule’s', async () => {
    const view = open('/runs/run-1', {
      tasks: [
        taskFixture({
          id: 'run-1',
          contextId: 'other-owner-fire',
          agentName: 'echo',
          actor: SCHEDULER_ACTOR,
        }),
      ],
    });
    stub?.on('bureau.contexts.get', () => {
      throw new Error('No such chat');
    });

    await waitFor(() => expect(origin(view.container)?.textContent).toContain(TASK_COPY.schedule));
    expect(origin(view.container)?.textContent).not.toContain(TASK_COPY.originUnrecorded);
  });

  test('a run nothing recorded the origin of says so, and an unnamed agent is “An agent”', async () => {
    const view = open('/runs/run-1', {
      tasks: [
        taskFixture({ id: 'run-1', contextId: 'handle-1', agentName: null, kind: 'catalog' }),
      ],
    });
    stub?.on('bureau.contexts.get', () => {
      throw new Error('No such chat');
    });

    await view.findByRole('heading', { level: 1, name: TASK_COPY.unknownAgent });
    await waitFor(() =>
      expect(origin(view.container)?.textContent).toContain(TASK_COPY.originUnrecorded),
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

    await waitFor(() =>
      expect(header(view.container)?.textContent).toContain(`took ${durationWords(125_000)}`),
    );
  });
});

describe('what started the run, and what started that', () => {
  test('follows a child run to the run that started it, and a step to its workflow, up to three levels', async () => {
    const view = open('/runs/child-1', {
      tasks: [
        taskFixture({
          id: 'child-1',
          agentName: 'writer',
          origin: { kind: 'agent', agentName: 'planner', parentRunId: 'parent-1' },
        }),
        taskFixture({
          id: 'parent-1',
          agentName: 'planner',
          origin: { kind: 'parent', parentRunId: 'workflow-1' },
        }),
        taskFixture({
          id: 'workflow-1',
          agentName: 'runner',
          origin: { kind: 'parent', parentRunId: 'workflow-2' },
        }),
        taskFixture({
          id: 'workflow-2',
          agentName: 'runner',
          origin: { kind: 'parent', parentRunId: 'workflow-3' },
        }),
      ],
    });

    await waitFor(() =>
      expect(origin(view.container)?.querySelectorAll('li.ib-run-lineage__item').length).toBe(3),
    );
    const levels = [...(origin(view.container)?.querySelectorAll('li.ib-run-lineage__item') ?? [])];
    expect(levels.map((level) => level.getAttribute('data-depth'))).toEqual(['1', '2', '3']);
    // Each level names the run above it, and links to it.
    const links = [...(origin(view.container)?.querySelectorAll('a') ?? [])].map((link) =>
      link.getAttribute('href'),
    );
    expect(links).toEqual(['/runs/parent-1', '/runs/workflow-1', '/runs/workflow-2']);
    // The run's own row, one level in from the last origin, is there once another run is in the chain.
    const self = origin(view.container)?.querySelector('li.ib-run-lineage__self');
    expect(self?.getAttribute('data-depth')).toBe('4');
    expect(self?.textContent).toContain(RUN_DETAIL_COPY.lineage.thisRun);
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

  test('the status follows a status the stream reports that the page has not read yet', async () => {
    const view = open('/runs/run-1', { tasks: [taskFixture({ id: 'run-1', status: 'working' })] });
    await view.findByRole('heading', { level: 1 });
    await waitFor(() => expect(stub?.streams.length).toBeGreaterThan(0));
    await waitFor(() => expect(header(view.container)?.textContent).toContain('Running'));

    stub?.streams[0]?.push(snapshotElement('run-1', 'completed', { artifact: null }));

    await waitFor(() => expect(header(view.container)?.textContent).toContain('Done'));
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

describe('the related runs of a chat run', () => {
  test('lists the other runs of the chat, each a link to its page, and says when there is none', async () => {
    const view = open('/runs/run-1', {
      tasks: [
        taskFixture({ id: 'run-1', contextId: 'session-1', status: 'completed' }),
        taskFixture({ id: 'run-2', contextId: 'session-1', status: 'input-required' }),
      ],
      scopes: BUREAU_ONLY,
    });

    const section = await waitFor(() => {
      const found = view.container.querySelector('[data-section="related-chat"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const hrefs = [...section.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/runs/run-2']);
    cleanup();
    stub?.restore();

    const alone = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', contextId: 'session-1', status: 'completed' })],
      scopes: BUREAU_ONLY,
    });
    expect(await alone.findByText(RUN_DETAIL_COPY.related.noneInChat)).not.toBeNull();
  });
});

describe('How it ran', () => {
  test('is folded up for a finished run and opens for the activity, and stays open while a run goes', async () => {
    const done = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', status: 'completed' })],
      scopes: BUREAU_ONLY,
    });
    const trigger = await done.findByRole('button', { name: RUN_DETAIL_COPY.howItRan.heading });
    expect(done.queryByRole('heading', { level: 3, name: 'Activity' })).toBeNull();

    await fireEvent.click(trigger);

    await waitFor(() =>
      expect(done.queryByRole('heading', { level: 3, name: 'Activity' })).not.toBeNull(),
    );
    cleanup();
    stub?.restore();

    const going = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', status: 'working' })],
      scopes: BUREAU_ONLY,
    });
    expect(await going.findByRole('heading', { level: 3, name: 'Activity' })).not.toBeNull();
  });
});

describe('the page', () => {
  test('is one header with one status, a Details rail and no tabs, even for a caller with no engine scope', async () => {
    const view = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', status: 'completed', agentName: 'echo' })],
      scopes: BUREAU_ONLY,
    });

    await view.findByRole('heading', { level: 1, name: 'echo' });
    expect(view.getAllByRole('heading', { level: 1 }).length).toBe(1);
    expect(view.container.querySelectorAll('[data-status-word]').length).toBe(1);
    expect(header(view.container)?.textContent).toContain('Done');
    expect(view.queryAllByRole('tab').length).toBe(0);
    // A finished run's how it ran is folded up; a person opens it for the activity.
    expect(view.getByRole('button', { name: RUN_DETAIL_COPY.howItRan.heading })).not.toBeNull();
    expect(view.queryByRole('heading', { level: 3, name: 'Activity' })).toBeNull();
    for (const name of ['Input and output', 'Run details']) {
      expect(view.getByRole('heading', { level: 2, name })).not.toBeNull();
    }
    // What only the workflow's reader may do is not drawn, and the page is whole without it.
    expect(view.queryByRole('heading', { level: 2, name: 'Change or ask this run' })).toBeNull();
  });
});

describe('a goal’s attempt', () => {
  const attempt = (status: Goal['attempts'][number]['status']) =>
    goalFixture('goal-1', {
      agentName: 'planner',
      attempts: [goalAttemptFixture('goal-1-a0', { status })],
    });

  test('a Bureau run’s rail says its message in one line, nothing more of a cancel, and no finish reason (rows 55h, 54j)', async () => {
    const failed = open('/runs/run-1', {
      tasks: [
        taskFixture({
          id: 'run-1',
          status: 'failed',
          finishReason: 'error',
          statusMessage:
            'Agent "assistant" failed: {"cause":{"message":"GitHub didn’t answer (HTTP 503)"}}',
        }),
      ],
    });
    const rail = await failed.findByRole('complementary', { name: RUN_PAGE_COPY.detailsHeading });
    await waitFor(() => expect(rail.textContent).toContain('GitHub didn’t answer'));
    expect(rail.textContent).not.toContain('{');
    expect(rail.textContent).not.toContain(RUN_PAGE_COPY.facts.finishReason);
    cleanup();
    stub?.restore();

    const canceled = open('/runs/run-2', {
      tasks: [
        taskFixture({
          id: 'run-2',
          status: 'canceled',
          finishReason: 'aborted',
          statusMessage: '{"name":"AbortAgentRunError","message":"aborted"}',
        }),
      ],
    });
    const canceledRail = await canceled.findByRole('complementary', {
      name: RUN_PAGE_COPY.detailsHeading,
    });
    await waitFor(() => expect(header(canceled.container)?.textContent).toContain('Canceled'));
    expect(canceledRail.textContent).not.toContain(RUN_PAGE_COPY.facts.message);
    expect(canceledRail.textContent).not.toContain('AbortAgentRunError');
    expect(canceledRail.textContent).not.toContain('aborted');
  });

  test('names the goal by its own name in the rail and in Started by, never by its identifier (rows 55f, 55h)', async () => {
    const goalRunId = '16e7c79642a7c4e1-sample-goal-summarize-open-refunds';
    const goal = goalFixture(goalRunId, {
      identity: { name: 'Summarize open refunds', version: '1' },
      agentName: 'planner',
      attempts: [goalAttemptFixture('refund-a1', { status: 'aborted' })],
    });
    const view = open('/runs/refund-a1', { goals: [goal], scopes: BUREAU_ONLY });

    await view.findByRole('heading', { level: 1, name: 'Summarize open refunds' });
    const rail = view.getByRole('complementary', { name: RUN_PAGE_COPY.detailsHeading });
    await waitFor(() =>
      expect(origin(view.container)?.textContent).toContain('Summarize open refunds'),
    );
    expect(
      [...rail.querySelectorAll('a')].filter(
        (link) => link.textContent?.trim() === 'Summarize open refunds',
      ),
    ).toHaveLength(2);
    expect(rail.textContent).not.toContain(goalRunId);
    // A goal's attempt's chain is the goal, the attempt and this run: no untitled session.
    expect(origin(view.container)?.textContent).not.toContain(TASK_COPY.untitledChat);
  });

  const WORD = { completed: 'Done', failed: 'Failed', canceled: 'Canceled', working: 'Running' };
  test.each([
    ['passed', 'completed'],
    ['failed', 'failed'],
    ['aborted', 'canceled'],
    ['running', 'working'],
  ] as const)('an attempt that %s is shown as %s', async (status, state) => {
    const view = open('/runs/goal-1-a0', { goals: [attempt(status)], scopes: BUREAU_ONLY });

    // The goal's own name, which the fixture writes as "Goal goal-1".
    await view.findByRole('heading', { level: 1, name: 'Goal goal-1' });
    expect(header(view.container)?.textContent).toContain(WORD[state]);
    // The note is under How it ran, which a finished attempt's page gives closed (row 54a).
    const howItRan = view.getByRole('button', { name: RUN_DETAIL_COPY.howItRan.heading });
    if (howItRan.getAttribute('aria-expanded') !== 'true') await fireEvent.click(howItRan);
    expect(await view.findByText(TASK_COPY.goalAttemptNoteBureauOnly)).not.toBeNull();
  });

  test('a goal’s attempt offers Open goal and no Open the session in its header (row 55f), and its rail opens the session', async () => {
    const view = open('/runs/goal-1-a0', { goals: [attempt('passed')], scopes: BUREAU_ONLY });
    stub?.on('bureau.contexts.get', (params) => ({
      ...contextDetailFixture(String(params['contextId'])),
      origin: 'goal',
    }));

    await view.findByRole('link', { name: RUN_DETAIL_COPY.openGoal });
    await waitFor(() => expect(stub?.callsTo('bureau.contexts.get').length).toBeGreaterThan(0));
    expect(stub?.callsTo('bureau.contexts.get')[0]?.params).toEqual({
      contextId: 'goal-session-goal-1-a0',
    });
    // A goal's session is listed under no Chats: the attempt's rail is where it is reached.
    const sessionLink = await waitFor(() => {
      const found = railSession(view);
      if (found === undefined) throw new Error('No Open the session in the rail yet.');
      return found;
    });
    expect(sessionLink.getAttribute('href')).toContain('goal-session-goal-1-a0');
    expect(view.getByRole('complementary').textContent).toContain(RUN_PAGE_COPY.facts.session);
    expect(headerLinks(view.container)).not.toContain(TASK_COPY.openSession);
    expect(await fireEvent.click(sessionLink, { button: 0 })).toBe(false);
    expect(router.pathname).toContain('goal-session-goal-1-a0');
  });

  test('offers no session when the Bureau no longer has it', async () => {
    const view = open('/runs/goal-1-a0', { goals: [attempt('passed')], scopes: BUREAU_ONLY });
    stub?.on('bureau.contexts.get', () => {
      throw new Error('No such session');
    });

    await view.findByRole('heading', { level: 1, name: 'Goal goal-1' });
    await waitFor(() => expect(stub?.callsTo('bureau.contexts.get').length).toBeGreaterThan(0));
    expect(view.queryByRole('link', { name: TASK_COPY.openSession })).toBeNull();
    expect(view.getByRole('complementary').textContent).not.toContain(RUN_PAGE_COPY.facts.session);
  });

  test('a goal’s attempt the Bureau also lists as a task reads the attempt’s session, never the run handle as a chat, and links neither from its header', async () => {
    const view = open('/runs/goal-1-a0', {
      tasks: [
        taskFixture({
          id: 'goal-1-a0',
          contextId: 'goal-1-a0',
          kind: 'catalog',
          agentName: 'planner',
          origin: { kind: 'goal', goalRunId: 'goal-1', attemptId: 'goal-1:a0' },
        }),
      ],
      goals: [attempt('passed')],
      scopes: BUREAU_ONLY,
    });
    stub?.on('bureau.contexts.get', (params) => ({
      ...contextDetailFixture(String(params['contextId'])),
      origin: 'goal',
    }));

    await waitFor(() =>
      expect(origin(view.container)?.textContent).toContain(TASK_COPY.list.kinds.goal),
    );
    await waitFor(() =>
      expect(stub?.callsTo('bureau.contexts.get').map((call) => call.params)).toEqual([
        { contextId: 'goal-session-goal-1-a0' },
      ]),
    );
    // The rail opens the attempt's own session, never the run handle.
    await waitFor(() =>
      expect(railSession(view)?.getAttribute('href')).toContain('goal-session-goal-1-a0'),
    );
    expect(headerLinks(view.container)).not.toContain(TASK_COPY.openSession);
    expect(view.queryByRole('link', { name: TASK_COPY.openChat })).toBeNull();
  });

  test('a goal’s attempt whose goal the person cannot read still shows the task’s open decisions, and reads no thread', async () => {
    const requested: string[] = [];
    const view = open('/runs/goal-1-a0', {
      tasks: [
        taskFixture({
          id: 'goal-1-a0',
          contextId: 'goal-1-a0',
          kind: 'catalog',
          agentName: 'planner',
          status: 'input-required',
          origin: { kind: 'goal', goalRunId: 'goal-1', attemptId: 'goal-1:a0' },
          openWaits: [
            { kind: 'tool-approval', reviewId: 'review-1', callId: 'call-1' },
            { kind: 'human-wait', reviewId: 'review-2', signalName: 'environment' },
          ],
        }),
      ],
      // The goals the person may read do not include this attempt's goal.
      goals: [],
      scopes: BUREAU_ONLY,
    });
    // The stub the world installed answers the Bureau; this only records what is asked of it.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      await waitFor(() =>
        expect(
          [...view.container.querySelectorAll('.ib-run-wait')].map((wait) =>
            wait.getAttribute('data-kind'),
          ),
        ).toEqual(['human-wait', 'tool-approval']),
      );
      await waitFor(() => expect(stub?.callsTo('bureau.goals.list').length).toBeGreaterThan(0));
      expect(requested.filter((url) => url.includes('/threads/'))).toEqual([]);
      expect(stub?.callsTo('bureau.contexts.get')).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('names the goal, which opens in place', async () => {
    const view = open('/runs/goal-1-a0', { goals: [attempt('passed')], scopes: BUREAU_ONLY });

    // The origin line and the rail both name the goal by its own name as a link; each opens it in
    // place.
    const links = await view.findAllByRole('link', { name: 'Goal goal-1' });
    const link = links[0] as HTMLAnchorElement;
    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/goals/goal-1');
  });
});

describe('a run a schedule started (COR-2424, rows 55i, 55j, 55m)', () => {
  const DAILY_SUMMARY = {
    id: 'daily-summary',
    owner: 'anonymous:local',
    agentName: 'assistant',
    inputPreview: 'Summarize what happened yesterday.',
    continuesChat: false,
    workflowType: 'agentRun',
    description: 'Daily summary',
    cronExpression: '0 9 * * *',
    intervalMs: null,
    status: 'active',
    overlap: 'skip',
    revision: 1,
    timeZone: 'UTC',
    nextFireAt: '2026-11-03T09:00:00.000Z',
    skippedOccurrences: [],
    // The schedule's last fire is this run, and it has missed four occurrences since.
    lastFireAt: '2026-10-29T09:00:00.000Z',
    missedFireCount: 4,
    skippedCount: 0,
    createdAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-19T08:00:00.000Z',
    blocker: null,
  };
  const FIRE = taskFixture({
    id: 'fire-1',
    contextId: 'fire-session',
    kind: 'schedule-fire',
    actor: SCHEDULER_ACTOR,
    agentName: 'assistant',
    status: 'completed',
    createdAt: '2026-10-29T09:00:00.000Z',
    updatedAt: '2026-10-29T09:00:12.000Z',
    origin: { kind: 'schedule', scheduleId: 'daily-summary', fireId: 'fire-1' },
  });

  function openFire() {
    const view = open('/runs/fire-1', { tasks: [FIRE], scopes: BUREAU_ONLY });
    stub?.on('bureau.schedules.list', () => ({ schedules: [DAILY_SUMMARY], nextOffset: null }));
    stub?.on('bureau.health.attention', () => ({
      items: [
        {
          kind: 'missed-runs',
          scheduleId: 'daily-summary',
          count: 4,
          since: Date.parse('2026-10-30T09:00:00.000Z'),
        },
      ],
    }));
    return view;
  }

  test('says the schedule by its name with when it runs, then the run itself (row 55i)', async () => {
    const view = openFire();

    await waitFor(() => expect(origin(view.container)?.textContent).toContain('Daily summary'));
    const line = origin(view.container)?.textContent ?? '';
    expect(line).toContain(TASK_COPY.list.kinds.schedule);
    expect(line).toMatch(/every day at/i);
    expect(origin(view.container)?.querySelector('a')?.getAttribute('href')).toBe(
      '/schedules/daily-summary',
    );
    expect(origin(view.container)?.querySelector('li.ib-run-lineage__self')?.textContent).toContain(
      RUN_DETAIL_COPY.lineage.thisRun,
    );
  });

  test('lists the schedule in the rail, and says it was the last run and how many it has missed since (row 55m)', async () => {
    const view = openFire();

    const rail = await view.findByRole('complementary');
    await waitFor(() => expect(rail.textContent).toContain(RUN_DETAIL_COPY.schedule));
    await waitFor(() =>
      expect(rail.textContent).toContain(
        'This was the schedule’s last run. It has missed 4 occurrences since.',
      ),
    );
  });

  test('offers Open schedule and a Run again that starts the schedule now (row 55j)', async () => {
    const view = openFire();

    expect(await view.findByRole('link', { name: RUN_DETAIL_COPY.openSchedule })).not.toBeNull();
    stub?.on('bureau.schedules.runnow', () => ({ outcome: 'started', taskId: 'fire-2' }));
    await fireEvent.click(await view.findByRole('button', { name: RUN_DETAIL_COPY.runAgain }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.runnow')).toHaveLength(1));
    expect(stub?.callsTo('bureau.schedules.runnow')[0]?.params).toEqual({
      scheduleId: 'daily-summary',
    });
  });
});

// COR-2489 (COR-2329 AC1's unmet part): the run page's sections drew their own headings with the
// page's `ib-run__*` classes. They are Cinder Sections; the payload and wait cards stay the
// recorded exception.
describe('the run page’s sections are Cinder Sections', () => {
  const files = [
    './run-details.svelte',
    './run-related.svelte',
    './run-chat-related.svelte',
    './run-change.svelte',
    './run-panels.svelte',
    './run-engine-panels.svelte',
    '../detail/lineage-panel.svelte',
    // Not named by the criterion, but its block sits in the same rail.
    './run-related-runs.svelte',
    // The engine panels' own blocks (design round): Search attributes and Worker versioning.
    '../detail/attributes/attributes-panel.svelte',
    '../detail/worker-binding-panel.svelte',
  ];

  test.each(files)('%s draws no ib-run heading or section class', (file) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).not.toMatch(/ib-run__(heading|section|panels)/);
    expect(source).not.toMatch(/<h[1-6][^>]*class="ib-run__/);
  });

  test.each(files.filter((file) => file !== './run-engine-panels.svelte'))(
    '%s titles its block with Cinder’s Section',
    (file) => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).toMatch(/import \{[^}]*\bSection\b[^}]*\} from '@lostgradient\/cinder'/);
      expect(source).toMatch(/<Section\s/);
    },
  );

  test('the rail spaces its Sections with one margin, never a gap added to Cinder’s own', () => {
    const css = readFileSync(new URL('../../../styles/tasks.css', import.meta.url), 'utf8');
    const rail = /\n\.ib-run__rail \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rail).not.toContain('gap');
    expect(css).toMatch(
      /\.ib-run__rail > \* \+ \* \{\s*margin-block-start: var\(--cinder-space-6\);/,
    );
    expect(css).not.toMatch(/\.ib-run__(section|panels|heading-2) \{/);
  });

  test('the engine panels are Sections titled by their own headings, with no hand-built heading', () => {
    const source = readFileSync(new URL('./run-engine-panels.svelte', import.meta.url), 'utf8');
    expect(source).toContain('<LineagePanel');
    expect(source).toContain('<AttributesPanel');
    expect(source).toContain('<WorkerBindingPanel');
    expect(source).not.toMatch(/<section\b/);
    for (const panel of [
      '../detail/attributes/attributes-panel.svelte',
      '../detail/worker-binding-panel.svelte',
    ]) {
      const panelSource = readFileSync(new URL(panel, import.meta.url), 'utf8');
      expect(panelSource, panel).not.toMatch(/<h[1-6]\b/);
      expect(panelSource, panel).toMatch(/<Section level=\{3\}/);
    }
  });

  test('the rail is named Run details and holds the details as a level-two Section', async () => {
    const view = open('/runs/run-1', {
      tasks: [taskFixture({ id: 'run-1', status: 'completed', agentName: 'echo' })],
      scopes: BUREAU_ONLY,
    });
    const rail = await view.findByRole('complementary', { name: RUN_PAGE_COPY.detailsHeading });
    const heading = rail.querySelector('.cinder-section__title');
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent?.trim()).toBe(RUN_PAGE_COPY.detailsHeading);
    expect(rail.querySelector('.ib-run__heading-2')).toBeNull();
  });
});

// COR-2489: on a failed run at 375 why it failed was under the fold, after the payload cards in
// Input and output. It leads, above Input and output.
describe('a failed run', () => {
  test('says why it failed before Input and output', () => {
    stub = installBureauWorld(emptyBureauWorld({}));
    const view = render(RunInputOutputHarness, {
      props: {
        workflow: {
          id: 'wf_1',
          type: 'order-fulfillment',
          status: 'failed',
          input: { orderId: 'ord-1' },
          error: 'The warehouse did not answer.',
          versionTuple: { workflowVersion: '1' },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    } as never);
    const failure = view.container.querySelector('[data-run-failure]');
    const inputOutput = view.container.querySelector('[data-section="input-output"]');
    expect(failure?.textContent).toContain('The warehouse did not answer.');
    expect(inputOutput).not.toBeNull();
    expect(inputOutput?.contains(failure as Node)).toBe(false);
    expect(
      (failure as Node).compareDocumentPosition(inputOutput as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      'the failure comes first',
    ).toBeTruthy();
  });

  test('a failed run only the Bureau holds says why before Input and output, not only in the rail', async () => {
    const view = open('/runs/run-1', {
      tasks: [
        taskFixture({
          id: 'run-1',
          status: 'failed',
          finishReason: 'error',
          statusMessage:
            'Agent "assistant" failed: {"cause":{"message":"GitHub didn’t answer (HTTP 503)"}}',
        }),
      ],
      scopes: BUREAU_ONLY,
    });
    const failure = await waitFor(() => {
      const element = view.container.querySelector('[data-run-failure]');
      if (element === null) throw new Error('no failure drawn');
      return element;
    });
    expect(failure.textContent).toContain(RUN_DETAIL_COPY.instance.whyItFailed);
    expect(failure.textContent).toContain('GitHub didn’t answer');
    expect(failure.textContent).not.toContain('{');
    expect(failure.closest('aside')).toBeNull();
    const inputOutput = view.container.querySelector('[data-section="input-output"]');
    expect(inputOutput).not.toBeNull();
    expect(
      failure.compareDocumentPosition(inputOutput as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('a failed instance draws its step failure, in What happened, before Input and output', () => {
    // A failed instance says why on the step that failed, so What happened leads; any other
    // instance keeps Input and output first. (run-detail-engine-runs.test.ts renders the page.)
    const source = readFileSync(new URL('./run-detail.svelte', import.meta.url), 'utf8');
    const main = source.slice(source.indexOf('<div class="ib-run__main">'));
    const failedFirst = main.indexOf(
      '{#if task.data === undefined && instanceEntryList !== undefined && instanceFailed}',
    );
    const inputOutput = main.indexOf('<RunInputOutput');
    const otherAfter = main.indexOf(
      '{#if task.data === undefined && instanceEntryList !== undefined && !instanceFailed}',
    );
    expect(failedFirst).toBeGreaterThan(-1);
    expect(failedFirst).toBeLessThan(inputOutput);
    expect(otherAfter).toBeGreaterThan(inputOutput);
  });
});
