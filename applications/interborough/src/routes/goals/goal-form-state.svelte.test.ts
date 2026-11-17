/**
 * The draft behind New goal and Edit goal (COR-2017, rows 68b to 68s; COR-2124): what is wrong with
 * each field and when it is said, what `bureau.goals.create` and `bureau.goals.update` are sent, how
 * a check is chosen from the checks the Bureau lists and carries its configuration, and which agent
 * a goal starts with and when it waits on a provider.
 */
import { describe, expect, test } from 'bun:test';

import { GOALS_COPY } from '../../app/copy/goals.ts';
import { goalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import type { GoalValidator } from '../../lib/bureau-validators.ts';
import {
  checkKey,
  defaultAgentName,
  defaultCheckKey,
  GoalFormState,
  goalNameOf,
  needsProvider,
  parseCheckKey,
  scriptedAgent,
} from './goal-form-state.svelte.ts';

const copy = GOALS_COPY.form;

const SOURCE = { kind: 'bureau', name: 'bureau', version: '1.0.0' } as const;

/** A check that takes a phrase, as `bureau.validators.list` shows it. */
const CONTAINS_PHRASE: GoalValidator = {
  name: 'contains-phrase',
  version: '1',
  determinism: 'deterministic',
  configuration: {
    type: 'object',
    properties: { phrase: { type: 'string', minLength: 1 } },
    required: ['phrase'],
  },
  source: SOURCE,
};

/** A check that takes no configuration. */
const NEVER_PASSES: GoalValidator = {
  name: 'never-passes',
  version: '1',
  determinism: null,
  configuration: null,
  source: SOURCE,
};

function filled(): GoalFormState {
  const form = new GoalFormState();
  form.validators = [CONTAINS_PHRASE, NEVER_PASSES];
  form.agentName = ' assistant ';
  form.prompt = 'Say hello.';
  form.check = checkKey(CONTAINS_PHRASE);
  form.configuration = { phrase: 'hello' };
  return form;
}

const MODEL = { modalities: {}, mimeFamilies: [], mediaLimits: [] };

/** A goal as Start again and Edit open it. */
const SUMMARIZE = goalFixture('goal-summarize', {
  agentName: 'tool-runner',
  identity: { name: 'Summarize open refunds', version: '1' },
  validator: { name: 'contains-phrase', version: '1' },
  validatorConfiguration: { phrase: 'waiting for approval' },
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
    form.validators = [CONTAINS_PHRASE];
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
    form.check = checkKey(CONTAINS_PHRASE);
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

  test('is sent trimmed: the first line names the goal, the check is the row chosen, and the steps are bounded', () => {
    const form = filled();
    form.prompt = '\n  Say hello.\nThen keep trying.  ';
    form.maximumAttempts = 4;
    expect(form.toInput()).toEqual({
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9._-]{1,64}$/),
      agentName: 'assistant',
      prompt: 'Say hello.\nThen keep trying.',
      identity: { name: 'Say hello.', version: '1' },
      validator: { name: 'contains-phrase', version: '1', configuration: { phrase: 'hello' } },
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

    // A different configuration is a different request too.
    form.configuration = { phrase: 'goodbye' };
    expect(form.toInput().idempotencyKey).not.toBe(second);
  });
});

describe('the checks a goal may be given', () => {
  test('are the rows the Bureau lists, each chosen by its exact name and version', () => {
    const form = new GoalFormState();
    form.validators = [CONTAINS_PHRASE, NEVER_PASSES];

    expect(form.choices.map((choice) => [choice.key, choice.label, choice.listed])).toEqual([
      ['contains-phrase@1', 'Contains phrase', true],
      ['never-passes@1', 'Never passes', true],
    ]);
    expect(checkKey({ name: 'tests@bureau', version: '2.0.0' })).toBe('tests@bureau@2.0.0');
    expect(parseCheckKey('tests@bureau@2.0.0')).toEqual({ name: 'tests@bureau', version: '2.0.0' });
    expect(parseCheckKey('no-version')).toBeUndefined();
  });

  test('are grouped by where each comes from: built in, the plugin by name in words, the owner’s files', () => {
    const form = new GoalFormState();
    form.validators = [
      CONTAINS_PHRASE,
      {
        ...NEVER_PASSES,
        name: 'demo:never-passes',
        source: { kind: 'plugin', name: 'demo', version: '1.2.0' },
      },
      {
        ...NEVER_PASSES,
        name: 'staging-notes',
        version: 'abc',
        source: { kind: 'bungalow', name: 'bungalow', version: 'abc' },
      },
    ];

    expect(form.choices.map((choice) => [choice.label, choice.group])).toEqual([
      ['Contains phrase', 'Built in'],
      ['Never passes', 'Demo'],
      ['Staging notes', 'Your validator files'],
    ]);
  });

  test('start with the first the Bureau lists', () => {
    expect(defaultCheckKey([CONTAINS_PHRASE, NEVER_PASSES])).toBe('contains-phrase@1');
    expect(defaultCheckKey([])).toBe('');
  });

  test('block a submit, naming why, when the Bureau lists none', () => {
    const form = new GoalFormState();
    form.validators = [];
    form.prompt = 'Say hello.';
    form.agentName = 'assistant';
    expect(form.problems.check).toBe(copy.noChecks);
    expect(form.attempt()).toBe('check');
    expect(form.isValid).toBe(false);
  });

  test('send the configuration only for a check that takes one', () => {
    const form = filled();
    expect(form.toInput().validator).toEqual({
      name: 'contains-phrase',
      version: '1',
      configuration: { phrase: 'hello' },
    });

    // Another check starts its own form over, so what the first held is not sent with it.
    form.check = checkKey(NEVER_PASSES);
    expect(form.configuration).toBeUndefined();
    expect(form.toInput().validator).toEqual({ name: 'never-passes', version: '1' });
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
    form.validators = [CONTAINS_PHRASE, NEVER_PASSES];
    form.prefill(SUMMARIZE);
    expect([form.agentName, form.prompt, form.check, form.maximumAttempts]).toEqual([
      'tool-runner',
      'Summarize open refunds',
      'contains-phrase@1',
      5,
    ]);
    expect(form.configuration).toEqual({ phrase: 'waiting for approval' });
    expect(form.isValid).toBe(true);
  });

  test('sends the goal’s own validator, version and configuration, even when the Bureau no longer lists it', () => {
    const form = new GoalFormState('create');
    form.validators = [NEVER_PASSES];
    form.prefill(SUMMARIZE);

    expect(form.chosen).toMatchObject({
      key: 'contains-phrase@1',
      listed: false,
      // Read as the goal's own page reads it, with the settings it holds, and in no group.
      label: 'Contains phrase "waiting for approval"',
      group: undefined,
    });
    expect(form.storedSettings).toEqual([{ term: 'phrase', definition: 'waiting for approval' }]);
    expect(form.choices.map((choice) => choice.key)).toEqual([
      'never-passes@1',
      'contains-phrase@1',
    ]);
    expect(form.toInput().validator).toEqual({
      name: 'contains-phrase',
      version: '1',
      configuration: { phrase: 'waiting for approval' },
    });
    expect(form.isValid).toBe(true);
  });
});

describe('the goal draft opened for Edit', () => {
  function opened(): GoalFormState {
    const form = new GoalFormState('edit');
    form.validators = [CONTAINS_PHRASE, NEVER_PASSES];
    form.prefill(SUMMARIZE);
    return form;
  }

  test('takes the goal’s agent, check, configuration and attempt limit, and leaves the prompt empty', () => {
    const form = opened();
    expect([form.agentName, form.prompt, form.check, form.maximumAttempts]).toEqual([
      'tool-runner',
      '',
      'contains-phrase@1',
      5,
    ]);
    expect(form.configuration).toEqual({ phrase: 'waiting for approval' });
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
    check.check = checkKey(NEVER_PASSES);
    expect(check.toChange()).toEqual({ validator: { name: 'never-passes', version: '1' } });

    const attempts = opened();
    attempts.maximumAttempts = 8;
    expect(attempts.toChange()).toEqual({ maximumAttempts: 8 });

    const agent = opened();
    agent.agentName = 'assistant';
    expect(agent.toChange()).toEqual({});
  });

  test('names the validator, with its name and version, when only its configuration changed', () => {
    const form = opened();
    form.configuration = { phrase: 'the reason' };
    expect(form.toChange()).toEqual({
      validator: { name: 'contains-phrase', version: '1', configuration: { phrase: 'the reason' } },
    });
  });

  test('puts a check changed back to what it was back to the goal’s own, which is no change', () => {
    const form = opened();
    form.check = checkKey(NEVER_PASSES);
    expect(form.changed).toBe(true);
    form.check = checkKey(CONTAINS_PHRASE);
    expect(form.configuration).toEqual({ phrase: 'waiting for approval' });
    expect(form.toChange()).toEqual({});
  });

  test('reads a configuration in another key order as the same one', () => {
    const form = opened();
    form.configuration = { phrase: 'waiting for approval' };
    expect(form.changed).toBe(false);
  });

  test('sends nothing for a goal whose check the Bureau no longer lists, until it is changed', () => {
    const form = new GoalFormState('edit');
    form.validators = [NEVER_PASSES];
    form.prefill(SUMMARIZE);
    expect(form.toChange()).toEqual({});
    form.check = checkKey(NEVER_PASSES);
    expect(form.toChange()).toEqual({ validator: { name: 'never-passes', version: '1' } });
  });

  test('still needs a check and an attempt limit in range', () => {
    const form = opened();
    form.check = '';
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
