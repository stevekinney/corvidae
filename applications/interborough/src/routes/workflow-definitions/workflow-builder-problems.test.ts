/**
 * What Create workflow says is wrong with a new workflow's text, in the order the page reads: the
 * ID, what starts it, then each step. A step name is never a problem, text the builder cannot read
 * has none (the JSON tab says what is wrong with it), and the summary line begins at two problems.
 */
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import {
  FIRST_ADD_BUTTON,
  ID_FIELD,
  problemSummary,
  stepFieldId,
  workflowProblems,
} from './workflow-builder-problems.ts';

const copy = WORKFLOW_COPY.builder.problems;

/** A workflow text that has nothing left to fix. */
function valid(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'morning-briefing',
    trigger: { kind: 'manual' },
    steps: [
      { kind: 'activity', handler: 'agent', input: { agent: 'assistant', message: 'Say hello.' } },
    ],
    ...overrides,
  });
}

const create = { mode: 'create' } as const;

describe('workflowProblems', () => {
  test('finds nothing wrong with a workflow that is filled in', () => {
    expect(workflowProblems(valid(), create)).toEqual([]);
  });

  test('says the untouched form has an ID, an agent and a message to fix, in that order', () => {
    const untouched = JSON.stringify({
      name: '',
      trigger: { kind: 'manual' },
      steps: [{ kind: 'activity', handler: 'agent', input: { agent: '', message: '' } }],
    });
    const problems = workflowProblems(untouched, create);
    expect(problems.map((problem) => problem.kind)).toEqual(['id', 'agent', 'message']);
    expect(problems.map((problem) => problem.fieldId)).toEqual([
      ID_FIELD,
      stepFieldId(1, 'agent'),
      stepFieldId(1, 'message'),
    ]);
    expect(problems[0]?.message).toBe(WORKFLOW_COPY.creator.invalidName);
    expect(problems[1]?.message).toBe(copy.agent);
    expect(problems[2]?.message).toBe(copy.message);
  });

  test('checks the ID of a new workflow only: a missing name, one that is not an identifier, and the reserved one', () => {
    const reasons = [
      [
        JSON.stringify({ trigger: { kind: 'manual' }, steps: [{ kind: 'sleep', duration: '1m' }] }),
        WORKFLOW_COPY.creator.noName,
      ],
      [valid({ name: 'Bad_Name' }), WORKFLOW_COPY.creator.invalidName],
      [valid({ name: 7 }), WORKFLOW_COPY.creator.invalidName],
      [valid({ name: 'new' }), WORKFLOW_COPY.creator.reservedName],
    ] as const;
    for (const [text, message] of reasons) {
      const [first] = workflowProblems(text, create);
      expect(first?.kind).toBe('id');
      expect(first?.message).toBe(message);
    }
    expect(workflowProblems(valid({ name: 'Bad_Name' }), { mode: 'edit' })).toEqual([]);
  });

  test('says an ID the Bureau answered is taken only while the text still names it', () => {
    const [taken] = workflowProblems(valid({ name: 'digest' }), {
      mode: 'create',
      takenId: 'digest',
    });
    expect(taken?.kind).toBe('id-taken');
    expect(taken?.fieldId).toBe(ID_FIELD);
    expect(taken?.message).toBe(WORKFLOW_COPY.creator.taken('digest'));
    expect(taken?.summary).toBe(copy.summary.idTaken);
    expect(
      workflowProblems(valid({ name: 'digest-two' }), { mode: 'create', takenId: 'digest' }),
    ).toEqual([]);
  });

  test('wants a schedule to say how often it runs and a signal start to name its signal', () => {
    const schedule = workflowProblems(valid({ trigger: { kind: 'schedule', spec: ' ' } }), create);
    expect(schedule.map((problem) => problem.kind)).toEqual(['schedule']);
    expect(schedule[0]?.message).toBe(copy.schedule);
    expect(workflowProblems(valid({ trigger: { kind: 'schedule', spec: '1h' } }), create)).toEqual(
      [],
    );

    const signal = workflowProblems(valid({ trigger: { kind: 'signal', name: '' } }), create);
    expect(signal.map((problem) => problem.kind)).toEqual(['start-signal']);
    expect(signal[0]?.message).toBe(copy.startSignal);
    expect(signal[0]?.summary).toBe(copy.summary.startSignal);
    expect(signal[0]?.fieldId).toBe('workflow-builder-trigger-field');
  });

  test('puts a step that waits on a signal or a duration with nothing in it among the problems, and not a wait for a person or a step name', () => {
    const text = valid({
      steps: [
        { kind: 'await-signal', signal: '' },
        { kind: 'await-signal', signal: 'review-0a1b2c3d', review: true },
        { kind: 'sleep', duration: 'h' },
        { kind: 'sleep', duration: '15m' },
        { kind: 'sleep', duration: 5000 },
      ],
    });
    const problems = workflowProblems(text, create);
    expect(problems.map((problem) => [problem.kind, problem.position])).toEqual([
      ['signal', 1],
      ['duration', 3],
    ]);
    expect(problems[0]?.message).toBe(copy.signal);
    expect(problems[1]?.message).toBe(copy.duration);
    expect(problems[1]?.fieldId).toBe(stepFieldId(3, 'duration'));
  });

  test('says a workflow with no steps needs one, at the first Add a step button, once', () => {
    const problems = workflowProblems(valid({ steps: [] }), create);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('steps');
    expect(problems[0]?.fieldId).toBe(FIRST_ADD_BUTTON);
    expect(problems[0]?.message).toBe(WORKFLOW_COPY.builder.noSteps);
  });

  test('leaves steps that are not a list to the JSON tab, and text the builder cannot read to it too', () => {
    expect(workflowProblems(valid({ steps: 'later' }), create)).toEqual([]);
    expect(workflowProblems('{ not json', create)).toEqual([]);
    expect(workflowProblems('[]', create)).toEqual([]);
  });
});

describe('problemSummary', () => {
  test('says nothing for none or for one problem, which is said at its field', () => {
    expect(problemSummary([])).toBeUndefined();
    expect(problemSummary(workflowProblems(valid({ steps: [] }), create))).toBeUndefined();
  });

  test('lists two or more in order, each in its own short words', () => {
    const text = valid({
      name: 'morning-briefing',
      steps: [
        { kind: 'activity', handler: 'agent', input: { agent: 'assistant', message: 'Hi.' } },
        { kind: 'await-signal', signal: '' },
        { kind: 'activity', handler: 'agent', input: { agent: 'assistant', message: '' } },
      ],
    });
    expect(problemSummary(workflowProblems(text, create))).toBe(
      `${copy.summaryLead(2)} ${copy.summary.signal(2)} ${copy.summary.message(3)}`,
    );
  });
});
