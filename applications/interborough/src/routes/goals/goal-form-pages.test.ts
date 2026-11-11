/**
 * New goal and Edit goal (COR-2017, rows 68b to 68s, and the page half of S25), driven through the
 * route outlet against a stand-in Bureau: Edit is New goal opened on a goal, Start again opens New
 * goal prefilled, a model agent waits on a provider, and a create or a save has a state while it is
 * in flight and one when it fails. The plain create, its validation and its start failure are
 * `goals-page.test.ts`; the draft's rules are `goal-form-state.svelte.test.ts`.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { GOALS_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import { goalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  installBureauStub,
  StubFault,
  type BureauHandler,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';

const copy = GOALS_COPY.form;

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const MODEL = { modalities: {}, mimeFamilies: [], mediaLimits: [] };

/** Assistant is scripted; Tool runner names a model. */
const AGENTS = [
  {
    name: 'assistant',
    displayName: 'Assistant',
    description: null,
    definitionRevision: 1,
    kind: 'code',
    a2a: false,
    media: null,
  },
  {
    name: 'tool-runner',
    displayName: 'Tool runner',
    description: null,
    definitionRevision: 1,
    kind: 'code',
    a2a: false,
    media: MODEL,
  },
];

const CHECK_TEXT = 'Summary lists every refund waiting for approval';
const CHECK_NAME = 'summary-lists-every-refund-waiting-for-approval';

/** The goal Edit and Start again open: Tool runner, asked to summarize refunds, 5 attempts at most. */
const SUMMARIZE = goalFixture('goal-summarize', {
  agentName: 'tool-runner',
  identity: { name: 'Summarize open refunds', version: '1' },
  validator: { name: CHECK_NAME, version: '1' },
  status: 'running',
  revision: 4,
  bounds: {
    maximumAttempts: 5,
    maximumTotalDurationMs: null,
    maximumTotalSteps: null,
    maximumTotalTokens: null,
    maximumTotalCostUsd: null,
  },
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

type Options = {
  /** How the Bureau answers a create, which makes the goal unless said. */
  create?: BureauHandler;
  /** How the Bureau answers an update, which says it changed the goal unless said. */
  update?: BureauHandler;
  hostProviders?: readonly { name: string; hasKey: boolean }[];
};

function open(path: string, options: Options = {}) {
  const goals = [SUMMARIZE];
  stub = installBureauStub(
    {
      'bureau.agents.list': () => ({ agents: AGENTS }),
      'bureau.goals.list': () => ({ goals, nextOffset: null }),
      'bureau.goals.get': (params) => {
        const found = goals.find((candidate) => candidate.goalRunId === params['goalRunId']);
        if (found === undefined) throw new StubFault('NotFound', 404, 'No such goal.');
        return found;
      },
      'bureau.goals.create':
        options.create ??
        (() => {
          const made = goalFixture('goal-created-1', { status: 'pending', revision: 1 });
          goals.push(made);
          return {
            outcome: 'created',
            goal: made,
            controller: { status: 'started', reason: null },
          };
        }),
      'bureau.goals.update':
        options.update ??
        ((params) => ({
          goalRunId: params['goalRunId'],
          outcome: 'updated',
          status: 'running',
          revision: 5,
        })),
    },
    options.hostProviders === undefined ? {} : { hostProviders: options.hostProviders },
  );
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

type View = ReturnType<typeof open>;

/** The page once the goal and the agents have filled it: its agent field shows `agent`. */
async function filledPage(view: View, heading: string, agent: string) {
  await view.findByRole('heading', { level: 1, name: heading });
  const page = within(view.container);
  const select = (await page.findByLabelText(copy.agentLabel)) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe(agent));
  return page;
}

async function chooseAgent(page: ReturnType<typeof within>, agent: string) {
  await fireEvent.change(page.getByLabelText(copy.agentLabel), { target: { value: agent } });
}

async function setAttemptLimit(page: ReturnType<typeof within>, value: string) {
  const field = page.getByLabelText(copy.maximumAttemptsLabel);
  await fireEvent.focus(field);
  await fireEvent.input(field, { target: { value } });
  await fireEvent.blur(field);
}

describe('the Edit goal page', () => {
  test('is New goal opened on the goal: the same four fields, its check and agent and limit, and a Save that starts no attempt', async () => {
    const view = open('/goals/goal-summarize/edit');
    const page = await filledPage(view, copy.edit.title, 'tool-runner');

    expect(page.getByText(copy.edit.description)).not.toBeNull();
    // The goal's view never carries its prompt, so the field is empty and says what that means.
    const prompt = page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement;
    expect(prompt.value).toBe('');
    expect(prompt.getAttribute('placeholder')).toBe(
      copy.edit.promptPlaceholder('Summarize open refunds'),
    );
    expect(page.getByText(copy.edit.agentLocked)).not.toBeNull();
    expect((page.getByLabelText(copy.checkLabel) as HTMLInputElement).value).toBe(CHECK_TEXT);
    expect((page.getByLabelText(copy.maximumAttemptsLabel) as HTMLInputElement).value).toBe('5');
    expect(page.getByTestId('goal-form-note').textContent).toBe(copy.edit.footer);
    expect(page.getByRole('button', { name: copy.edit.saveAction })).not.toBeDisabled();
    expect(page.getByRole('link', { name: copy.cancelAction }).getAttribute('href')).toBe(
      '/goals/goal-summarize',
    );
    expect(page.queryByRole('button', { name: copy.createAction })).toBeNull();
  });

  test('gates nothing on a provider, because saving starts no attempt', async () => {
    const view = open('/goals/goal-summarize/edit', {
      hostProviders: [{ name: 'anthropic', hasKey: false }],
    });
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    expect(page.queryByTestId('goal-needs-provider')).toBeNull();
    expect(page.getByRole('button', { name: copy.edit.saveAction })).not.toBeDisabled();
  });

  test('sends nothing for a save that changed nothing, and goes back to the goal', async () => {
    const view = open('/goals/goal-summarize/edit');
    const page = await filledPage(view, copy.edit.title, 'tool-runner');

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    await waitFor(() => expect(router.pathname).toBe('/goals/goal-summarize'));
    expect(stub?.callsTo('bureau.goals.update')).toEqual([]);
  });

  test('sends only what changed, against the revision it read, and lands on the goal', async () => {
    const view = open('/goals/goal-summarize/edit');
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    await fireEvent.input(page.getByLabelText(copy.promptLabel), {
      target: { value: 'Summarize open refunds, and say why each one waits.' },
    });
    await fireEvent.input(page.getByLabelText(copy.checkLabel), {
      target: { value: 'Summary lists every refund and the reason' },
    });
    await setAttemptLimit(page, '8');

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.goals.update').length).toBe(1));
    // The agent is not named: a goal's agent cannot change.
    expect(stub?.callsTo('bureau.goals.update')[0]?.params).toEqual({
      goalRunId: 'goal-summarize',
      expectedRevision: 4,
      prompt: 'Summarize open refunds, and say why each one waits.',
      validator: { name: 'summary-lists-every-refund-and-the-reason', version: '1' },
      maximumAttempts: 8,
    });
    await waitFor(() => expect(router.pathname).toBe('/goals/goal-summarize'));
  });

  test('says an attempt limit outside 1 to 20 at the field, as New goal does, and sends nothing', async () => {
    const view = open('/goals/goal-summarize/edit');
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    await setAttemptLimit(page, '30');

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    const limit = page.getByLabelText(copy.maximumAttemptsLabel);
    await waitFor(() => expect(document.activeElement === limit).toBe(true));
    expect(page.getByText(copy.maximumAttemptsInvalid)).not.toBeNull();
    expect(page.getByTestId('goal-form-note').textContent).toBe(copy.footer.attempts);
    expect(stub?.callsTo('bureau.goals.update')).toEqual([]);
  });

  test('says Saving while the Bureau answers: the button, the note, Cancel off and the fields read-only', async () => {
    const answer = deferred<unknown>();
    const view = open('/goals/goal-summarize/edit', { update: () => answer.promise });
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    await setAttemptLimit(page, '6');

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    await page.findByRole('button', { name: copy.edit.savingAction });
    expect(page.getByTestId('goal-form-note').textContent).toBe(copy.edit.saving);
    expect(page.getByRole('link', { name: copy.cancelAction }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect((page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement).readOnly).toBe(true);
    expect((page.getByLabelText(copy.checkLabel) as HTMLInputElement).readOnly).toBe(true);

    answer.resolve({
      goalRunId: 'goal-summarize',
      outcome: 'updated',
      status: 'running',
      revision: 5,
    });
    await waitFor(() => expect(router.pathname).toBe('/goals/goal-summarize'));
  });

  test('says a failed save fails the same way as a create does, keeps what was typed, and can try again', async () => {
    let calls = 0;
    const view = open('/goals/goal-summarize/edit', {
      update: (params) => {
        calls += 1;
        if (calls === 1) throw new StubFault('Unavailable', 503, 'No answer.');
        return {
          goalRunId: params['goalRunId'],
          outcome: 'updated',
          status: 'running',
          revision: 5,
        };
      },
    });
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    await setAttemptLimit(page, '7');

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    const fault = await page.findByTestId('goal-fault');
    expect(fault.textContent).toContain(copy.edit.failedTitle);
    expect(fault.textContent).toContain(copy.edit.kept);
    expect((page.getByLabelText(copy.maximumAttemptsLabel) as HTMLInputElement).value).toBe('7');
    expect(router.pathname).toBe('/goals/goal-summarize/edit');

    await fireEvent.click(page.getByRole('button', { name: copy.tryAgain }));
    await waitFor(() => expect(router.pathname).toBe('/goals/goal-summarize'));
    expect(stub?.callsTo('bureau.goals.update')).toHaveLength(2);
  });

  test('says a goal that moved since it was read changed, and nothing was changed', async () => {
    const view = open('/goals/goal-summarize/edit', {
      update: () => {
        throw new StubFault('StaleRevision', 409, 'The goal changed since it was read.', {
          expectedRevision: 4,
          currentRevision: 5,
        });
      },
    });
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    await setAttemptLimit(page, '7');

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    const fault = await page.findByTestId('goal-fault');
    expect(fault.getAttribute('data-fault-code')).toBe('StaleRevision');
    expect(fault.textContent).toContain(copy.edit.changed);
    expect(fault.textContent).toContain(copy.edit.kept);
  });

  test('says a goal that ended or is stopping cannot be changed, in the Bureau’s words', async () => {
    const view = open('/goals/goal-summarize/edit', {
      update: () => {
        throw new StubFault('Conflict', 409, 'The goal has ended.', { reason: 'goal-ended' });
      },
    });
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    await setAttemptLimit(page, '7');

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    const fault = await page.findByTestId('goal-fault');
    expect(fault.textContent).toContain('The goal has ended.');
    expect(fault.textContent).toContain(copy.edit.kept);
  });

  test('closes with Cancel, which goes back to the goal and changes nothing', async () => {
    const view = open('/goals/goal-summarize/edit');
    const page = await filledPage(view, copy.edit.title, 'tool-runner');

    await fireEvent.click(page.getByRole('link', { name: copy.cancelAction }));

    await waitFor(() => expect(router.pathname).toBe('/goals/goal-summarize'));
    expect(stub?.callsTo('bureau.goals.update')).toEqual([]);
  });

  test('is a goal the frame cannot find, so the goal is not drawn', async () => {
    const view = open('/goals/missing/edit');
    await waitFor(() =>
      expect(view.container.querySelector('[data-view="goals"]')?.getAttribute('data-state')).toBe(
        'not-found',
      ),
    );
    expect(view.queryByLabelText(copy.promptLabel)).toBeNull();
  });
});

describe('Start again', () => {
  test('opens New goal with the goal’s agent, check and attempt limit, and its name as the prompt', async () => {
    const view = open('/goals/new?from=goal-summarize', {
      hostProviders: [{ name: 'anthropic', hasKey: true }],
    });
    const page = await filledPage(view, copy.title, 'tool-runner');

    expect((page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement).value).toBe(
      'Summarize open refunds',
    );
    expect((page.getByLabelText(copy.checkLabel) as HTMLInputElement).value).toBe(CHECK_TEXT);
    expect((page.getByLabelText(copy.maximumAttemptsLabel) as HTMLInputElement).value).toBe('5');
    expect(page.queryByTestId('goal-needs-provider')).toBeNull();

    await fireEvent.click(page.getByRole('button', { name: copy.createAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.goals.create').length).toBe(1));
    expect(stub?.callsTo('bureau.goals.create')[0]?.params).toEqual({
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9._-]{1,64}$/),
      agentName: 'tool-runner',
      prompt: 'Summarize open refunds',
      identity: { name: 'Summarize open refunds', version: '1' },
      // The check is the goal's own, so its validator is named exactly as the goal holds it.
      validator: { name: CHECK_NAME, version: '1' },
      bounds: { maximumAttempts: 5, maximumTotalSteps: 50 },
    });
    await waitFor(() => expect(router.pathname).toBe('/goals/goal-created-1'));
  });

  test('opens the form as New goal does when the goal cannot be read', async () => {
    const view = open('/goals/new?from=missing');
    const page = await filledPage(view, copy.title, 'assistant');
    expect((page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement).value).toBe('');
    expect((page.getByLabelText(copy.checkLabel) as HTMLInputElement).value).toBe('');
  });
});

describe('a model agent chosen with no provider connected', () => {
  test('says so above the first field, turns Create goal off, and goes away when Assistant is chosen', async () => {
    const view = open('/goals/new', { hostProviders: [{ name: 'anthropic', hasKey: false }] });
    const page = await filledPage(view, copy.title, 'assistant');
    // Assistant is scripted, so the form opens with nothing gated.
    expect(page.queryByTestId('goal-needs-provider')).toBeNull();
    expect(page.getByRole('button', { name: copy.createAction })).not.toBeDisabled();

    await chooseAgent(page, 'tool-runner');

    const alert = await page.findByTestId('goal-needs-provider');
    expect(alert.textContent).toContain(copy.needsProvider('Tool runner'));
    expect(
      within(alert).getByRole('link', { name: copy.connectProvider }).getAttribute('href'),
    ).toBe(copy.connectProviderPath);
    expect(page.getByRole('button', { name: copy.createAction })).toBeDisabled();
    expect(page.getByTestId('goal-form-note').textContent).toBe(copy.footer.gated('Assistant'));

    await fireEvent.click(within(alert).getByRole('button', { name: copy.useAgent('Assistant') }));

    await waitFor(() =>
      expect(page.queryByTestId('goal-needs-provider')?.outerHTML ?? null).toBeNull(),
    );
    expect((page.getByLabelText(copy.agentLabel) as HTMLSelectElement).value).toBe('assistant');
    expect(page.getByRole('button', { name: copy.createAction })).not.toBeDisabled();
    expect(page.getByTestId('goal-form-note').textContent).toBe(copy.footer.scripted('Assistant'));
  });

  test('says nothing while the host does not say whether a provider holds a key', async () => {
    const view = open('/goals/new');
    const page = await filledPage(view, copy.title, 'assistant');
    await chooseAgent(page, 'tool-runner');
    expect(page.queryByTestId('goal-needs-provider')).toBeNull();
    expect(page.getByRole('button', { name: copy.createAction })).not.toBeDisabled();
  });

  test('is not a gate once a provider holds a key: the check is what stops Create goal, and it stays live', async () => {
    const view = open('/goals/new', { hostProviders: [{ name: 'anthropic', hasKey: true }] });
    const page = await filledPage(view, copy.title, 'assistant');
    await chooseAgent(page, 'tool-runner');
    await fireEvent.input(page.getByLabelText(copy.promptLabel), {
      target: { value: 'Summarize open refunds.' },
    });
    expect(page.queryByTestId('goal-needs-provider')).toBeNull();

    await fireEvent.click(page.getByRole('button', { name: copy.createAction }));

    const check = page.getByLabelText(copy.checkLabel);
    await waitFor(() => expect(document.activeElement === check).toBe(true));
    expect(page.getByText(copy.checkRequired)).not.toBeNull();
    expect(page.getByTestId('goal-form-note').textContent).toBe(copy.footer.check);
    expect(page.getByRole('button', { name: copy.createAction })).not.toBeDisabled();
    expect(stub?.callsTo('bureau.goals.create')).toEqual([]);
  });
});

describe('a goal being created', () => {
  async function fill(page: ReturnType<typeof within>) {
    await fireEvent.input(page.getByLabelText(copy.promptLabel), {
      target: { value: 'Say hello.' },
    });
    await fireEvent.input(page.getByLabelText(copy.checkLabel), {
      target: { value: 'Reply says hello' },
    });
  }

  test('says Creating: the button, the note, Cancel off and the fields read-only, then lands on the new goal', async () => {
    const answer = deferred<unknown>();
    const view = open('/goals/new', {
      create: () => answer.promise,
      hostProviders: [{ name: 'anthropic', hasKey: true }],
    });
    const page = await filledPage(view, copy.title, 'assistant');
    await fill(page);

    await fireEvent.click(page.getByRole('button', { name: copy.createAction }));

    await page.findByRole('button', { name: copy.creatingAction });
    expect(page.getByTestId('goal-form-note').textContent).toBe(copy.footer.creating);
    expect(page.getByRole('link', { name: copy.cancelAction }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect((page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement).readOnly).toBe(true);
    expect((page.getByLabelText(copy.checkLabel) as HTMLInputElement).readOnly).toBe(true);
    // A second press while the first is in flight sends nothing.
    await fireEvent.click(page.getByRole('button', { name: copy.creatingAction }));
    expect(stub?.callsTo('bureau.goals.create')).toHaveLength(1);

    const made = goalFixture('goal-created-1', { status: 'pending', revision: 1 });
    answer.resolve({
      outcome: 'created',
      goal: made,
      controller: { status: 'started', reason: null },
    });
    await waitFor(() => expect(router.pathname).toBe('/goals/goal-created-1'));
  });

  test('says a failed create above the buttons, keeps everything typed, and Try again sends the same goal', async () => {
    let calls = 0;
    const view = open('/goals/new', {
      create: () => {
        calls += 1;
        if (calls === 1) throw new StubFault('Unavailable', 503, 'The answer was lost.');
        const made = goalFixture('goal-created-1', { status: 'pending', revision: 1 });
        return { outcome: 'created', goal: made, controller: { status: 'started', reason: null } };
      },
    });
    const page = await filledPage(view, copy.title, 'assistant');
    await fill(page);

    await fireEvent.click(page.getByRole('button', { name: copy.createAction }));

    const fault = await page.findByTestId('goal-fault');
    expect(fault.textContent).toContain(copy.failedTitle);
    expect(fault.textContent).toContain(copy.unreachable);
    expect(fault.textContent).toContain(copy.kept);
    expect(page.getByRole('button', { name: copy.createAction })).not.toBeDisabled();
    expect((page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement).value).toBe('Say hello.');
    expect((page.getByLabelText(copy.checkLabel) as HTMLInputElement).value).toBe(
      'Reply says hello',
    );

    await fireEvent.click(page.getByRole('button', { name: copy.tryAgain }));

    await waitFor(() => expect(router.pathname).toBe('/goals/goal-created-1'));
    const keys = stub?.callsTo('bureau.goals.create').map((call) => call.params['idempotencyKey']);
    expect(keys).toHaveLength(2);
    expect(keys?.[0]).toBe(keys?.[1]);
  });
});
