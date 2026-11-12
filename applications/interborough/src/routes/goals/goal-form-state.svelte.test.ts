/**
 * The draft behind New goal and Edit goal (COR-2017, rows 68b to 68s): what is wrong with each
 * field and when it is said, what `bureau.goals.create` and `bureau.goals.update` are sent, how the
 * check becomes a validator's name, and which agent a goal starts with and when it waits on a
 * provider.
 */
import { describe, expect, test } from 'bun:test';

import { GOALS_COPY } from '../../app/copy/goals.ts';
import { goalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  defaultAgentName,
  GoalFormState,
  goalNameOf,
  needsProvider,
  scriptedAgent,
  validatorNameOf,
} from './goal-form-state.svelte.ts';

const copy = GOALS_COPY.form;

function filled(): GoalFormState {
  const form = new GoalFormState();
  form.agentName = ' assistant ';
  form.prompt = 'Say hello.';
  form.check = 'Reply says hello';
  return form;
}

const MODEL = { modalities: {}, mimeFamilies: [], mediaLimits: [] };

/** A goal as Start again and Edit open it. */
const SUMMARIZE = goalFixture('goal-summarize', {
  agentName: 'tool-runner',
  identity: { name: 'Summarize open refunds', version: '1' },
  validator: { name: 'summary-lists-every-refund-waiting-for-approval', version: '7' },
  bounds: {
    maximumAttempts: 5,
    maximumTotalDurationMs: null,
    maximumTotalSteps: null,
    maximumTotalTokens: null,
    maximumTotalCostUsd: null,
  },
});

describe('the goal draft', () => {
  test('starts with an attempt limit of 5 and nothing else filled in', () => {
    const form = new GoalFormState();
    expect([form.prompt, form.check, form.agentName, form.maximumAttempts]).toEqual([
      '',
      '',
      '',
      5,
    ]);
    expect(form.isValid).toBe(false);
    expect(filled().isValid).toBe(true);
  });

  test('says nothing until a submit is tried, then says what is wrong at each field', () => {
    const form = new GoalFormState();
    expect(form.shownProblems).toEqual({});
    expect(form.problems).toEqual({
      prompt: copy.promptRequired,
      check: copy.checkRequired,
      agent: copy.agentPlaceholder,
    });

    // The first field down the page is the one to focus.
    expect(form.attempt()).toBe('prompt');
    expect(form.shownProblems).toEqual(form.problems);
    form.prompt = 'Say hello.';
    expect(form.attempt()).toBe('check');
    form.check = 'Reply says hello';
    expect(form.attempt()).toBe('agent');
    form.agentName = 'assistant';
    expect(form.attempt()).toBeUndefined();
    expect(form.shownProblems).toEqual({});
  });

  test('takes an attempt limit of 1 to 20 as a whole number, and nothing else', () => {
    const form = filled();
    for (const good of [1, 5, 20]) {
      form.maximumAttempts = good;
      expect(form.attemptsValid, String(good)).toBe(true);
    }
    for (const bad of [0, -1, 21, 30, 1.5, null]) {
      form.maximumAttempts = bad;
      expect(form.attemptsValid, String(bad)).toBe(false);
      expect(form.problems.attempts, String(bad)).toBe(copy.maximumAttemptsInvalid);
    }
    form.maximumAttempts = 30;
    expect(form.attempt()).toBe('attempts');
  });

  test('is sent trimmed: the first line names the goal, the check is a slug, and the steps are bounded', () => {
    const form = filled();
    form.prompt = '\n  Say hello.\nThen keep trying.  ';
    form.maximumAttempts = 4;
    expect(form.toInput()).toEqual({
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9._-]{1,64}$/),
      agentName: 'assistant',
      prompt: 'Say hello.\nThen keep trying.',
      identity: { name: 'Say hello.', version: '1' },
      validator: { name: 'reply-says-hello', version: '1' },
      maximumAttempts: 4,
      maximumTotalSteps: 50,
    });
  });

  test('keeps one key while the request is the same, and takes a new one as soon as it changes', () => {
    const form = filled();
    const first = form.toInput().idempotencyKey;

    // A retry of one submission is the same request, so it is the same goal.
    expect(form.toInput().idempotencyKey).toBe(first);
    expect(form.toInput().idempotencyKey).toBe(first);

    // The Bureau refuses a different request under a key it has seen, so a change is a new key.
    form.prompt = 'Say hello twice.';
    const second = form.toInput().idempotencyKey;
    expect(second).not.toBe(first);
    expect(form.toInput().idempotencyKey).toBe(second);
  });
});

describe('a check as a validator’s name', () => {
  test('is the statement lowercased with each run of other characters one hyphen', () => {
    expect(validatorNameOf('Reply says hello')).toBe('reply-says-hello');
    expect(validatorNameOf('  Notes mention the staging fix.  ')).toBe(
      'notes-mention-the-staging-fix',
    );
    expect(validatorNameOf('Summary lists every refund waiting for approval')).toBe(
      'summary-lists-every-refund-waiting-for-approval',
    );
  });

  test('is kept as it is when it is already a name', () => {
    expect(validatorNameOf('demo:never-passes')).toBe('demo:never-passes');
    expect(validatorNameOf('reply-says-hello')).toBe('reply-says-hello');
  });

  test('is the typed text when nothing of it can be a name', () => {
    expect(validatorNameOf('???')).toBe('???');
    expect(validatorNameOf('   ')).toBe('');
  });
});

describe('a goal’s name', () => {
  test('is the first line of its prompt that says something', () => {
    expect(goalNameOf('Summarize open refunds.\nList every one.')).toBe('Summarize open refunds.');
    expect(goalNameOf('\n\n   Say hello.  \r\nThen stop.')).toBe('Say hello.');
    expect(goalNameOf('   ')).toBe('');
  });
});

describe('the goal draft opened from a goal to start again', () => {
  test('takes the goal’s agent, check and attempt limit, and its name as the first line of the prompt', () => {
    const form = new GoalFormState('create');
    form.prefill(SUMMARIZE);
    expect([form.agentName, form.prompt, form.check, form.maximumAttempts]).toEqual([
      'tool-runner',
      'Summarize open refunds',
      'Summary lists every refund waiting for approval',
      5,
    ]);
    expect(form.isValid).toBe(true);
  });

  test('sends the goal’s own validator, version and all, while the check is as it was opened', () => {
    const form = new GoalFormState('create');
    form.prefill(SUMMARIZE);
    expect(form.toInput().validator).toEqual({
      name: 'summary-lists-every-refund-waiting-for-approval',
      version: '7',
    });

    form.check = 'Summary lists three refunds';
    expect(form.toInput().validator).toEqual({ name: 'summary-lists-three-refunds', version: '1' });
  });
});

describe('the goal draft opened for Edit', () => {
  function opened(): GoalFormState {
    const form = new GoalFormState('edit');
    form.prefill(SUMMARIZE);
    return form;
  }

  test('takes the goal’s agent, check and attempt limit, and leaves the prompt empty', () => {
    const form = opened();
    expect([form.agentName, form.prompt, form.check, form.maximumAttempts]).toEqual([
      'tool-runner',
      '',
      'Summary lists every refund waiting for approval',
      5,
    ]);
  });

  test('is valid with an empty prompt, which keeps the goal’s own', () => {
    const form = opened();
    expect(form.problems).toEqual({});
    expect(form.isValid).toBe(true);
  });

  test('names nothing when nothing changed, so a save sends nothing', () => {
    const form = opened();
    expect(form.toChange()).toEqual({});
    expect(form.changed).toBe(false);
  });

  test('names only what changed, and never the agent', () => {
    const prompt = opened();
    prompt.prompt = '  Summarize open refunds, and say why each waits.  ';
    expect(prompt.toChange()).toEqual({
      prompt: 'Summarize open refunds, and say why each waits.',
    });
    expect(prompt.changed).toBe(true);

    const check = opened();
    check.check = 'Summary lists every refund and the reason';
    expect(check.toChange()).toEqual({
      validator: { name: 'summary-lists-every-refund-and-the-reason', version: '1' },
    });

    const attempts = opened();
    attempts.maximumAttempts = 8;
    expect(attempts.toChange()).toEqual({ maximumAttempts: 8 });

    const agent = opened();
    agent.agentName = 'assistant';
    expect(agent.toChange()).toEqual({});
  });

  test('puts a check changed back to what it was back to the goal’s own validator, which is no change', () => {
    const form = opened();
    form.check = 'Something else';
    expect(form.changed).toBe(true);
    form.check = 'Summary lists every refund waiting for approval';
    expect(form.toChange()).toEqual({});
  });

  test('still needs a check and an attempt limit in range', () => {
    const form = opened();
    form.check = '  ';
    form.maximumAttempts = 21;
    expect(form.problems).toEqual({
      check: copy.checkRequired,
      attempts: copy.maximumAttemptsInvalid,
    });
    expect(form.attempt()).toBe('check');
  });
});

describe('the agent a goal starts with', () => {
  const ASSISTANT = { name: 'assistant', media: null };
  const DEMO_ASSISTANT = { name: 'demo:assistant', media: null };
  const ECHO = { name: 'echo', media: null };
  const TOOL_RUNNER = { name: 'tool-runner', media: MODEL };

  test('is Assistant, which is scripted, so nothing waits on a provider', () => {
    expect(defaultAgentName([TOOL_RUNNER, ECHO, ASSISTANT])).toBe('assistant');
    expect(defaultAgentName([TOOL_RUNNER, DEMO_ASSISTANT])).toBe('demo:assistant');
    expect(scriptedAgent([TOOL_RUNNER, ECHO, ASSISTANT])).toBe(ASSISTANT);
  });

  test('is the first scripted agent when there is no Assistant, and the first agent when none is scripted', () => {
    expect(defaultAgentName([TOOL_RUNNER, ECHO])).toBe('echo');
    expect(scriptedAgent([TOOL_RUNNER])).toBeUndefined();
    expect(defaultAgentName([TOOL_RUNNER])).toBe('tool-runner');
    expect(defaultAgentName([])).toBe('');
  });

  test('waits on a provider only for a model agent while the host says none holds a key', () => {
    const agents = [ASSISTANT, TOOL_RUNNER];
    expect(needsProvider(agents, 'tool-runner', false)).toBe(true);
    expect(needsProvider(agents, 'tool-runner', true)).toBe(false);
    expect(needsProvider(agents, 'tool-runner', undefined)).toBe(false);
    expect(needsProvider(agents, 'assistant', false)).toBe(false);
    expect(needsProvider(agents, 'missing', false)).toBe(false);
    expect(needsProvider(undefined, 'tool-runner', false)).toBe(false);
  });
});
