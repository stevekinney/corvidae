/**
 * The builder's read-back sentence, as the footer of board PageWorkflowBuilder says it: what starts
 * the workflow, then each step, the last after "then". The sentences are the board's own.
 */
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { readBuilder } from './workflow-builder-model.ts';

/** Friday, Nov 6, 2026, when Chicago is on Central Standard Time. */
const NOVEMBER = Date.UTC(2026, 10, 6, 15, 0);

const agentStep = (agent: string, message: string) => ({
  kind: 'activity',
  handler: 'agent',
  input: { agent, message },
});

const readBack = (file: unknown): string | undefined =>
  readBuilder(JSON.stringify(file, null, 2), { now: NOVEMBER })?.readBack;

describe('the read-back sentence', () => {
  test('reads a weekday schedule, an agent, a person, another agent, then a wait (row 64r)', () => {
    expect(
      readBack({
        name: 'morning-briefing',
        trigger: {
          kind: 'schedule',
          spec: '0 9 * * 1-5',
          timezone: 'America/Chicago',
          overlap: 'skip',
          catchUp: false,
        },
        steps: [
          agentStep('assistant', 'Summarize what happened yesterday.'),
          { kind: 'await-signal', signal: 'approve-briefing', review: true },
          agentStep('assistant', 'Post it.'),
          { kind: 'sleep', duration: '15m' },
        ],
      }),
    ).toBe(
      'On weekdays at 9:00 AM CST, ask Assistant to summarize what happened yesterday, wait for a person to review it, ask Assistant to post it, then wait 15 minutes.',
    );
  });

  test('reads a manual start (row 65b)', () => {
    expect(
      readBack({
        name: 'refund',
        trigger: { kind: 'manual' },
        steps: [agentStep('tool-runner', 'Look up order 4471.')],
      }),
    ).toBe('Run it when you press Start run, then ask Tool runner to look up order 4471.');
  });

  test('reads a signal start (row 65m)', () => {
    expect(
      readBack({
        name: 'briefing',
        trigger: { kind: 'signal', name: 'briefing-requested' },
        steps: [agentStep('assistant', 'Summarize what happened yesterday.')],
      }),
    ).toBe(
      'Each time briefing-requested is sent, ask Assistant to summarize what happened yesterday.',
    );
  });

  test('names a weekly schedule’s day, and a zone the trigger does not name as UTC', () => {
    const steps = [{ kind: 'await-signal', signal: 'notes-approved' }];
    expect(
      readBack({
        trigger: { kind: 'schedule', spec: '0 11 * * 5', timezone: 'America/Chicago' },
        steps,
      }),
    ).toBe('Every Friday at 11:00 AM CST, wait for notes-approved.');
    expect(readBack({ trigger: { kind: 'schedule', spec: '30 18 * * *' }, steps })).toBe(
      'Every day at 6:30 PM UTC, wait for notes-approved.',
    );
  });

  test('reads an interval, and says a spec it has no words for as written', () => {
    const steps = [{ kind: 'sleep', duration: '1m' }];
    expect(readBack({ trigger: { kind: 'schedule', spec: '1h' }, steps })).toBe(
      'Every hour, wait 1 minute.',
    );
    expect(readBack({ trigger: { kind: 'schedule', spec: '15m' }, steps })).toBe(
      'Every 15 minutes, wait 1 minute.',
    );
    expect(readBack({ trigger: { kind: 'schedule', spec: '*/5 * * * *' }, steps })).toBe(
      'On the schedule */5 * * * *, wait 1 minute.',
    );
  });

  test('says a wait in milliseconds, a signal wait, and a step it cannot describe', () => {
    expect(
      readBack({
        trigger: { kind: 'signal', name: 'go' },
        steps: [
          { kind: 'sleep', duration: 60000 },
          { kind: 'await-signal', signal: '' },
          { kind: 'activity', handler: 'agent', input: 'not an object' },
        ],
      }),
    ).toBe(
      `Each time go is sent, wait 60000 ms, wait for a signal, then ${WORKFLOW_COPY.builder.readBack.other}.`,
    );
  });

  test('asks for a step, or for the first empty agent step, before it reads anything back', () => {
    expect(readBack({ trigger: { kind: 'manual' }, steps: [] })).toBe(
      WORKFLOW_COPY.builder.readBack.noSteps,
    );
    expect(readBack({ trigger: { kind: 'manual' }, steps: [agentStep('', '')] })).toBe(
      'Fill in step 1 to see what this workflow does.',
    );
  });

  test('says a call of an activity by its title, and of a code workflow by its title', () => {
    const file = {
      trigger: { kind: 'manual' },
      steps: [
        { kind: 'activity', handler: 'demo:echo-input', input: { text: 'hi' } },
        { kind: 'workflow', workflow: 'demo:morning-briefing' },
      ],
    };
    // Without the catalog a name is the id in words.
    expect(readBack(file)).toBe(
      'Run it when you press Start run, then run Demo echo input, then run the workflow Demo morning briefing.',
    );
    const view = readBuilder(JSON.stringify(file), {
      now: NOVEMBER,
      activityName: () => 'Echo input',
      workflowName: () => 'Morning briefing',
    });
    expect(view?.readBack).toBe(
      'Run it when you press Start run, then run Echo input, then run the workflow Morning briefing.',
    );
    expect(
      readBack({ trigger: { kind: 'manual' }, steps: [{ kind: 'workflow', workflow: '' }] }),
    ).toContain('run a workflow');
  });

  test('says each control-flow step in one clause that never says what it holds', () => {
    const inner = { kind: 'await-signal', signal: 'deep', timeout: '1h' };
    expect(
      readBack({
        trigger: { kind: 'manual' },
        steps: [
          { kind: 'branch', on: 'status', cases: { a: [inner], b: [inner] } },
          { kind: 'parallel', branches: { x: [inner], y: [], z: [inner] } },
          { kind: 'map', over: 'files', steps: [inner, inner] },
        ],
      }),
    ).toBe(
      'Run it when you press Start run, then choose a path by status (2 cases), run 3 lists side by side, then repeat 2 steps for each item in files.',
    );
    const words = WORKFLOW_COPY.builder.readBack;
    expect(words.choosePath('', 1)).toBe('choose a path by a value (1 case)');
    expect(words.choosePath('status', 0)).toBe('choose a path by status (no cases yet)');
    expect(words.sideBySide(1)).toBe('run 1 list side by side');
    expect(words.repeat(1, '')).toBe('repeat 1 step for each item');
    expect(words.repeat(0, 'files')).toBe('repeat the steps for each item in files');
  });

  test('says how long a wait for a person or a signal lasts before the run goes on without it', () => {
    expect(
      readBack({
        trigger: { kind: 'manual' },
        steps: [
          { kind: 'await-signal', signal: 'review-1', review: true, timeout: '2h' },
          { kind: 'await-signal', signal: 'go', timeout: '1m' },
          { kind: 'await-signal', signal: '', timeout: 5000 },
          { kind: 'await-signal', signal: 'plain' },
        ],
      }),
    ).toBe(
      'Run it when you press Start run, then wait up to 2 hours for a person to review it, wait up to 1 minute for go, wait up to 5000 ms for a signal, then wait for plain.',
    );
  });

  test('names an agent by the name the page gives it', () => {
    const view = readBuilder(
      JSON.stringify({ trigger: { kind: 'manual' }, steps: [agentStep('demo:assistant', 'Go.')] }),
      { now: NOVEMBER, agentName: () => 'Assistant' },
    );
    expect(view?.readBack).toBe('Run it when you press Start run, then ask Assistant to go.');
  });
});
