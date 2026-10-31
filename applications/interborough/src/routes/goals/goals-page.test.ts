/**
 * `/goals` (COR-1494): the caller's goals, listed with where each stands, created on `/goals/new`
 * from an agent, a prompt, an identity, a validator named by free text, and a maximum number of
 * attempts, and cancelled. An unknown validator is the Bureau's `Unprocessable`, said inline. A cancel names the
 * revision of the goal the page read, so a goal that moved since is refused, and the page says so and
 * reloads the row. Owner scoping is the gate, so the view holds no scope of its own.
 *
 * Driven through the route outlet against a stand-in Bureau that keeps the goals, so the route, the
 * view frame, and the page are exercised together.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  AGENT_EDITOR_COPY,
  GOALS_COPY,
  RETRY_LABEL,
  SCHEDULE_COPY,
  VIEW_COPY,
} from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { STATUS_WORDS } from '../../lib/status.ts';
import { landAt } from '../chat/pages.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

type GoalRow = ReturnType<typeof goal>;

function goal(id: string, overrides: Record<string, unknown> = {}) {
  return {
    goalRunId: id,
    owner: 'anonymous:local',
    agentName: 'assistant',
    status: 'running',
    terminalReason: null,
    revision: 2,
    createdAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-19T08:05:00.000Z',
    closedAt: null,
    cancellation: null,
    bounds: {
      maximumAttempts: 3,
      maximumTotalDurationMs: null,
      maximumTotalSteps: null,
      maximumTotalTokens: null,
      maximumTotalCostUsd: null,
    },
    usage: { attempts: 1, steps: 2, tokens: 10, costUsd: null, durationMs: 100 },
    attempts: [],
    ...overrides,
  };
}

const AGENTS = ['assistant', 'tool-runner'].map((name) => ({
  name,
  displayName: name,
  description: null,
  definitionRevision: 1,
  kind: 'code',
  a2a: false,
}));

/** The only validator this Bureau was configured with. */
// Neither version is `1`, so a form that sent a fixed one would be seen.
const KNOWN_VALIDATOR = { name: 'accepts-any-answer', version: '2' };
const IDENTITY_VERSION = '3';

type Served = { goals: GoalRow[]; pageSize: number };

function open(
  initial: GoalRow[] = [],
  options: {
    scopes?: readonly string[];
    pageSize?: number;
    /** Where the page lands: the list unless said. */
    path?: string;
    /** How the Bureau answers that the goal's controller stands, which is started unless said. */
    controller?: { status: 'started' | 'not-needed' | 'start-failed'; reason: string | null };
  } = {},
) {
  const served: Served = { goals: [...initial], pageSize: options.pageSize ?? 50 };
  let created = 0;
  stub = installBureauStub({
    'bureau.agents.list': () => ({ agents: AGENTS }),
    'bureau.goals.list': (params) => {
      const offset = typeof params['offset'] === 'number' ? params['offset'] : 0;
      // The Bureau never answers more than a page holds, however many the caller asks for.
      const asked = typeof params['limit'] === 'number' ? params['limit'] : served.pageSize;
      const limit = Math.min(asked, served.pageSize);
      const page = served.goals.slice(offset, offset + limit);
      return {
        goals: page,
        nextOffset: served.goals.length > offset + limit ? offset + limit : null,
      };
    },
    'bureau.goals.get': (params) => {
      const found = served.goals.find((candidate) => candidate.goalRunId === params['goalRunId']);
      if (found === undefined) throw new StubFault('NotFound', 404, 'No such goal.');
      return found;
    },
    'bureau.goals.create': (params) => {
      const validator = params['validator'] as { name: string; version: string };
      if (
        validator.name !== KNOWN_VALIDATOR.name ||
        validator.version !== KNOWN_VALIDATOR.version
      ) {
        throw new StubFault(
          'Unprocessable',
          422,
          `The validator "${validator.name}@${validator.version}" is not configured on this Bureau.`,
          { reason: 'validator-not-found' },
        );
      }
      created += 1;
      const bounds = params['bounds'] as { maximumAttempts: number; maximumTotalSteps?: number };
      // As the Bureau does: a goal needs a bound on all its attempts together, besides how many.
      if (bounds.maximumTotalSteps === undefined) {
        throw new StubFault('InvalidParams', 400, 'missing-aggregate-bound', {});
      }
      const made = goal(`goal-created-${String(created)}`, {
        agentName: String(params['agentName']),
        status: 'pending',
        revision: 1,
        bounds: {
          maximumAttempts: bounds.maximumAttempts,
          maximumTotalDurationMs: null,
          maximumTotalSteps: null,
          maximumTotalTokens: null,
          maximumTotalCostUsd: null,
        },
      });
      served.goals.push(made);
      return {
        outcome: 'created',
        goal: made,
        controller: options.controller ?? { status: 'started', reason: null },
      };
    },
    'bureau.goals.cancel': (params) => {
      const found = served.goals.find((candidate) => candidate.goalRunId === params['goalRunId']);
      if (found === undefined) throw new StubFault('NotFound', 404, 'No such goal.');
      const expected = params['expectedRevision'];
      if (typeof expected === 'number' && expected !== found.revision) {
        throw new StubFault('StaleRevision', 409, 'The goal changed since it was read.', {
          expectedRevision: expected,
          currentRevision: found.revision,
        });
      }
      found.status = 'canceled';
      found.revision += 1;
      return {
        goalRunId: found.goalRunId,
        outcome: 'canceled',
        status: 'canceled',
        revision: found.revision,
      };
    },
  });
  landAt(options.path ?? '/goals');
  const view = render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: options.scopes ?? AUTHORIZATION_SCOPES,
    },
  } as never);
  return { served, view };
}

const row = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`tr[data-goal="${id}"]`);
const frameState = (container: HTMLElement) =>
  container.querySelector('[data-view="goals"]')?.getAttribute('data-state');

/** Opens the page that makes a goal from the list's New goal link, and returns the page. */
async function openCreatePage(view: ReturnType<typeof open>['view']): Promise<HTMLElement> {
  await fireEvent.click(await view.findByRole('link', { name: GOALS_COPY.newAction }));
  await view.findByRole('heading', { level: 1, name: GOALS_COPY.form.title });
  return view.container;
}

async function fillGoal(
  element: HTMLElement,
  values: { validatorName?: string; validatorVersion?: string } = {},
) {
  const dialog = within(element);
  await fireEvent.change(await dialog.findByLabelText(GOALS_COPY.form.agentLabel), {
    target: { value: 'assistant' },
  });
  await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.promptLabel), {
    target: { value: 'Say hello.' },
  });
  await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.identityNameLabel), {
    target: { value: 'say-hello' },
  });
  await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.identityVersionLabel), {
    target: { value: IDENTITY_VERSION },
  });
  await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.validatorNameLabel), {
    target: { value: values.validatorName ?? KNOWN_VALIDATOR.name },
  });
  await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.validatorVersionLabel), {
    target: { value: values.validatorVersion ?? KNOWN_VALIDATOR.version },
  });
}

describe('the goals', () => {
  test('are listed with their status, their agent, and how many attempts they have used of the most they may', async () => {
    const { view } = open([
      goal('goal-1', {
        status: 'running',
        usage: { attempts: 1, steps: 0, tokens: 0, costUsd: null, durationMs: 0 },
      }),
      goal('goal-2', {
        status: 'succeeded',
        agentName: 'tool-runner',
        closedAt: '2026-10-19T09:00:00.000Z',
      }),
    ]);

    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    const first = within(row(view.container, 'goal-1') as HTMLElement);
    expect(row(view.container, 'goal-1')?.dataset['status']).toBe('running');
    // A row carries the Bureau’s status for a spec to match, and shows it in one of the seven words.
    expect(first.getByText('Running')).not.toBeNull();
    expect(first.getByRole('link', { name: 'assistant' }).getAttribute('href')).toBe(
      '/agents/assistant',
    );
    expect(first.getByText('1 of 3')).not.toBeNull();
    expect(row(view.container, 'goal-2')?.dataset['status']).toBe('succeeded');
    expect(frameState(view.container)).toBe('ready');
  });

  test('follow the pages the Bureau returns, with Load more', async () => {
    const { view } = open([goal('goal-1'), goal('goal-2'), goal('goal-3')], { pageSize: 2 });
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    // The first page holds two of the three.
    expect(row(view.container, 'goal-3') === null).toBe(true);

    await fireEvent.click(await view.findByRole('button', { name: GOALS_COPY.loadMore }));

    await waitFor(() => expect(row(view.container, 'goal-3')).not.toBeNull());
  });

  test('offer Load more beside the filtered empty state, so a match on a later page can be reached', async () => {
    const { view } = open(
      [
        goal('goal-1', { status: 'running' }),
        goal('goal-2', { status: 'running' }),
        goal('goal-3', { status: 'exhausted' }),
      ],
      { pageSize: 2 },
    );
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    await fireEvent.change(await view.findByLabelText(GOALS_COPY.statusColumn), {
      target: { value: 'Failed' },
    });
    // Nothing on the first page matches, yet the match is on the second.
    await view.findByRole('heading', { level: 2, name: GOALS_COPY.noMatch.title });

    await fireEvent.click(await view.findByRole('button', { name: GOALS_COPY.loadMore }));

    await waitFor(() => expect(row(view.container, 'goal-3')).not.toBeNull());
  });
});

describe('creating a goal', () => {
  test('says there are no agents, and offers to make one, when the Bureau lists none', async () => {
    stub = installBureauStub({ 'bureau.agents.list': () => ({ agents: [] }) });
    landAt('/goals/new');
    const empty = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);
    await empty.findByRole('heading', { level: 2, name: GOALS_COPY.form.noAgents.title });
    expect(
      empty.getByRole('link', { name: AGENT_EDITOR_COPY.newAction }).getAttribute('href'),
    ).toBe('/agents/new');
    expect(empty.queryByLabelText(GOALS_COPY.form.agentLabel)).toBeNull();
  });

  test('takes an agent, a prompt, an identity, a validator by free text, and a maximum number of attempts, with a bound on steps, and sends exactly those', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());

    const element = await openCreatePage(view);
    expect(router.pathname).toBe('/goals/new');
    const dialog = within(element);
    await fillGoal(element);
    await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.maximumAttemptsLabel), {
      target: { value: '4' },
    });
    await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.maximumTotalStepsLabel), {
      target: { value: '20' },
    });
    await fireEvent.click(dialog.getByRole('button', { name: GOALS_COPY.form.createAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.goals.create').length).toBe(1));
    expect(stub?.callsTo('bureau.goals.create')[0]?.params).toEqual({
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9._-]{1,64}$/),
      agentName: 'assistant',
      prompt: 'Say hello.',
      identity: { name: 'say-hello', version: IDENTITY_VERSION },
      validator: { name: 'accepts-any-answer', version: '2' },
      // The Bureau needs a bound on all the attempts together besides how many it makes.
      bounds: { maximumAttempts: 4, maximumTotalSteps: 20 },
    });
    // A goal that is made takes the person to the list, where it is the new row.
    await waitFor(() => expect(router.pathname).toBe('/goals'));
    await waitFor(() => expect(row(view.container, 'goal-created-1')).not.toBeNull());
    expect(row(view.container, 'goal-created-1')?.dataset['status']).toBe('pending');
  });

  test('says Unprocessable inline for a validator the Bureau does not have, and creates nothing', async () => {
    const { view, served } = open([]);
    await fireEvent.click(
      await view.findByRole('link', { name: VIEW_COPY.goals.empty?.action?.label ?? '' }),
    );
    await view.findByRole('heading', { level: 1, name: GOALS_COPY.form.title });
    expect(router.pathname).toBe('/goals/new');
    const element = view.container;
    const dialog = within(element);
    await fillGoal(element, { validatorName: 'no-such-validator' });

    await fireEvent.click(dialog.getByRole('button', { name: GOALS_COPY.form.createAction }));

    const fault = await dialog.findByTestId('goal-fault');
    expect(fault.getAttribute('data-fault-code')).toBe('Unprocessable');
    expect(fault.textContent).toContain('no-such-validator@2');
    expect(served.goals).toEqual([]);
    // What was typed is still there, so the validator can be corrected.
    expect(
      (dialog.getByLabelText(GOALS_COPY.form.validatorNameLabel) as HTMLInputElement).value,
    ).toBe('no-such-validator');
  });

  test('is not offered until every field has something, and a maximum of attempts is a positive whole number', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    const element = await openCreatePage(view);
    const dialog = within(element);
    const create = dialog.getByRole('button', { name: GOALS_COPY.form.createAction });
    expect(create).toBeDisabled();

    await fillGoal(element);
    await waitFor(() => expect(create).not.toBeDisabled());
    for (const label of [
      GOALS_COPY.form.maximumAttemptsLabel,
      GOALS_COPY.form.maximumTotalStepsLabel,
    ]) {
      const field = dialog.getByLabelText(label);
      const original = (field as HTMLInputElement).value;
      for (const bad of ['0', '-2', '1.5', '']) {
        await fireEvent.input(field, { target: { value: bad } });
        await waitFor(() => expect(create, `${label} ${bad}`).toBeDisabled());
      }
      await fireEvent.input(field, { target: { value: original } });
      await waitFor(() => expect(create).not.toBeDisabled());
    }
    expect(stub?.callsTo('bureau.goals.create')).toEqual([]);
  });
});

describe('a goal whose controller failed to start', () => {
  const REASON = 'The controller could not start: the run engine is shutting down.';

  test('stays on the page, which says so, with the reason and the id, and cannot be submitted again', async () => {
    const { view, served } = open([goal('goal-1')], {
      controller: { status: 'start-failed', reason: REASON },
    });
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    const element = await openCreatePage(view);
    const dialog = within(element);
    await fillGoal(element);
    await fireEvent.click(dialog.getByRole('button', { name: GOALS_COPY.form.createAction }));

    const notice = await dialog.findByTestId('goal-not-started');
    expect(notice.textContent).toContain(GOALS_COPY.form.startFailedTitle);
    expect(notice.textContent).toContain(REASON);
    expect(notice.textContent).toContain(GOALS_COPY.form.startFailedGoal('goal-created-1'));
    // The page is still there, read-only, and Cancel has become Close.
    expect(router.pathname).toBe('/goals/new');
    expect(dialog.getByRole('button', { name: GOALS_COPY.form.createAction })).toBeDisabled();
    expect(dialog.queryByRole('button', { name: GOALS_COPY.form.cancelAction })).toBeNull();
    for (const label of [
      GOALS_COPY.form.agentLabel,
      GOALS_COPY.form.promptLabel,
      GOALS_COPY.form.identityNameLabel,
      GOALS_COPY.form.validatorNameLabel,
      GOALS_COPY.form.maximumAttemptsLabel,
    ]) {
      expect(dialog.getByLabelText(label), label).toBeDisabled();
    }
    expect(served.goals.map((candidate) => candidate.goalRunId)).toContain('goal-created-1');
    // Submitting again would reuse the key and come back `existing`, so it is not offered.
    await fireEvent.click(dialog.getByRole('button', { name: GOALS_COPY.form.createAction }));
    expect(stub?.callsTo('bureau.goals.create')).toHaveLength(1);

    // Close goes to the goal that was made, which the Bureau holds and has not started.
    await fireEvent.click(dialog.getByRole('link', { name: GOALS_COPY.form.closeAction }));
    await waitFor(() => expect(router.pathname).toBe('/goals/goal-created-1'));
  });
});

describe('cancelling a goal', () => {
  test('asks first, names the revision the page read, and shows the row ended once the Bureau says so', async () => {
    const { view } = open([goal('goal-1', { revision: 7 })]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());

    await fireEvent.click(
      within(row(view.container, 'goal-1') as HTMLElement).getByRole('button', {
        name: GOALS_COPY.cancelAction,
      }),
    );
    expect(stub?.callsTo('bureau.goals.cancel')).toEqual([]);
    await fireEvent.click(
      await view.findByRole('button', { name: GOALS_COPY.cancelDialog.confirm }),
    );

    await waitFor(() => expect(row(view.container, 'goal-1')?.dataset['status']).toBe('canceled'));
    expect(stub?.callsTo('bureau.goals.cancel')[0]?.params).toEqual({
      goalRunId: 'goal-1',
      expectedRevision: 7,
    });
  });

  test('is offered only for a goal that has not ended', async () => {
    const { view } = open([
      goal('goal-run', { status: 'running' }),
      goal('goal-done', { status: 'succeeded' }),
      goal('goal-gone', { status: 'canceled' }),
      goal('goal-out', { status: 'exhausted' }),
      goal('goal-bad', { status: 'failed' }),
    ]);
    await waitFor(() => expect(row(view.container, 'goal-run')).not.toBeNull());

    const cancels = (id: string) =>
      within(row(view.container, id) as HTMLElement).queryByRole('button', {
        name: GOALS_COPY.cancelAction,
      });
    expect(cancels('goal-run')).not.toBeNull();
    for (const id of ['goal-done', 'goal-gone', 'goal-out', 'goal-bad']) {
      expect(cancels(id), id).toBeNull();
    }
  });

  test('says the goal changed since it was loaded when it moved first, and reloads the row', async () => {
    const { view, served } = open([goal('goal-1', { revision: 7 })]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    // The controller moved the goal on after the page read it: another attempt, so another revision.
    const moved = served.goals[0];
    if (moved === undefined) throw new Error('expected the goal');
    moved.status = 'evaluating';
    moved.revision = 8;

    await fireEvent.click(
      within(row(view.container, 'goal-1') as HTMLElement).getByRole('button', {
        name: GOALS_COPY.cancelAction,
      }),
    );
    await fireEvent.click(
      await view.findByRole('button', { name: GOALS_COPY.cancelDialog.confirm }),
    );

    const notice = await view.findByTestId('goal-notice');
    expect(notice.textContent).toContain(SCHEDULE_COPY.stale.title('goal-1'));
    expect(moved.status).toBe('evaluating');
    await waitFor(() =>
      expect(row(view.container, 'goal-1')?.dataset['status']).toBe('evaluating'),
    );
    // Cancelling again names the revision it can see now.
    await fireEvent.click(
      within(row(view.container, 'goal-1') as HTMLElement).getByRole('button', {
        name: GOALS_COPY.cancelAction,
      }),
    );
    await fireEvent.click(
      await view.findByRole('button', { name: GOALS_COPY.cancelDialog.confirm }),
    );
    await waitFor(() => expect(row(view.container, 'goal-1')?.dataset['status']).toBe('canceled'));
    expect(stub?.callsTo('bureau.goals.cancel').at(-1)?.params).toEqual({
      goalRunId: 'goal-1',
      expectedRevision: 8,
    });
  });
});

describe('who may see the goals', () => {
  test('a principal holding no console scope sees its goals, not a forbidden view', async () => {
    const { view } = open([goal('goal-1')], { scopes: [] });

    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    expect(frameState(view.container)).toBe('ready');
  });

  test('a refusal from the Bureau is the forbidden state', async () => {
    stub = installBureauStub({
      'bureau.goals.list': () => {
        throw new StubFault('Forbidden', 403, 'Not yours.');
      },
    });
    landAt('/goals');
    const { container, findByRole } = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    await findByRole('heading', { level: 1, name: VIEW_COPY.goals.forbidden.title });
    expect(frameState(container)).toBe('forbidden');
  });

  test('is empty, with a way to make the first goal, when the caller has none', async () => {
    const { view } = open([]);

    await view.findByRole('heading', { level: 1, name: VIEW_COPY.goals.empty?.title ?? '' });
    expect(frameState(view.container)).toBe('empty');
  });
});

describe('a goal the Bureau is still stopping', () => {
  test('says the cancellation is recorded and will finish, and shows the goal as asked to stop', async () => {
    const { view } = open([goal('goal-1', { revision: 7 })]);
    await waitFor(() => expect(row(view.container, 'goal-1') === null).toBe(false));
    stub?.restore();
    // The Bureau records the cancellation and has not finished.
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: AGENTS }),
      'bureau.goals.list': () => ({
        goals: [
          goal('goal-1', {
            revision: 8,
            status: 'evaluating',
            cancellation: { requestedAt: '2026-10-19T08:06:00.000Z', reason: null },
          }),
        ],
        nextOffset: null,
      }),
      'bureau.goals.cancel': () => ({
        goalRunId: 'goal-1',
        outcome: 'cancellation-pending',
        status: 'evaluating',
        revision: 8,
      }),
    });

    await fireEvent.click(
      within(row(view.container, 'goal-1') as HTMLElement).getByRole('button', {
        name: GOALS_COPY.cancelAction,
      }),
    );
    await fireEvent.click(
      await view.findByRole('button', { name: GOALS_COPY.cancelDialog.confirm }),
    );

    await view.findByText(GOALS_COPY.cancelPending);
    await waitFor(() =>
      expect(row(view.container, 'goal-1')?.textContent).toContain(GOALS_COPY.cancelRequested),
    );
  });

  test('is a toast that says the goal was not cancelled when the Bureau refuses for another reason', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1') === null).toBe(false));
    stub?.restore();
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: AGENTS }),
      'bureau.goals.list': () => ({ goals: [goal('goal-1')], nextOffset: null }),
      'bureau.goals.cancel': () => {
        throw new StubFault('Unavailable', 503, 'The goal’s record cannot be read.');
      },
    });

    await fireEvent.click(
      within(row(view.container, 'goal-1') as HTMLElement).getByRole('button', {
        name: GOALS_COPY.cancelAction,
      }),
    );
    await fireEvent.click(
      await view.findByRole('button', { name: GOALS_COPY.cancelDialog.confirm }),
    );

    await view.findByText(GOALS_COPY.cancelFailed, { exact: false });
  });
});

describe('the list of goals', () => {
  test('says so inline, and can be tried again, when a read fails after the view opened', async () => {
    let failing = false;
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: AGENTS }),
      'bureau.goals.list': (params) => {
        if (params['limit'] === 1) return { goals: [goal('goal-1')], nextOffset: null };
        if (failing) throw new StubFault('Unavailable', 503, 'The Bureau is down.');
        return { goals: [goal('goal-1')], nextOffset: null };
      },
    });
    landAt('/goals');
    failing = true;
    const { findByRole, container, findByText } = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    await findByText(VIEW_COPY.goals.error.title);
    failing = false;
    await fireEvent.click(await findByRole('button', { name: RETRY_LABEL }));

    await findByText('goal-1');
    expect(row(container, 'goal-1') === null).toBe(false);
  });

  test('links a goal’s agent, and leaves a modified click to the browser', async () => {
    const { view } = open([goal('goal-1')]);
    const link = await view.findByRole('link', { name: 'assistant' });

    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/goals');
    link.click();

    expect(router.pathname).toBe('/agents/assistant');
  });
});

describe('the page that creates a goal', () => {
  test('offers the agents the Bureau lists as a picker, and says so when it cannot list them', async () => {
    const { view } = open([goal('goal-1')], { path: '/goals/new' });
    const agent = await view.findByLabelText(GOALS_COPY.form.agentLabel);
    expect(agent.tagName).toBe('SELECT');
    await waitFor(() =>
      expect(
        [...agent.querySelectorAll('option')].map((option) => option.value).filter(Boolean),
      ).toEqual(['assistant', 'tool-runner']),
    );
    cleanup();
    stub?.restore();

    stub = installBureauStub({
      'bureau.agents.list': () => {
        throw new StubFault('Unavailable', 503, 'No agents.');
      },
    });
    landAt('/goals/new');
    const failed = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);
    await failed.findByText(GOALS_COPY.form.agentUnavailableDescription);
    const picker = await failed.findByLabelText(GOALS_COPY.form.agentLabel);
    expect(picker.tagName).toBe('SELECT');
  });

  test('closes with Cancel, which goes back to the list, and creates nothing', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1') === null).toBe(false));
    const element = await openCreatePage(view);
    const cancel = within(element).getByRole('link', { name: GOALS_COPY.form.cancelAction });

    // A modified click is left to the browser.
    cancel.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(router.pathname).toBe('/goals/new');
    await fireEvent.click(cancel);

    await waitFor(() => expect(router.pathname).toBe('/goals'));
    expect(stub?.callsTo('bureau.goals.create')).toEqual([]);
  });
});

describe('the records page', () => {
  test('counts the goals, says each status in the seven words, and filters by status and agent', async () => {
    const { view } = open([
      goal('goal-1', { status: 'running' }),
      goal('goal-2', { status: 'succeeded', agentName: 'tool-runner' }),
      goal('goal-3', { status: 'exhausted' }),
    ]);
    await waitFor(() => expect(row(view.container, 'goal-3')).not.toBeNull());
    expect(view.getByTestId('records-count').textContent).toBe(GOALS_COPY.count(3));
    const words = [...view.container.querySelectorAll('tr[data-goal]')].map((tableRow) =>
      tableRow.getAttribute('data-status-word'),
    );
    expect(words).toEqual(['Running', 'Done', 'Failed']);
    for (const word of words) expect(STATUS_WORDS as readonly (string | null)[]).toContain(word);

    await fireEvent.change(await view.findByLabelText(GOALS_COPY.statusColumn), {
      target: { value: 'Failed' },
    });
    await waitFor(() => expect(router.search.get('status')).toBe('Failed'));
    await waitFor(() => expect(row(view.container, 'goal-1') === null).toBe(true));
    expect(row(view.container, 'goal-3')).not.toBeNull();
    expect(view.getByTestId('records-count').textContent).toBe(GOALS_COPY.count(1));

    await fireEvent.change(await view.findByLabelText(GOALS_COPY.agentColumn), {
      target: { value: 'tool-runner' },
    });
    await view.findByRole('heading', { level: 2, name: GOALS_COPY.noMatch.title });
    expect(view.container.querySelector('[data-cinder-kind="filtered"]')).not.toBeNull();

    const clear = view.container.querySelector<HTMLButtonElement>(
      '[data-cinder-kind="filtered"] button',
    );
    if (clear === null) throw new Error('The empty state did not offer Clear filters.');
    await fireEvent.click(clear);
    await waitFor(() => expect(router.search.get('status')).toBeNull());
    await waitFor(() => expect(row(view.container, 'goal-2')).not.toBeNull());
  });

  test('links a goal’s identifier to its page', async () => {
    const { view } = open([goal('goal-1')]);
    const link = await view.findByRole('link', { name: 'goal-1' });
    expect(link.getAttribute('href')).toBe('/goals/goal-1');
    link.click();
    expect(router.pathname).toBe('/goals/goal-1');
  });
});

describe('a goal’s page', () => {
  const ATTEMPTS = [
    {
      attemptId: 'goal-1-a1',
      attemptIndex: 1,
      runId: 'run-b',
      sessionId: 'session-b',
      status: 'passed',
      startedAt: '2026-10-19T08:03:00.000Z',
      completedAt: '2026-10-19T08:04:00.000Z',
      finishReason: 'validator-passed',
      usage: { steps: 1, tokens: 1, costUsd: null },
    },
    {
      attemptId: 'goal-1-a0',
      attemptIndex: 0,
      runId: 'run-a',
      sessionId: 'session-a',
      status: 'failed',
      startedAt: '2026-10-19T08:01:00.000Z',
      completedAt: '2026-10-19T08:02:00.000Z',
      finishReason: 'validator-rejected',
      usage: { steps: 1, tokens: 1, costUsd: null },
    },
  ];

  test('lists the attempts in the order they ran, each linking to its run, in the seven words', async () => {
    const { view } = open(
      [
        goal('goal-1', {
          status: 'succeeded',
          attempts: ATTEMPTS,
          closedAt: '2026-10-19T08:05:00.000Z',
        }),
      ],
      { path: '/goals/goal-1' },
    );

    await view.findByRole('heading', { level: 1, name: GOALS_COPY.detail.title('goal-1') });
    await waitFor(() => expect(view.container.querySelectorAll('tr[data-attempt]').length).toBe(2));
    const attempts = [...view.container.querySelectorAll('tr[data-attempt]')];
    expect(attempts.map((attempt) => attempt.getAttribute('data-run'))).toEqual(['run-a', 'run-b']);
    expect(
      attempts.map(
        (attempt) => within(attempt as HTMLElement).getByText(/Failed|Done/).textContent,
      ),
    ).toEqual(['Failed', 'Done']);
    const link = within(attempts[0] as HTMLElement).getByRole('link', { name: 'run-a' });
    expect(link.getAttribute('href')).toBe('/runs/run-a');
    expect(within(view.getByTestId('goal-facts')).getByText('Done')).not.toBeNull();
    expect(frameState(view.container)).toBe('ready');
  });

  test('says there are no attempts yet for a goal that has not started one', async () => {
    const { view } = open([goal('goal-1', { status: 'pending' })], { path: '/goals/goal-1' });
    await view.findByRole('heading', { level: 3, name: GOALS_COPY.detail.noAttempts.title });
    expect(view.container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
    expect(within(view.getByTestId('goal-facts')).getByText('Scheduled')).not.toBeNull();
  });

  test('says when and why a goal ended, and links back to the list', async () => {
    const { view } = open(
      [
        goal('goal-1', {
          status: 'exhausted',
          terminalReason: 'out of attempts',
          closedAt: '2026-10-19T09:00:00.000Z',
        }),
      ],
      { path: '/goals/goal-1' },
    );

    const facts = within(await view.findByTestId('goal-facts'));
    expect(facts.getByText('Failed')).not.toBeNull();
    expect(facts.getByText(GOALS_COPY.detail.endedFact)).not.toBeNull();
    expect(facts.getByText('out of attempts')).not.toBeNull();
    const back = view.getByRole('link', { name: GOALS_COPY.detail.backToList });
    back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/goals/goal-1');
    back.click();
    expect(router.pathname).toBe('/goals');
  });

  test('says the goal could not be loaded when the Bureau stops answering after the page opened, and tries again', async () => {
    const { view, served } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    // The frame's probe is told the goal exists; the page that follows finds the Bureau down.
    let asked = 0;
    stub?.on('bureau.goals.get', () => {
      asked += 1;
      if (asked === 1) return served.goals[0];
      throw new StubFault('Unavailable', 503, 'The Bureau is down.');
    });
    router.navigate('/goals/goal-1');

    await view.findByRole('heading', { level: 1, name: GOALS_COPY.detail.loadFailed.title });
    const before = asked;
    await fireEvent.click(await view.findByRole('button', { name: RETRY_LABEL }));
    await waitFor(() => expect(asked).toBeGreaterThan(before));
  });

  test('is not found for a goal the Bureau does not have', async () => {
    const { view } = open([], { path: '/goals/missing' });
    await waitFor(() => expect(frameState(view.container)).toBe('not-found'));
  });
});

describe('a submit that is sent again', () => {
  test('is the same goal: a retry after a lost answer carries the same key, and a changed request a new one', async () => {
    let attempts = 0;
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1') === null).toBe(false));
    stub?.on('bureau.goals.create', () => {
      attempts += 1;
      if (attempts === 1) throw new StubFault('Unavailable', 503, 'The answer was lost.');
      throw new StubFault('Unprocessable', 422, 'Stop here.', { reason: 'validator-not-found' });
    });
    const element = await openCreatePage(view);
    const dialog = within(element);
    await fillGoal(element);
    const create = dialog.getByRole('button', { name: GOALS_COPY.form.createAction });

    await fireEvent.click(create);
    await dialog.findByTestId('goal-fault');
    await fireEvent.click(create);
    await waitFor(() => expect(stub?.callsTo('bureau.goals.create').length).toBe(2));
    await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.promptLabel), {
      target: { value: 'A different prompt.' },
    });
    await fireEvent.click(create);
    await waitFor(() => expect(stub?.callsTo('bureau.goals.create').length).toBe(3));

    const keys = stub?.callsTo('bureau.goals.create').map((call) => call.params['idempotencyKey']);
    expect(keys?.[0]).toBe(keys?.[1]);
    expect(keys?.[2]).not.toBe(keys?.[0]);
  });
});
