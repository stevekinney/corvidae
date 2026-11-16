/**
 * What the run page says of an instance of a workflow file (COR-2424, rows 54l, 54y, 14t, 55b, 55d):
 * how far it got and which step failed, from the history the Bureau keeps and the steps of the
 * version the run ran.
 */
import { describe, expect, test } from 'bun:test';

import type { WorkflowRunHistoryEvent } from '../../../lib/workflow-files.ts';
import {
  canonicalSteps,
  failureHeading,
  instanceEntries,
  instanceProgress,
  instanceStepName,
  progressPhrase,
  stepReached,
  triesAtStep,
  versionStanding,
} from './run-instance.ts';

const START = Date.parse('2026-10-30T11:00:00.000Z');

function event(type: string, step: number | null, secondsIn: number): WorkflowRunHistoryEvent {
  return {
    type: `file-workflow:${type}`,
    timestamp: new Date(START + secondsIn * 1000).toISOString(),
    step: step === null ? null : String(step),
    summary: '',
  };
}

/** Release notes 1.2.0: four steps, the second named by its title. */
const STEPS = [
  { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Find the release' } },
  { kind: 'activity', handler: 'agent', title: 'Collect merged changes', input: {} },
  { kind: 'await-signal', signal: 'notes-approved' },
  { kind: 'sleep', duration: '1h' },
];

/** Step 1 ran; step 2 was started twice and then failed. */
const FAILED_AT_TWO = [
  event('step-started', 0, 0),
  event('activity-started', 0, 0),
  event('activity-completed', 0, 1),
  event('step-completed', 0, 1),
  event('step-started', 1, 1),
  event('activity-started', 1, 1),
  event('activity-started', 1, 2),
  event('run-terminal', null, 3),
];

describe('how far an instance got', () => {
  test('is the step its history last started, counted from one', () => {
    expect(stepReached(FAILED_AT_TWO)).toBe(2);
    expect(stepReached([])).toBeNull();
    expect(stepReached([event('run-terminal', null, 1)])).toBeNull();
  });

  test('reads a step the history names by anything but a whole index as no step', () => {
    expect(stepReached([{ ...event('step-started', 0, 0), step: 'two' }])).toBeNull();
    expect(stepReached([{ ...event('step-started', 0, 0), step: '-1' }])).toBeNull();
  });

  test('counts each start of the step’s activity as one try', () => {
    expect(triesAtStep(FAILED_AT_TWO, 1)).toBe(1);
    expect(triesAtStep(FAILED_AT_TWO, 2)).toBe(2);
    expect(triesAtStep(FAILED_AT_TWO, 3)).toBe(0);
  });

  test('names the step by its title, else by what it does', () => {
    expect(instanceStepName(STEPS, 2)).toBe('Collect merged changes');
    expect(instanceStepName(STEPS, 3)).toBe('Wait for the signal notes-approved');
    expect(instanceStepName(STEPS, 9)).toBeUndefined();
  });

  test('has the step, how many steps the version has, its name and its tries', () => {
    expect(instanceProgress(FAILED_AT_TWO, STEPS)).toEqual({
      at: 2,
      total: 4,
      name: 'Collect merged changes',
      tries: 2,
    });
    // Without the steps of the version it ran, the page knows the step and not the rest.
    expect(instanceProgress(FAILED_AT_TWO, undefined)).toEqual({
      at: 2,
      total: null,
      name: undefined,
      tries: 2,
    });
  });
});

describe('the steps in the order the engine counts them', () => {
  const NESTED = [
    { kind: 'activity', title: 'First' },
    {
      kind: 'branch',
      title: 'Choose',
      cases: { b: [{ title: 'B one' }, { title: 'B two' }], a: [{ title: 'A one' }] },
      otherwise: [{ title: 'Otherwise one' }],
    },
    {
      kind: 'parallel',
      title: 'Fan out',
      branches: { right: [{ title: 'Right' }], left: [{ title: 'Left' }] },
    },
    { kind: 'map', title: 'Each', steps: [{ title: 'Inside' }] },
    { kind: 'sleep', title: 'Last' },
  ];

  test('walk a branch’s cases in sorted order, then otherwise, and a parallel’s branches in sorted order', () => {
    expect(canonicalSteps(NESTED).map((step) => step['title'])).toEqual([
      'First',
      'Choose',
      'A one',
      'B one',
      'B two',
      'Otherwise one',
      'Fan out',
      'Left',
      'Right',
      'Each',
      'Inside',
      'Last',
    ]);
  });

  test('name and count a nested step the way the Bureau counts it, so "step 7 of 12" is the same step', () => {
    expect(instanceStepName(NESTED, 3)).toBe('A one');
    expect(instanceStepName(NESTED, 12)).toBe('Last');
    expect(instanceProgress([event('step-started', 5, 0)], NESTED)).toMatchObject({
      at: 6,
      total: 12,
      name: 'Otherwise one',
    });
  });
});

describe('the words of the status line and the failure', () => {
  test('say "at step 2 of 4" for a failed run and "step 2 of 4" for one going on (rows 54y, 54l)', () => {
    const progress = instanceProgress(FAILED_AT_TWO, STEPS);
    expect(progressPhrase(progress, true)).toBe('at step 2 of 4');
    expect(progressPhrase(progress, false)).toBe('step 2 of 4');
  });

  test('say nothing of the step count when the version’s steps are not known', () => {
    expect(progressPhrase(instanceProgress(FAILED_AT_TWO, undefined), true)).toBeUndefined();
  });

  test('head the failure with the step, its name and how many times it was tried (row 14t)', () => {
    expect(failureHeading(instanceProgress(FAILED_AT_TWO, STEPS))).toBe(
      'Step 2, Collect merged changes, failed after 2 tries',
    );
    // One try is not "after 1 tries", and a step with no name is still the step.
    expect(failureHeading({ at: 3, total: 4, name: undefined, tries: 1 })).toBe('Step 3, failed');
    expect(failureHeading({ at: null, total: 4, name: undefined, tries: 0 })).toBeUndefined();
  });
});

describe('what happened in an instance', () => {
  test('lists each step it began with how long after the start, the last failed when the run did', () => {
    const entries = instanceEntries({
      events: FAILED_AT_TWO,
      steps: STEPS,
      startedAt: START,
      status: 'failed',
    });
    expect(entries).toEqual([
      {
        key: 'step-1',
        title: 'Step 1, Ask the agent writer: Find the release',
        offsetMilliseconds: 0,
        state: 'done',
      },
      {
        key: 'step-2',
        title: 'Step 2, Collect merged changes',
        offsetMilliseconds: 1000,
        state: 'failed',
      },
    ]);
  });

  test('marks the last step as the one going on while the run goes on, and none failed once it is over', () => {
    const running = instanceEntries({
      events: FAILED_AT_TWO,
      steps: STEPS,
      startedAt: START,
      status: 'running',
    });
    expect(running.map((entry) => entry.state)).toEqual(['done', 'current']);
    const over = instanceEntries({
      events: FAILED_AT_TWO,
      steps: STEPS,
      startedAt: START,
      status: 'over',
    });
    expect(over.map((entry) => entry.state)).toEqual(['done', 'done']);
  });

  test('lists a step once, however many times its start is told', () => {
    const entries = instanceEntries({
      events: [event('step-started', 0, 0), event('step-started', 0, 1)],
      steps: undefined,
      startedAt: START,
      status: 'running',
    });
    expect(entries.map((entry) => entry.title)).toEqual(['Step 1']);
  });
});

describe('the version a run ran', () => {
  test('is current when it is the workflow’s current one, and older when it is not (row 55d)', () => {
    expect(versionStanding('1.3.0', '1.3.0')).toEqual({
      state: 'current',
      ran: '1.3.0',
      current: '1.3.0',
    });
    expect(versionStanding('1.2.0', '1.3.0')).toEqual({
      state: 'older',
      ran: '1.2.0',
      current: '1.3.0',
    });
  });

  test('is not told apart from the current one when the workflow has none', () => {
    expect(versionStanding('1.2.0', null).state).toBe('unknown');
    expect(versionStanding('1.2.0', '').state).toBe('unknown');
  });
});
