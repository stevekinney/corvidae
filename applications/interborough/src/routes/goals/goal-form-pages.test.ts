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

import { GOALS_COPY } from '../../app/copy/goals.ts';
import { RETRY_LABEL } from '../../app/copy/views.ts';
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
import { chooseOption, listboxTrigger, shownChoice } from '../chat/listbox.test-support.ts';
import { landAt } from '../chat/pages.test-support.ts';
import { GOAL_FIELD_IDS } from './goal-form-state.svelte.ts';

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

/** The check the goal under test holds, as the picker words it, and the phrase it was configured with. */
const CHECK_LABEL = 'Contains phrase';
const CHECK_PHRASE = 'waiting for approval';
const CHECK_ID = GOAL_FIELD_IDS.check;

/** The checks the Bureau lists: one that takes a phrase, one that takes no settings. */
const VALIDATORS = [
  {
    name: 'contains-phrase',
    version: '1',
    determinism: 'deterministic',
    configuration: {
      type: 'object',
      properties: { phrase: { type: 'string', minLength: 1, title: 'Phrase' } },
      required: ['phrase'],
    },
    source: { kind: 'bureau', name: 'bureau', version: '1.0.0' },
  },
  {
    name: 'accepts-any-answer',
    version: '1',
    determinism: 'deterministic',
    configuration: null,
    source: { kind: 'bureau', name: 'bureau', version: '1.0.0' },
  },
];

/** The goal Edit and Start again open: Tool runner, asked to summarize refunds, 5 attempts at most. */
const SUMMARIZE = goalFixture('goal-summarize', {
  agentName: 'tool-runner',
  identity: { name: 'Summarize open refunds', version: '1' },
  validator: { name: 'contains-phrase', version: '1' },
  validatorConfiguration: { phrase: CHECK_PHRASE },
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

const ASKED = 'Summarize open refunds.\nSay why each one is still waiting.';

/** The same goal read by its owner (COR-2425): `bureau.goals.get` carries its prompt. */
const ASKED_GOAL = goalFixture('goal-asked', {
  ...SUMMARIZE,
  goalRunId: 'goal-asked',
  prompt: ASKED,
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
  hostProviders?: readonly { name: string; hasKey: boolean; connected?: boolean }[];
  /** The checks the Bureau lists, which are {@link VALIDATORS} unless said. */
  validators?: readonly Record<string, unknown>[];
  /** A custom checks query, used to exercise recovery without replacing the draft. */
  listValidators?: BureauHandler;
};

function open(path: string, options: Options = {}) {
  const goals = [SUMMARIZE, ASKED_GOAL];
  stub = installBureauStub(
    {
      'bureau.agents.list': () => ({ agents: AGENTS }),
      'bureau.validators.list':
        options.listValidators ?? (() => ({ validators: options.validators ?? VALIDATORS })),
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

/**
 * The page once the goal, the agents and the checks have filled it: its agent field shows `agent`
 * and its check picker shows `check`, which is empty while the Bureau lists none.
 */
async function filledPage(view: View, heading: string, agent: string, check = CHECK_LABEL) {
  await view.findByRole('heading', { level: 1, name: heading });
  const page = within(view.container);
  const select = (await page.findByLabelText(copy.agentLabel)) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe(agent));
  // An empty `check` is a picker with nothing chosen, which shows its placeholder and no value.
  if (check !== '') {
    await waitFor(() => expect(shownChoice(view.container, CHECK_ID) === check).toBe(true));
  }
  // The picker stays off until the Bureau has listed its checks.
  await waitFor(() =>
    expect(listboxTrigger(view.container, CHECK_ID).hasAttribute('disabled')).toBe(false),
  );
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
    // A goal read without its prompt (not its owner's read) leaves the field empty and says what that means.
    const prompt = page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement;
    expect(prompt.value).toBe('');
    expect(prompt.getAttribute('placeholder')).toBe(
      copy.edit.promptPlaceholder('Summarize open refunds'),
    );
    expect(page.getByText(copy.edit.agentLocked)).not.toBeNull();
    // The goal's own check is chosen, and its settings hold what the goal was configured with.
    expect(shownChoice(view.container, CHECK_ID)).toBe(CHECK_LABEL);
    expect((page.getByLabelText('Phrase') as HTMLInputElement).value).toBe(CHECK_PHRASE);
    expect((page.getByLabelText(copy.maximumAttemptsLabel) as HTMLInputElement).value).toBe('5');
    // The limit is Cinder's NumberInput with a floor of one attempt (row S25).
    const limit = page.getByLabelText(copy.maximumAttemptsLabel) as HTMLInputElement;
    expect(limit.getAttribute('role')).toBe('spinbutton');
    expect(limit.getAttribute('aria-valuemin')).toBe('1');
    expect(page.getByTestId('goal-form-note').textContent).toBe(copy.edit.footer);
    expect(page.getByRole('button', { name: copy.edit.saveAction })).not.toBeDisabled();
    expect(page.getByRole('link', { name: copy.cancelAction }).getAttribute('href')).toBe(
      '/goals/goal-summarize',
    );
    expect(page.queryByRole('button', { name: copy.createAction })).toBeNull();
  });

  test('gates nothing on a provider, because saving starts no attempt', async () => {
    const view = open('/goals/goal-summarize/edit', {
      hostProviders: [{ name: 'anthropic', hasKey: false, connected: false }],
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
    await chooseOption(view.container, 'Accepts any answer, version 1', CHECK_ID);
    await setAttemptLimit(page, '8');

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.goals.update').length).toBe(1));
    // The agent is not named while it is the one the form opened with. A check with no settings is
    // sent none.
    expect(stub?.callsTo('bureau.goals.update')[0]?.params).toEqual({
      goalRunId: 'goal-summarize',
      expectedRevision: 4,
      prompt: 'Summarize open refunds, and say why each one waits.',
      validator: { name: 'accepts-any-answer', version: '1' },
      maximumAttempts: 8,
    });
    await waitFor(() => expect(router.pathname).toBe('/goals/goal-summarize'));
  });

  test('names the validator, with its name and version, when only its settings changed', async () => {
    const view = open('/goals/goal-summarize/edit');
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    await fireEvent.input(page.getByLabelText('Phrase'), { target: { value: 'the reason' } });

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.goals.update').length).toBe(1));
    expect(stub?.callsTo('bureau.goals.update')[0]?.params).toEqual({
      goalRunId: 'goal-summarize',
      expectedRevision: 4,
      validator: { name: 'contains-phrase', version: '1', configuration: { phrase: 'the reason' } },
    });
  });

  test('keeps the goal’s own check, with its settings, when the Bureau no longer lists it', async () => {
    const view = open('/goals/goal-summarize/edit', { validators: [VALIDATORS[1]!] });
    // The goal's own check reads as its page reads it, with the settings the goal holds.
    const page = await filledPage(
      view,
      copy.edit.title,
      'tool-runner',
      `Contains phrase "${CHECK_PHRASE}"`,
    );

    expect(page.getByText(copy.checkUnlisted)).not.toBeNull();
    expect(copy.checkUnlisted).toBe(
      'Not installed any more. The goal keeps this check until you choose another.',
    );
    expect(listboxTrigger(view.container, CHECK_ID).textContent).toContain(
      copy.checkVersionNotInstalled('1'),
    );
    // What the goal keeps is shown, read-only, where the settings would be: no field to change it.
    const stored = within(view.getByTestId('goal-check-stored-settings'));
    expect(stored.getByText('phrase')).not.toBeNull();
    expect(stored.getByText(CHECK_PHRASE)).not.toBeNull();
    expect(page.queryByLabelText('Phrase')).toBeNull();
    // Nothing changed, so nothing is sent, and the validator is not cleared.
    await setAttemptLimit(page, '6');
    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.goals.update').length).toBe(1));
    expect(stub?.callsTo('bureau.goals.update')[0]?.params).toEqual({
      goalRunId: 'goal-summarize',
      expectedRevision: 4,
      maximumAttempts: 6,
    });
  });

  test('shows the field of the settings the Bureau refused, at the field', async () => {
    const view = open('/goals/goal-summarize/edit', {
      update: () => {
        throw new StubFault('InvalidParams', 400, 'The configuration is refused: phrase', {
          issues: [
            {
              path: ['validator', 'configuration', 'phrase'],
              message: 'Too short',
              code: 'custom',
            },
          ],
        });
      },
    });
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    await fireEvent.input(page.getByLabelText('Phrase'), { target: { value: 'x' } });

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    await page.findByText('Too short');
    expect((page.getByLabelText('Phrase') as HTMLInputElement).value).toBe('x');
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
    expect(listboxTrigger(view.container, CHECK_ID).getAttribute('aria-readonly')).toBe('true');

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

describe('the Edit goal page on a goal read by its owner (COR-2425, row 68o)', () => {
  test('opens with the goal’s prompt in the field, which is required, and sends nothing for a save that changed nothing', async () => {
    const view = open('/goals/goal-asked/edit');
    const page = await filledPage(view, copy.edit.title, 'tool-runner');

    const prompt = page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement;
    expect(prompt.value).toBe(ASKED);
    expect(prompt.getAttribute('placeholder')).toBeNull();

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    await waitFor(() => expect(router.pathname).toBe('/goals/goal-asked'));
    expect(stub?.callsTo('bureau.goals.update')).toEqual([]);
  });

  test('says an emptied prompt is a problem and sends nothing, where a goal read without one keeps its prompt', async () => {
    const view = open('/goals/goal-asked/edit');
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    await fireEvent.input(page.getByLabelText(copy.promptLabel), { target: { value: '   ' } });

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    await waitFor(() => expect(page.getByText(copy.promptRequired)).not.toBeNull());
    expect(stub?.callsTo('bureau.goals.update')).toEqual([]);
    expect(router.pathname).toBe('/goals/goal-asked/edit');
  });

  test('names the prompt only when it changed, and the agent when another is chosen', async () => {
    const view = open('/goals/goal-asked/edit');
    const page = await filledPage(view, copy.edit.title, 'tool-runner');
    await fireEvent.input(page.getByLabelText(copy.promptLabel), {
      target: { value: `${ASKED}\nKeep it to five lines.` },
    });
    await chooseAgent(page, 'assistant');

    await fireEvent.click(page.getByRole('button', { name: copy.edit.saveAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.goals.update').length).toBe(1));
    expect(stub?.callsTo('bureau.goals.update')[0]?.params).toEqual({
      goalRunId: 'goal-asked',
      expectedRevision: 4,
      prompt: `${ASKED}\nKeep it to five lines.`,
      agentName: 'assistant',
    });
  });
});

describe('Start again', () => {
  test('opens New goal with the prompt the goal was asked, not only its name (COR-2425, row 67n)', async () => {
    const view = open('/goals/new?from=goal-asked', {
      hostProviders: [{ name: 'anthropic', hasKey: true, connected: true }],
    });
    const page = await filledPage(view, copy.title, 'tool-runner');

    expect((page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement).value).toBe(ASKED);

    await fireEvent.click(page.getByRole('button', { name: copy.createAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.goals.create').length).toBe(1));
    expect(stub?.callsTo('bureau.goals.create')[0]?.params).toMatchObject({
      prompt: ASKED,
      identity: { name: 'Summarize open refunds.', version: '1' },
    });
  });

  test('opens New goal with the goal’s agent, check and attempt limit, and its name as the prompt', async () => {
    const view = open('/goals/new?from=goal-summarize', {
      hostProviders: [{ name: 'anthropic', hasKey: true, connected: true }],
    });
    const page = await filledPage(view, copy.title, 'tool-runner');

    expect((page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement).value).toBe(
      'Summarize open refunds',
    );
    expect(shownChoice(view.container, CHECK_ID)).toBe(CHECK_LABEL);
    expect((page.getByLabelText('Phrase') as HTMLInputElement).value).toBe(CHECK_PHRASE);
    expect((page.getByLabelText(copy.maximumAttemptsLabel) as HTMLInputElement).value).toBe('5');
    expect(page.queryByTestId('goal-needs-provider')).toBeNull();

    await fireEvent.click(page.getByRole('button', { name: copy.createAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.goals.create').length).toBe(1));
    expect(stub?.callsTo('bureau.goals.create')[0]?.params).toEqual({
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9._-]{1,64}$/),
      agentName: 'tool-runner',
      prompt: 'Summarize open refunds',
      identity: { name: 'Summarize open refunds', version: '1' },
      // The check is the goal's own, so its validator is named exactly as the goal holds it,
      // with the configuration it was given.
      validator: { name: 'contains-phrase', version: '1', configuration: { phrase: CHECK_PHRASE } },
      bounds: { maximumAttempts: 5, maximumTotalSteps: 50 },
    });
    await waitFor(() => expect(router.pathname).toBe('/goals/goal-created-1'));
  });

  test('opens the form as New goal does when the goal cannot be read', async () => {
    const view = open('/goals/new?from=missing');
    // The form starts with the first check the Bureau lists.
    const page = await filledPage(view, copy.title, 'assistant');
    expect((page.getByLabelText(copy.promptLabel) as HTMLTextAreaElement).value).toBe('');
    expect(shownChoice(view.container, CHECK_ID)).toBe(CHECK_LABEL);
  });
});

describe('a failed checks catalog', () => {
  test('retries its query without discarding the new goal draft', async () => {
    let reads = 0;
    const view = open('/goals/new', {
      listValidators: () => {
        reads += 1;
        if (reads === 1) throw new StubFault('EngineFailure', 500, 'It broke.');
        return { validators: VALIDATORS };
      },
    });

    const page = within(view.container);
    const prompt = (await page.findByLabelText(copy.promptLabel)) as HTMLTextAreaElement;
    await fireEvent.input(prompt, { target: { value: 'Keep this draft.' } });
    const check = page.getByRole('combobox', { name: copy.checkLabel });
    const recovery = await page.findByRole('heading', { level: 2, name: copy.checkLabel });
    expect(check.compareDocumentPosition(recovery) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(page.getAllByText(copy.checkUnavailableDescription)).toHaveLength(1);

    await fireEvent.click(page.getByRole('button', { name: RETRY_LABEL }));

    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(shownChoice(view.container, CHECK_ID)).toBe(CHECK_LABEL));
    expect(prompt.value).toBe('Keep this draft.');
  });
});

describe('a model agent chosen with only a keyless provider (COR-2414)', () => {
  test('is gated by nothing: a keyless provider is connected with no key saved', async () => {
    const view = open('/goals/new', {
      hostProviders: [{ name: 'ollama', hasKey: false, connected: true }],
    });
    const page = await filledPage(view, copy.title, 'assistant');

    await chooseAgent(page, 'tool-runner');

    expect(page.queryByTestId('goal-needs-provider')).toBeNull();
    expect(page.getByRole('button', { name: copy.createAction })).not.toBeDisabled();
  });
});

describe('a model agent chosen with no provider connected', () => {
  test('says so above the first field, turns Create goal off, and goes away when Assistant is chosen', async () => {
    const view = open('/goals/new', {
      hostProviders: [{ name: 'anthropic', hasKey: false, connected: false }],
    });
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
    // The Bureau lists no check, so the picker has nothing to offer and the form says so.
    const view = open('/goals/new', {
      hostProviders: [{ name: 'anthropic', hasKey: true, connected: true }],
      validators: [],
    });
    const page = await filledPage(view, copy.title, 'assistant', '');
    await chooseAgent(page, 'tool-runner');
    await fireEvent.input(page.getByLabelText(copy.promptLabel), {
      target: { value: 'Summarize open refunds.' },
    });
    expect(page.queryByTestId('goal-needs-provider')).toBeNull();

    await fireEvent.click(page.getByRole('button', { name: copy.createAction }));

    const check = listboxTrigger(view.container, CHECK_ID);
    await waitFor(() => expect(document.activeElement === check).toBe(true));
    expect(page.getByText(copy.noChecks)).not.toBeNull();
    expect(page.getByTestId('goal-form-note').textContent).toBe(copy.footer.check);
    expect(page.getByRole('button', { name: copy.createAction })).not.toBeDisabled();
    expect(stub?.callsTo('bureau.goals.create')).toEqual([]);
  });
});

describe('a goal being created', () => {
  /** The prompt, and the phrase the first check the Bureau lists takes. */
  async function fill(page: ReturnType<typeof within>) {
    await fireEvent.input(page.getByLabelText(copy.promptLabel), {
      target: { value: 'Say hello.' },
    });
    await fireEvent.input(page.getByLabelText('Phrase'), { target: { value: 'hello' } });
  }

  test('says Creating: the button, the note, Cancel off and the fields read-only, then lands on the new goal', async () => {
    const answer = deferred<unknown>();
    const view = open('/goals/new', {
      create: () => answer.promise,
      hostProviders: [{ name: 'anthropic', hasKey: true, connected: true }],
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
    expect(listboxTrigger(view.container, CHECK_ID).getAttribute('aria-readonly')).toBe('true');
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
    expect(shownChoice(view.container, CHECK_ID)).toBe(CHECK_LABEL);
    expect((page.getByLabelText('Phrase') as HTMLInputElement).value).toBe('hello');

    await fireEvent.click(page.getByRole('button', { name: copy.tryAgain }));

    await waitFor(() => expect(router.pathname).toBe('/goals/goal-created-1'));
    const keys = stub?.callsTo('bureau.goals.create').map((call) => call.params['idempotencyKey']);
    expect(keys).toHaveLength(2);
    expect(keys?.[0]).toBe(keys?.[1]);
  });
});
