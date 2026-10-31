/**
 * The records pages' one status vocabulary (`status.ts`): seven words, each with one tone, and every
 * state the Bureau has for a task, a goal or a workflow reads as one of them.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { GOAL_STATUSES } from './bureau-goals.ts';
import type { TaskState } from './bureau-tasks.ts';
import StatusLabel from './status-label.svelte';
import {
  goalStatusWord,
  STATUS_BADGE_VARIANTS,
  STATUS_TONES,
  STATUS_WORDS,
  taskStatusWord,
  workflowStatusWord,
  type StatusWord,
} from './status.ts';

const TONES: readonly (readonly [StatusWord, string])[] = [
  ['Running', 'accent'],
  ['Waiting on you', 'warning'],
  ['Done', 'success'],
  ['Failed', 'danger'],
  ['Canceled', 'neutral'],
  ['Scheduled', 'pending'],
  ['Paused', 'offline'],
];

describe('the status vocabulary', () => {
  test('is seven words, each with one tone and one badge variant', () => {
    expect([...STATUS_WORDS]).toEqual(TONES.map(([word]) => word));
    expect(Object.keys(STATUS_TONES).toSorted()).toEqual([...STATUS_WORDS].toSorted());
    expect(Object.keys(STATUS_BADGE_VARIANTS).toSorted()).toEqual([...STATUS_WORDS].toSorted());
  });

  test.each(TONES)('%s renders a StatusDot of the %s tone, and names itself', (word, tone) => {
    const view = render(StatusLabel, { props: { word } });
    const dot = view.container.querySelector('[data-cinder-status]');
    expect(dot?.getAttribute('data-cinder-status')).toBe(tone);
    expect(view.getByText(word)).toBeTruthy();
    expect(STATUS_TONES[word]).toBe(tone as never);
    view.unmount();
  });
});

describe('the words the Bureau’s states read as', () => {
  test('a task state', () => {
    const words: Record<TaskState, StatusWord> = {
      submitted: 'Running',
      working: 'Running',
      'input-required': 'Waiting on you',
      completed: 'Done',
      failed: 'Failed',
      canceled: 'Canceled',
    };
    for (const [state, word] of Object.entries(words)) {
      expect(taskStatusWord(state as TaskState)).toBe(word);
    }
  });

  test('every goal status is one of the seven words, and a goal out of attempts has Failed', () => {
    for (const status of GOAL_STATUSES) expect(STATUS_WORDS).toContain(goalStatusWord(status));
    expect(goalStatusWord('pending')).toBe('Scheduled');
    expect(goalStatusWord('retrying')).toBe('Running');
    expect(goalStatusWord('exhausted')).toBe('Failed');
    expect(goalStatusWord('succeeded')).toBe('Done');
    expect(goalStatusWord('canceled')).toBe('Canceled');
  });

  test('a workflow is Failed before Paused before Running before Scheduled, and else has none', () => {
    const base = { invalid: false, failed: false, paused: false, running: 0, started: false };
    expect(workflowStatusWord({ ...base, invalid: true, paused: true })).toBe('Failed');
    expect(workflowStatusWord({ ...base, failed: true })).toBe('Failed');
    expect(workflowStatusWord({ ...base, paused: true, running: 2 })).toBe('Paused');
    expect(workflowStatusWord({ ...base, running: 1, started: true })).toBe('Running');
    expect(workflowStatusWord({ ...base, started: true })).toBe('Scheduled');
    expect(workflowStatusWord(base)).toBeNull();
  });
});
