/**
 * The routes under `/goals` (COR-1494): a goal made on `/goals/new` from an agent, a prompt, an
 * identity, a validator named by free text, and a maximum number of attempts, and a goal's own page
 * with its attempts. An unknown validator is the Bureau's `Unprocessable`, said inline. The list is
 * `goal-list.test.ts`. Owner scoping is the gate, so the view holds no scope of its own.
 *
 * Driven through the route outlet against a stand-in Bureau that keeps the goals, so the route, the
 * view frame, and the page are exercised together.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY, GOALS_COPY, RETRY_LABEL } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
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
    identity: { name: `Goal ${id}`, version: '1' },
    validator: { name: 'reply-says-hello', version: '1' },
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
  container.querySelector<HTMLElement>(`[data-goal="${id}"]`);
const frameState = (container: HTMLElement) =>
  container.querySelector('[data-view="goals"]')?.getAttribute('data-state');

/** Opens the page that makes a goal from the list's New goal link, and returns the page. */
async function openCreatePage(view: ReturnType<typeof open>['view']): Promise<HTMLElement> {
  await fireEvent.click(await view.findByRole('button', { name: GOALS_COPY.newAction }));
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
    // The header's "+" and the empty state's primary button both make a goal.
    const makers = await view.findAllByRole('button', { name: GOALS_COPY.newAction });
    await fireEvent.click(makers[0] as HTMLElement);
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
