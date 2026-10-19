/**
 * `/goals` (COR-1494): the caller's goals, listed with where each stands, created from an agent, a
 * prompt, an identity, a validator named by free text, and a maximum number of attempts, and
 * cancelled. An unknown validator is the Bureau's `Unprocessable`, said inline. A cancel names the
 * revision of the goal the page read, so a goal that moved since is refused, and the page says so and
 * reloads the row. Owner scoping is the gate, so the view holds no scope of its own.
 *
 * Driven through the route outlet against a stand-in Bureau that keeps the goals, so the route, the
 * view frame, and the page are exercised together.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { GOALS_COPY, SCHEDULE_COPY, VIEW_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
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
  publishState: 'published',
}));

/** The only validator this Bureau was configured with. */
const KNOWN_VALIDATOR = { name: 'accepts-any-answer', version: '1' };

type Served = { goals: GoalRow[]; pageSize: number };

function open(
  initial: GoalRow[] = [],
  options: { scopes?: readonly string[]; pageSize?: number } = {},
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
      return { outcome: 'created', goal: made, controller: { status: 'started', reason: null } };
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
  landAt('/goals');
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
    target: { value: '1' },
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
    // A status is shown as the Bureau names it, so a row can be matched to what the operation says.
    expect(first.getByText('running')).not.toBeNull();
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
});

describe('creating a goal', () => {
  test('takes an agent, a prompt, an identity, a validator by free text, and a maximum number of attempts, with a bound on steps, and sends exactly those', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());

    await fireEvent.click(view.getByRole('button', { name: GOALS_COPY.newAction }));
    const element = await view.findByRole('dialog', { name: GOALS_COPY.form.title });
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
      agentName: 'assistant',
      prompt: 'Say hello.',
      identity: { name: 'say-hello', version: '1' },
      validator: { name: 'accepts-any-answer', version: '1' },
      // The Bureau needs a bound on all the attempts together besides how many it makes.
      bounds: { maximumAttempts: 4, maximumTotalSteps: 20 },
    });
    await waitFor(() => expect(row(view.container, 'goal-created-1')).not.toBeNull());
    expect(row(view.container, 'goal-created-1')?.dataset['status']).toBe('pending');
  });

  test('says Unprocessable inline for a validator the Bureau does not have, and creates nothing', async () => {
    const { view, served } = open([]);
    await fireEvent.click(
      await view.findByRole('link', { name: VIEW_COPY.goals.empty?.action?.label ?? '' }),
    );
    const element = await view.findByRole('dialog', { name: GOALS_COPY.form.title });
    const dialog = within(element);
    await fillGoal(element, { validatorName: 'no-such-validator' });

    await fireEvent.click(dialog.getByRole('button', { name: GOALS_COPY.form.createAction }));

    const fault = await dialog.findByTestId('goal-fault');
    expect(fault.getAttribute('data-fault-code')).toBe('Unprocessable');
    expect(fault.textContent).toContain('no-such-validator@1');
    expect(served.goals).toEqual([]);
    // What was typed is still there, so the validator can be corrected.
    expect(
      (dialog.getByLabelText(GOALS_COPY.form.validatorNameLabel) as HTMLInputElement).value,
    ).toBe('no-such-validator');
  });

  test('is not offered until every field has something, and a maximum of attempts is a positive whole number', async () => {
    const { view } = open([goal('goal-1')]);
    await waitFor(() => expect(row(view.container, 'goal-1')).not.toBeNull());
    await fireEvent.click(view.getByRole('button', { name: GOALS_COPY.newAction }));
    const element = await view.findByRole('dialog', { name: GOALS_COPY.form.title });
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
