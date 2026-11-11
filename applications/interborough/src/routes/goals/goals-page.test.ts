/**
 * The routes under `/goals` (COR-1494, COR-2017): a goal made on `/goals/new` from a prompt, a check,
 * an agent and an attempt limit, and a goal's own page with its attempts. A check the Bureau lacks
 * is its `Unprocessable`, said above the form's buttons. The form's Edit page, Start again, the
 * provider gate and the creating state are `goal-form-pages.test.ts`; the list is
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
import { taskFixture, toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
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

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  assistant: 'Assistant',
  'tool-runner': 'Tool runner',
};

const AGENTS = ['assistant', 'tool-runner'].map((name) => ({
  name,
  displayName: AGENT_DISPLAY_NAMES[name] ?? name,
  description: null,
  definitionRevision: 1,
  kind: 'code',
  a2a: false,
}));

/** The only check this Bureau was configured with, as a person writes it and as its validator is named. */
const KNOWN_CHECK = 'Accepts any answer';
const KNOWN_VALIDATOR = { name: 'accepts-any-answer', version: '1' };

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
    /** The agents the Bureau lists, which are {@link AGENTS} unless said. */
    agents?: readonly Record<string, unknown>[];
    /** The providers `/host/providers` reports; left out, the host does not say. */
    hostProviders?: readonly { name: string; hasKey: boolean }[];
  } = {},
) {
  const served: Served = { goals: [...initial], pageSize: options.pageSize ?? 50 };
  let created = 0;
  stub = installBureauStub(
    {
      'bureau.agents.list': () => ({ agents: options.agents ?? AGENTS }),
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
    },
    options.hostProviders === undefined ? {} : { hostProviders: options.hostProviders },
  );
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

/** Waits for the agent field to settle on Assistant, which the form starts with once the agents are read. */
async function waitForDefaultAgent(element: HTMLElement): Promise<HTMLSelectElement> {
  const agent = (await within(element).findByLabelText(
    GOALS_COPY.form.agentLabel,
  )) as HTMLSelectElement;
  await waitFor(() => expect(agent.value).toBe('assistant'));
  return agent;
}

/** Types the attempt limit as a person does: focus the field, type, and leave it. */
async function setAttemptLimit(element: HTMLElement, value: string) {
  const field = within(element).getByLabelText(GOALS_COPY.form.maximumAttemptsLabel);
  await fireEvent.focus(field);
  await fireEvent.input(field, { target: { value } });
  await fireEvent.blur(field);
}

/** Fills the prompt and the check, which are what a goal needs besides the agent the form starts with. */
async function fillGoal(element: HTMLElement, values: { check?: string } = {}) {
  const dialog = within(element);
  await waitForDefaultAgent(element);
  await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.promptLabel), {
    target: { value: 'Say hello.' },
  });
  await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.checkLabel), {
    target: { value: values.check ?? KNOWN_CHECK },
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

  test('takes a prompt, a check, an agent and an attempt limit, sends exactly those with a bound on steps, and lands on the new goal', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());

    const element = await openCreatePage(view);
    expect(router.pathname).toBe('/goals/new');
    const dialog = within(element);
    await fillGoal(element);
    await fireEvent.input(dialog.getByLabelText(GOALS_COPY.form.promptLabel), {
      target: { value: '  Say hello.\nThen keep trying.  ' },
    });
    await setAttemptLimit(element, '4');
    await fireEvent.click(dialog.getByRole('button', { name: GOALS_COPY.form.createAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.goals.create').length).toBe(1));
    expect(stub?.callsTo('bureau.goals.create')[0]?.params).toEqual({
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9._-]{1,64}$/),
      agentName: 'assistant',
      prompt: 'Say hello.\nThen keep trying.',
      // The first line of the prompt names the goal, at the form's own version.
      identity: { name: 'Say hello.', version: '1' },
      // The check is the validator's name as a slug.
      validator: KNOWN_VALIDATOR,
      // The Bureau needs a bound on all the attempts together besides how many it makes.
      bounds: { maximumAttempts: 4, maximumTotalSteps: 50 },
    });
    // A goal that is made takes the person to its own page.
    await waitFor(() => expect(router.pathname).toBe('/goals/goal-created-1'));
  });

  test('says Unprocessable above the buttons for a check the Bureau does not have, creates nothing, and keeps what was typed', async () => {
    const { view, served } = open([]);
    // The header's "+" and the empty state's primary button both make a goal.
    const makers = await view.findAllByRole('button', { name: GOALS_COPY.newAction });
    await fireEvent.click(makers[0] as HTMLElement);
    await view.findByRole('heading', { level: 1, name: GOALS_COPY.form.title });
    expect(router.pathname).toBe('/goals/new');
    const element = view.container;
    const dialog = within(element);
    await fillGoal(element, { check: 'No such validator' });

    await fireEvent.click(dialog.getByRole('button', { name: GOALS_COPY.form.createAction }));

    const fault = await dialog.findByTestId('goal-fault');
    expect(fault.getAttribute('data-fault-code')).toBe('Unprocessable');
    expect(fault.textContent).toContain(GOALS_COPY.form.failedTitle);
    expect(fault.textContent).toContain('no-such-validator@1');
    expect(fault.textContent).toContain(GOALS_COPY.form.kept);
    expect(dialog.getByRole('button', { name: GOALS_COPY.form.tryAgain })).not.toBeNull();
    expect(served.goals).toEqual([]);
    // What was typed is still there, so the check can be corrected.
    expect((dialog.getByLabelText(GOALS_COPY.form.checkLabel) as HTMLInputElement).value).toBe(
      'No such validator',
    );
    expect((dialog.getByLabelText(GOALS_COPY.form.promptLabel) as HTMLTextAreaElement).value).toBe(
      'Say hello.',
    );
  });

  test('stays live with nothing typed, says what is missing at the field and in the footer, and focuses the first', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    const element = await openCreatePage(view);
    const dialog = within(element);
    await waitForDefaultAgent(element);
    const create = dialog.getByRole('button', { name: GOALS_COPY.form.createAction });
    expect(create).not.toBeDisabled();
    // Assistant is scripted, so nothing waits on a provider.
    expect(dialog.getByTestId('goal-form-note').textContent).toBe(
      GOALS_COPY.form.footer.scripted('Assistant'),
    );

    await fireEvent.click(create);
    const prompt = dialog.getByLabelText(GOALS_COPY.form.promptLabel);
    await waitFor(() => expect(document.activeElement === prompt).toBe(true));
    expect(dialog.getByText(GOALS_COPY.form.promptRequired)).not.toBeNull();
    expect(dialog.getByTestId('goal-form-note').textContent).toBe(GOALS_COPY.form.footer.prompt);

    await fireEvent.input(prompt, { target: { value: 'Say hello.' } });
    await fireEvent.click(create);
    const check = dialog.getByLabelText(GOALS_COPY.form.checkLabel);
    await waitFor(() => expect(document.activeElement === check).toBe(true));
    expect(check.getAttribute('placeholder')).toBe(GOALS_COPY.form.checkPlaceholder);
    expect(dialog.getByText(GOALS_COPY.form.checkRequired)).not.toBeNull();
    expect(dialog.getByTestId('goal-form-note').textContent).toBe(GOALS_COPY.form.footer.check);
    expect(create).not.toBeDisabled();
    expect(stub?.callsTo('bureau.goals.create')).toEqual([]);
  });

  test('says an attempt limit outside 1 to 20 at the field, focuses it, and sends nothing', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    const element = await openCreatePage(view);
    const dialog = within(element);
    await fillGoal(element);
    await setAttemptLimit(element, '30');

    await fireEvent.click(dialog.getByRole('button', { name: GOALS_COPY.form.createAction }));

    const limit = dialog.getByLabelText(GOALS_COPY.form.maximumAttemptsLabel);
    await waitFor(() => expect(document.activeElement === limit).toBe(true));
    expect(dialog.getByText(GOALS_COPY.form.maximumAttemptsInvalid)).not.toBeNull();
    expect(dialog.getByTestId('goal-form-note').textContent).toBe(GOALS_COPY.form.footer.attempts);
    expect(dialog.getByRole('button', { name: GOALS_COPY.form.createAction })).not.toBeDisabled();
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
    expect(dialog.queryByRole('link', { name: GOALS_COPY.form.cancelAction })).toBeNull();
    for (const label of [
      GOALS_COPY.form.agentLabel,
      GOALS_COPY.form.promptLabel,
      GOALS_COPY.form.checkLabel,
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

  const attemptRowsOf = (container: HTMLElement) => [
    ...container.querySelectorAll<HTMLElement>('[data-attempt]'),
  ];

  test('is titled by the goal’s name and lists its attempts newest first, each linking to its run', async () => {
    const { view } = open(
      [
        goal('goal-1', {
          identity: { name: 'Say hello', version: '1' },
          status: 'succeeded',
          usage: { attempts: 2, steps: 2, tokens: 2, costUsd: null, durationMs: 120_000 },
          attempts: ATTEMPTS,
          closedAt: '2026-10-19T08:05:00.000Z',
        }),
      ],
      { path: '/goals/goal-1' },
    );

    await view.findByRole('heading', { level: 1, name: 'Say hello' });
    await waitFor(() => expect(attemptRowsOf(view.container).length).toBe(2));
    const attempts = attemptRowsOf(view.container);
    expect(attempts.map((attempt) => attempt.getAttribute('data-run'))).toEqual(['run-b', 'run-a']);
    // A missed check is neutral: red is the goal's status alone.
    expect(attempts.map((attempt) => attempt.getAttribute('data-status-word'))).toEqual([
      'Done',
      'Check not met',
    ]);
    expect(attempts[0]?.querySelector('a')?.getAttribute('href')).toBe('/runs/run-b');
    expect(
      view.getByRole('heading', { level: 2, name: `${GOALS_COPY.detail.attemptsHeading} 2 of 3` }),
    ).not.toBeNull();
    const facts = within(view.getByTestId('goal-facts'));
    expect(facts.getByText(GOALS_COPY.detail.checkFact)).not.toBeNull();
    expect(facts.getByText('Reply says hello')).not.toBeNull();
    expect(facts.getByText('3 attempts')).not.toBeNull();
    expect(frameState(view.container)).toBe('ready');
  });

  test('says the check was met in a note that opens the attempt, and offers Edit but not Start again', async () => {
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

    const note = await view.findByTestId('goal-note');
    expect(note.textContent).toContain('Done on attempt 2 of 3: the check was met');
    const open2 = within(note).getByRole('link', { name: 'Open attempt 2' });
    expect(open2.getAttribute('href')).toBe('/runs/run-b');
    const actions = within(view.getByTestId('goal-actions'));
    expect(
      actions.getByRole('link', { name: GOALS_COPY.detail.editAction }).getAttribute('href'),
    ).toBe('/goals/goal-1/edit');
    expect(actions.queryByRole('link', { name: GOALS_COPY.detail.startAgainAction })).toBeNull();
    expect(actions.queryByRole('button', { name: GOALS_COPY.detail.stopAction })).toBeNull();
  });

  test('says there are no attempts yet for a goal that has not started one', async () => {
    const { view } = open(
      [goal('goal-1', { status: 'pending', usage: { ...goal('x').usage, attempts: 0 } })],
      {
        path: '/goals/goal-1',
      },
    );
    await view.findByRole('heading', { level: 3, name: GOALS_COPY.detail.noAttempts.title });
    expect(view.container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
  });

  test('offers Start again on a goal that gave up, which opens New goal from it', async () => {
    const { view } = open(
      [
        goal('goal-1', {
          status: 'exhausted',
          terminalReason: 'attempt-limit-reached',
          closedAt: '2026-10-19T09:00:00.000Z',
        }),
      ],
      { path: '/goals/goal-1' },
    );

    const again = await view.findByRole('link', { name: GOALS_COPY.detail.startAgainAction });
    expect(again.getAttribute('href')).toBe('/goals/new?from=goal-1');
    expect(again.getAttribute('aria-disabled')).toBeNull();
    expect(view.getByTestId('goal-note').textContent).toContain('Gave up');
    again.click();
    expect(router.pathname).toBe('/goals/new');
  });

  test('turns Start again off for a model agent while no provider holds a key, and says to connect one', async () => {
    const { view } = open(
      [
        goal('goal-1', {
          agentName: 'tool-runner',
          status: 'canceled',
          closedAt: '2026-10-19T09:00:00.000Z',
        }),
      ],
      {
        path: '/goals/goal-1',
        hostProviders: [{ name: 'anthropic', hasKey: false }],
        // Tool runner names a model, so it needs a provider; Assistant is scripted.
        agents: AGENTS.map((agent) =>
          agent.name === 'tool-runner'
            ? { ...agent, media: { modalities: {}, mimeFamilies: [], mediaLimits: [] } }
            : agent,
        ),
      },
    );

    const reason = await view.findByRole('link', { name: GOALS_COPY.detail.connectProvider });
    expect(reason.getAttribute('href')).toBe(GOALS_COPY.detail.connectProviderPath);
    const again = view
      .getAllByText(GOALS_COPY.detail.startAgainAction)
      .map((text) => text.closest('a, button'))
      .find((element) => element !== null);
    expect(again?.getAttribute('aria-disabled')).toBe('true');
    expect(again?.getAttribute('aria-describedby')).toContain(reason.id);
  });

  test('asks before it stops a goal, then stops it at the revision it read', async () => {
    const { view, served } = open(
      [
        goal('goal-1', {
          identity: { name: 'Summarize open refunds', version: '1' },
          status: 'running',
        }),
      ],
      { path: '/goals/goal-1' },
    );

    await fireEvent.click(await view.findByRole('button', { name: GOALS_COPY.detail.stopAction }));
    const dialog = within(
      await view.findByRole('dialog', { name: 'Stop Summarize open refunds?' }),
    );
    expect(stub?.callsTo('bureau.goals.cancel')).toEqual([]);
    await fireEvent.click(dialog.getByRole('button', { name: GOALS_COPY.detail.stopAction }));

    await waitFor(() =>
      expect(stub?.callsTo('bureau.goals.cancel').map((call) => call.params)).toEqual([
        { goalRunId: 'goal-1', expectedRevision: 2 },
      ]),
    );
    expect(served.goals[0]?.status).toBe('canceled');
  });

  test('says an attempt waits on you in an amber note that opens the review in Reviews', async () => {
    const approval = toolApprovalFixture({ runId: 'run-live' });
    const { view } = open(
      [
        goal('goal-1', {
          agentName: 'tool-runner',
          status: 'running',
          attempts: [
            {
              attemptId: 'goal-1-a0',
              attemptIndex: 0,
              runId: 'run-live',
              sessionId: 'session-live',
              status: 'running',
              startedAt: '2026-10-19T08:01:00.000Z',
              completedAt: null,
              finishReason: null,
              usage: { steps: 1, tokens: 1, costUsd: null },
            },
          ],
        }),
      ],
      { path: '/goals/goal-1' },
    );
    stub?.on('bureau.tasks.get', () =>
      taskFixture({
        id: 'run-live',
        status: 'input-required',
        openWaits: [{ kind: 'tool-approval', reviewId: approval.id, callId: 'call-1' }],
      }),
    );
    stub?.on('bureau.reviews.get', () => approval);

    await waitFor(() =>
      expect(view.container.querySelector('[data-attempt]')?.getAttribute('data-status-word')).toBe(
        'Waiting on you',
      ),
    );
    const note = await view.findByTestId('goal-note');
    expect(note.getAttribute('data-tone')).toBe('warning');
    await waitFor(() =>
      expect(note.textContent).toContain(
        'Attempt 1 is waiting on you: Issue refund needs your approval before it can continue.',
      ),
    );
    expect(
      within(note)
        .getByRole('link', { name: GOALS_COPY.detail.note.openInReviews })
        .getAttribute('href'),
    ).toBe(`/reviews?review=${encodeURIComponent(`bureau:${approval.id}`)}`);
  });

  test('says the goal could not be loaded under its own heading when the Bureau stops answering, and tries again', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    // From here the Bureau is down for the goal: the frame's probe fails, and the page, which owns
    // its states on a goal's address, says so under its own header in place of the frame.
    let asked = 0;
    stub?.on('bureau.goals.get', () => {
      asked += 1;
      throw new StubFault('Unavailable', 503, 'The Bureau is down.');
    });
    router.navigate('/goals/goal-1');

    // The page keeps its own header, which reads "Goal" until the goal's name is known.
    await view.findByRole('heading', { level: 2, name: GOALS_COPY.detail.loadFailed.title });
    expect(
      view.getByRole('heading', { level: 1, name: GOALS_COPY.detail.loadingTitle }),
    ).not.toBeNull();
    await waitFor(() => expect(frameState(view.container)).toBe('error'));
    const before = asked;
    await fireEvent.click(await view.findByRole('button', { name: RETRY_LABEL }));
    await waitFor(() => expect(asked).toBeGreaterThan(before));
  });

  test('keeps its heading and its Attempts heading while the goal is read', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    // The goal never arrives, so the page stays in its loading state.
    stub?.on('bureau.goals.get', () => new Promise<never>(() => {}));
    router.navigate('/goals/goal-1');

    await view.findByRole('heading', { level: 1, name: GOALS_COPY.detail.loadingTitle });
    expect(
      view.getByRole('heading', { level: 2, name: GOALS_COPY.detail.attemptsHeading }),
    ).not.toBeNull();
    expect(view.queryByRole('link', { name: GOALS_COPY.detail.editAction })).toBeNull();
    expect(view.queryByRole('button', { name: GOALS_COPY.detail.stopAction })).toBeNull();
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
