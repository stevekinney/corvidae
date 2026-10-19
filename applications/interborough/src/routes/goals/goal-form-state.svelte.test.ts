import { describe, expect, test } from 'bun:test';

import { GoalFormState } from './goal-form-state.svelte.ts';

function filled(): GoalFormState {
  const form = new GoalFormState();
  form.agentName = ' assistant ';
  form.prompt = 'Say hello.';
  form.identityName = 'say-hello';
  form.identityVersion = '1';
  form.validatorName = 'never-passes';
  form.validatorVersion = '1';
  return form;
}

describe('the goal draft', () => {
  test('is not valid until every field has something', () => {
    const form = new GoalFormState();
    expect(form.isValid).toBe(false);
    expect(filled().isValid).toBe(true);
    for (const field of [
      'agentName',
      'prompt',
      'identityName',
      'identityVersion',
      'validatorName',
      'validatorVersion',
    ] as const) {
      const blank = filled();
      blank[field] = '   ';
      expect(blank.isValid, field).toBe(false);
    }
  });

  test('takes attempts and steps as whole numbers of one or more, with a default for each', () => {
    const form = filled();
    expect([form.maximumAttempts, form.maximumTotalSteps]).toEqual(['3', '50']);
    for (const bad of ['0', '-1', '1.5', 'many', '', ' ']) {
      form.maximumAttempts = bad;
      expect(form.attemptsValid, bad).toBe(false);
      form.maximumAttempts = '3';
      form.maximumTotalSteps = bad;
      expect(form.stepsValid, bad).toBe(false);
      form.maximumTotalSteps = '50';
    }
  });

  test('is sent trimmed, with the validator named exactly and the bounds as numbers', () => {
    const form = filled();
    form.maximumAttempts = ' 4 ';
    form.maximumTotalSteps = '20';
    expect(form.toInput()).toEqual({
      agentName: 'assistant',
      prompt: 'Say hello.',
      identity: { name: 'say-hello', version: '1' },
      validator: { name: 'never-passes', version: '1' },
      maximumAttempts: 4,
      maximumTotalSteps: 20,
    });
  });
});
