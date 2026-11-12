/** The lines under a workflow's title and the numbered rows of its steps, said without a page. */
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import {
  builtInLine,
  hasLongStep,
  lastRunLine,
  LONG_STEP_DESCRIPTION,
  scheduleLine,
  startsLine,
  startsPart,
  stepRows,
} from './workflow-page-presentation.ts';

const ZONE = 'America/Chicago';
const NOW = Date.parse('2026-11-02T10:46:00-06:00');

describe('what starts a workflow', () => {
  test('says a schedule in words, lower-casing "Every" and keeping any other cadence as it is', () => {
    expect(startsPart({ kind: 'schedule', words: 'Every hour' })).toEqual([
      { text: 'Starts every hour' },
    ]);
    expect(startsPart({ kind: 'schedule', words: 'Fridays at 11:00 AM' })).toEqual([
      { text: 'Starts Fridays at 11:00 AM' },
    ]);
  });

  test('sets the signal in monospace, and counts several schedules', () => {
    expect(startsPart({ kind: 'signal', name: 'message-received' })).toEqual([
      { text: WORKFLOW_COPY.page.header.startsOnSignal.before },
      { text: 'message-received', code: true },
      { text: WORKFLOW_COPY.page.header.startsOnSignal.after },
    ]);
    expect(startsPart({ kind: 'schedule', words: '2 schedules', count: 2 })).toEqual([
      { text: 'Starts from 2 schedules' },
    ]);
    expect(startsPart(null)).toBeNull();
  });

  test('joins the facts of the first line in order: what starts it, a person can too, the agent', () => {
    const line = startsLine({
      trigger: { kind: 'schedule', words: 'Every hour' },
      canStart: true,
      agent: 'Assistant',
    });
    expect(line?.id).toBe('starts');
    expect(line?.parts).toEqual([
      [{ text: 'Starts every hour' }],
      [{ text: 'you can also start it yourself' }],
      [{ text: 'runs as Assistant' }],
    ]);
  });

  test('leaves out what the workflow does not have, and is no line when it has nothing', () => {
    expect(
      startsLine({ trigger: { kind: 'signal', name: 'go' }, canStart: false, agent: null })?.parts,
    ).toHaveLength(1);
    expect(startsLine({ trigger: null, canStart: true, agent: null })).toBeNull();
  });
});

describe('the last run of a workflow', () => {
  const failed = {
    id: 'run-1',
    status: 'failed',
    createdAt: Date.parse('2026-10-30T11:00:00-05:00'),
  } as const;

  test('is the date as a link to the run, the outcome as a status word, and the file', () => {
    const line = lastRunLine({
      lastRun: failed,
      fileName: 'release-notes.json',
      runHref: (id) => `/runs/${id}`,
      now: NOW,
      zone: ZONE,
    });
    expect(line?.parts).toEqual([
      [{ text: 'Last run ' }, { text: 'Oct 30', href: '/runs/run-1' }],
      [{ text: '', word: 'Failed' }],
      [{ text: 'file ' }, { text: 'release-notes.json', code: true }],
    ]);
  });

  test('says Never run only once the engine says there is no run, and nothing while it has not said', () => {
    const never = lastRunLine({
      lastRun: null,
      fileName: 'order-refund.json',
      runHref: (id) => id,
      now: NOW,
      zone: ZONE,
    });
    expect(never?.parts[0]).toEqual([{ text: WORKFLOW_COPY.page.header.neverRun }]);
    const unread = lastRunLine({
      lastRun: undefined,
      fileName: 'order-refund.json',
      runHref: (id) => id,
      now: NOW,
      zone: ZONE,
    });
    expect(unread?.parts).toEqual([[{ text: 'file ' }, { text: 'order-refund.json', code: true }]]);
    expect(
      lastRunLine({
        lastRun: undefined,
        fileName: null,
        runHref: (id) => id,
        now: NOW,
        zone: ZONE,
      }),
    ).toBeNull();
  });
});

describe('the schedule line', () => {
  const schedule = {
    label: 'Release notes digest',
    href: '/schedules/digest',
    status: 'active',
    cadence: 'Mondays at 11:00 AM',
  } as const;

  test('names the schedule the file defines, with its name as a link', () => {
    expect(scheduleLine({ schedules: [schedule], definedInFile: true })?.parts).toEqual([
      [
        { text: 'Schedule: ' },
        { text: 'Release notes digest', href: '/schedules/digest' },
        { text: ', defined in this file.' },
      ],
    ]);
  });

  test('says "Also started by" for another schedule, with its cadence while it is active and "paused" when it is not', () => {
    const active = scheduleLine({ schedules: [schedule], definedInFile: false });
    expect(active?.parts[0]?.map((run) => run.text)).toEqual([
      'Also started by the ',
      'Release notes digest',
      ' schedule',
      ' (Mondays at 11:00 AM).',
    ]);
    const paused = scheduleLine({
      schedules: [{ ...schedule, status: 'paused' }],
      definedInFile: false,
    });
    expect(paused?.parts[0]?.at(-1)?.text).toBe(' (paused).');
  });

  test('counts several schedules, and is no line when none starts the workflow', () => {
    expect(scheduleLine({ schedules: [schedule, schedule], definedInFile: false })?.parts).toEqual([
      [{ text: 'Also started by 2 schedules.' }],
    ]);
    expect(scheduleLine({ schedules: [], definedInFile: true })).toBeNull();
  });
});

describe('the line of an internal workflow', () => {
  test('says it is built in, its identifier, what starts it and when it last ran today', () => {
    const line = builtInLine({
      name: 'agentRun',
      lastRunAt: Date.parse('2026-11-02T10:42:00-06:00'),
      now: NOW,
      zone: ZONE,
    });
    expect(line.parts).toEqual([
      [{ text: 'Built in' }],
      [{ text: 'agentRun', code: true }],
      [{ text: 'Started by chats and schedules' }],
      [{ text: 'Last run today, 10:42 AM' }],
    ]);
  });

  test('names no starter for a type it has no words for, and says Never run only when the engine says so', () => {
    const never = builtInLine({ name: 'somethingElse', lastRunAt: null, now: NOW, zone: ZONE });
    expect(never.parts.map((part) => part[0]?.text)).toEqual([
      'Built in',
      'somethingElse',
      'Never run',
    ]);
    const unread = builtInLine({ name: 'agentRun', lastRunAt: undefined, now: NOW, zone: ZONE });
    expect(unread.parts).toHaveLength(3);
  });
});

describe('the steps of a file', () => {
  const steps = [
    {
      kind: 'activity',
      handler: 'agent',
      title: 'Find the last release',
      input: { agent: 'assistant', message: 'Find the most recent release and when it was made.' },
    },
    { kind: 'sleep', duration: '5m' },
    { kind: 'await-signal', signal: 'notes-approved', title: 'Wait for approval' },
    { kind: 'await-signal', signal: 'approve', review: true },
    { kind: 'activity', handler: 'send-email', input: {} },
    { kind: 'branch' },
  ];

  test('are numbered rows with the file’s title, a kind line and what the step does', () => {
    const rows = stepRows(steps, (id) => `Agent ${id}`);
    expect(rows[0]).toEqual({
      position: 1,
      title: 'Find the last release',
      kind: 'Ask an agent, Agent assistant',
      identifier: null,
      description: 'Find the most recent release and when it was made.',
    });
    expect(rows[2]).toEqual({
      position: 3,
      title: 'Wait for approval',
      kind: 'Wait for a signal',
      identifier: 'notes-approved',
      description: 'The run reads Waiting until the signal arrives.',
    });
  });

  test('tell a wait for a person from a wait for a signal, and name a step the file does not', () => {
    const rows = stepRows(steps);
    expect(rows[3]).toMatchObject({
      title: 'Step 4',
      kind: 'Wait for a person',
      identifier: null,
      description: 'Shows in Reviews until someone approves or denies.',
    });
    expect(rows[1]).toMatchObject({ title: 'Step 2', kind: 'Wait 5m' });
    expect(rows[4]?.kind).toBe(WORKFLOW_COPY.steps.activity('send-email'));
    expect(rows[5]?.kind).toBe(WORKFLOW_COPY.steps.unknown('branch'));
  });

  test('collapse to the first step only when a step says more than a couple of lines', () => {
    const short = stepRows(steps);
    expect(hasLongStep(short)).toBe(false);
    const long = stepRows([
      {
        kind: 'activity',
        handler: 'agent',
        input: { agent: 'writer', message: 'x'.repeat(LONG_STEP_DESCRIPTION + 1) },
      },
    ]);
    expect(hasLongStep(long)).toBe(true);
  });
});
