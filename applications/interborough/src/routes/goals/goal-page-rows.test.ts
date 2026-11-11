/**
 * How a goal's page reads its goal (design rows 67i to 67y, 69a to 69c and sweep S73): the status
 * word and its qualifier, the attempts newest first with their words and line two, the note that
 * says how the goal ended or what it waits on, the Details panel, and the actions the header
 * offers. The goals are the sample world's (Oct 30, Central time) and the board's captioned ones
 * (Nov 2).
 */
import { describe, expect, test } from 'bun:test';

import { GOALS_COPY } from '../../app/copy.ts';
import {
  goalAttemptFixture,
  goalFixture,
  humanWaitFixture,
  taskFixture,
  toolApprovalFixture,
} from '../../lib/bureau-fixtures.test-support.ts';
import type { Goal } from '../../lib/bureau-goals.ts';
import {
  attemptRows,
  attemptWaitOf,
  attemptWord,
  goalActions,
  goalEditPath,
  goalFacts,
  goalNote,
  goalPageWord,
  liveAttempt,
  reviewPath,
  startAgainPath,
  stopDescription,
  type AttemptWait,
} from './goal-page-rows.ts';

const ZONE = 'America/Chicago';
const copy = GOALS_COPY.detail;

/** Draft release notes: five attempts two minutes apart from 8:13 AM, none of which met the check. */
function draftReleaseNotes(): Goal {
  const took = [8, 6, 5, 7, 6];
  return goalFixture('draft-release-notes', {
    identity: { name: 'Draft release notes', version: '1' },
    validator: { name: 'Notes mention the staging fix', version: '1' },
    status: 'exhausted',
    createdAt: '2026-10-30T13:12:00.000Z',
    closedAt: '2026-10-30T13:21:06.000Z',
    bounds: { ...goalFixture('x').bounds, maximumAttempts: 5 },
    usage: { attempts: 5, steps: 5, tokens: 50, costUsd: null, durationMs: 32_000 },
    attempts: took.map((seconds, index) => {
      const start = Date.parse('2026-10-30T13:13:00.000Z') + index * 120_000;
      return goalAttemptFixture(`release-notes-${String(index + 1)}`, {
        attemptIndex: index,
        status: 'failed',
        startedAt: new Date(start).toISOString(),
        completedAt: new Date(start + seconds * 1000).toISOString(),
      });
    }),
  });
}

/** Summarize open refunds: attempt 1 missed the check, attempt 2 was running when it was stopped. */
function summarizeRefunds(): Goal {
  return goalFixture('summarize-open-refunds', {
    agentName: 'tool-runner',
    identity: { name: 'Summarize open refunds', version: '1' },
    validator: { name: 'summary-lists-every-refund-waiting-for-approval', version: '1' },
    status: 'canceled',
    createdAt: '2026-10-30T15:05:00.000Z',
    closedAt: '2026-10-30T15:08:12.000Z',
    cancellation: { requestedAt: '2026-10-30T15:08:12.000Z', reason: null },
    bounds: { ...goalFixture('x').bounds, maximumAttempts: 5 },
    usage: { attempts: 2, steps: 2, tokens: 20, costUsd: null, durationMs: 197_000 },
    attempts: [
      goalAttemptFixture('refunds-2', {
        attemptIndex: 1,
        status: 'aborted',
        startedAt: '2026-10-30T15:07:00.000Z',
        completedAt: '2026-10-30T15:08:12.000Z',
      }),
      goalAttemptFixture('refunds-1', {
        attemptIndex: 0,
        status: 'failed',
        startedAt: '2026-10-30T15:05:00.000Z',
        completedAt: '2026-10-30T15:07:05.000Z',
      }),
    ],
  });
}

/** Say hello: met on its one attempt at 7:48 AM. */
function sayHello(): Goal {
  return goalFixture('say-hello', {
    identity: { name: 'Say hello', version: '1' },
    validator: { name: 'reply-says-hello', version: '1' },
    status: 'succeeded',
    createdAt: '2026-10-30T12:48:00.000Z',
    closedAt: '2026-10-30T12:48:08.000Z',
    bounds: { ...goalFixture('x').bounds, maximumAttempts: 1 },
    usage: { attempts: 1, steps: 1, tokens: 10, costUsd: null, durationMs: 8_000 },
    attempts: [
      goalAttemptFixture('hello-1', {
        attemptIndex: 0,
        status: 'passed',
        startedAt: '2026-10-30T12:48:00.000Z',
        completedAt: '2026-10-30T12:48:08.000Z',
      }),
    ],
  });
}

/** The captioned working goal (Nov 2): attempt 2's result is being checked. */
function checkingRefunds(finishReason: string | null = null): Goal {
  return goalFixture('summarize-open-refunds', {
    agentName: 'tool-runner',
    identity: { name: 'Summarize open refunds', version: '1' },
    status: 'evaluating',
    createdAt: '2026-11-02T16:41:00.000Z',
    bounds: { ...goalFixture('x').bounds, maximumAttempts: 5 },
    usage: { attempts: 2, steps: 2, tokens: 20, costUsd: null, durationMs: 197_000 },
    attempts: [
      goalAttemptFixture('working-1', {
        attemptIndex: 0,
        status: 'failed',
        startedAt: '2026-11-02T16:41:00.000Z',
        completedAt: '2026-11-02T16:43:05.000Z',
      }),
      goalAttemptFixture('working-2', {
        attemptIndex: 1,
        status: 'evaluating',
        startedAt: '2026-11-02T16:44:00.000Z',
        completedAt: '2026-11-02T16:45:12.000Z',
        finishReason,
      }),
    ],
  });
}

/** The captioned goal whose first attempt waits on you (Nov 2). */
function refundDamagedOrders(): Goal {
  return goalFixture('refund-damaged-orders', {
    agentName: 'tool-runner',
    identity: { name: 'Refund damaged orders', version: '1' },
    status: 'running',
    createdAt: '2026-11-02T16:41:00.000Z',
    bounds: { ...goalFixture('x').bounds, maximumAttempts: 5 },
    usage: { attempts: 1, steps: 1, tokens: 10, costUsd: null, durationMs: 0 },
    attempts: [
      goalAttemptFixture('run-1', {
        attemptIndex: 0,
        status: 'running',
        startedAt: '2026-11-02T16:41:00.000Z',
        completedAt: null,
      }),
    ],
  });
}

/** The approval the waiting attempt's run is parked on, for Issue refund. */
const approval = toolApprovalFixture();
const parked = taskFixture({
  status: 'input-required',
  openWaits: [{ kind: 'tool-approval', reviewId: approval.id, callId: 'call-1' }],
});

describe('the goal’s status word', () => {
  test('is the list’s word once the goal ended, red only when it gave up or failed', () => {
    expect(goalPageWord(draftReleaseNotes())).toBe('Gave up');
    expect(goalPageWord(summarizeRefunds())).toBe('Stopped');
    expect(goalPageWord(sayHello())).toBe('Done');
    expect(goalPageWord(goalFixture('g', { status: 'failed' }))).toBe('Failed');
  });

  test('is Running with a qualifier while the goal works: checking the result, or its next attempt (sweep S73)', () => {
    expect(goalPageWord(checkingRefunds())).toBe('Running, checking the result');
    expect(
      goalPageWord(
        goalFixture('g', {
          status: 'retrying',
          bounds: { ...goalFixture('x').bounds, maximumAttempts: 5 },
          usage: { attempts: 1, steps: 1, tokens: 1, costUsd: null, durationMs: 1 },
        }),
      ),
    ).toBe('Running, attempt 2 of 5');
    expect(goalPageWord(goalFixture('g', { status: 'pending', attempts: [] }))).toBe('Running');
  });

  test('stays Running while an attempt waits on you, since the attempt says what it waits for (row 69a)', () => {
    expect(goalPageWord(refundDamagedOrders())).toBe('Running');
  });

  test('says a goal asked to stop is stopping', () => {
    const stopping = goalFixture('g', {
      status: 'running',
      cancellation: { requestedAt: '2026-11-02T16:50:00.000Z', reason: null },
    });
    expect(goalPageWord(stopping)).toBe(`Running, ${GOALS_COPY.stopping}`);
  });
});

describe('an attempt’s status word', () => {
  test('is Check not met (neutral) for one that missed, Done, Canceled, and Running while checked', () => {
    expect(attemptWord({ status: 'failed' }, undefined)).toBe('Check not met');
    expect(attemptWord({ status: 'passed' }, undefined)).toBe('Done');
    expect(attemptWord({ status: 'aborted' }, undefined)).toBe('Canceled');
    expect(attemptWord({ status: 'evaluating' }, undefined)).toBe('Running, checking the result');
    expect(attemptWord({ status: 'running' }, undefined)).toBe('Running');
  });

  test('is Waiting on you while its run is parked on a review', () => {
    const wait = attemptWaitOf(parked, approval);
    expect(attemptWord({ status: 'running' }, wait)).toBe('Waiting on you');
  });
});

describe('the attempts of a goal that gave up (rows 67i and 67l)', () => {
  test('are listed newest first, each Check not met, with the agent and how long it took', () => {
    const goal = draftReleaseNotes();
    const rows = attemptRows(goal, { agent: 'Assistant', zone: ZONE, now: 0, liveWait: undefined });
    expect(rows.map((row) => row.title)).toEqual([
      'Attempt 5',
      'Attempt 4',
      'Attempt 3',
      'Attempt 2',
      'Attempt 1',
    ]);
    expect(new Set(rows.map((row) => row.word))).toEqual(new Set(['Check not met']));
    expect(rows.map((row) => row.lineTwo)).toEqual([
      'Assistant, took 6 s',
      'Assistant, took 7 s',
      'Assistant, took 5 s',
      'Assistant, took 6 s',
      'Assistant, took 8 s',
    ]);
    // Each row links to its run.
    expect(rows.map((row) => row.runId)).toEqual([
      'release-notes-5',
      'release-notes-4',
      'release-notes-3',
      'release-notes-2',
      'release-notes-1',
    ]);
  });

  test('have a neutral note that says when it gave up, and opens its last attempt', () => {
    const note = goalNote(draftReleaseNotes(), { zone: ZONE, liveWait: undefined });
    expect(note?.tone).toBe('neutral');
    expect(note?.text).toBe(
      'Gave up on Fri, Oct 30 at 8:21 AM, after 5 of 5 attempts. None of them met the check.',
    );
    expect(note?.link).toEqual({
      label: 'Open attempt 5',
      target: { kind: 'run', runId: 'release-notes-5' },
    });
  });

  test('have Details with the check, the agent, the limit, when it stops and when it was made (row 67m)', () => {
    const facts = goalFacts(draftReleaseNotes(), {
      agent: 'Assistant',
      zone: ZONE,
      viewer: 'anonymous:local',
    });
    expect(facts).toEqual([
      { term: 'Check', definition: 'Notes mention the staging fix' },
      { term: 'Agent', definition: 'Assistant' },
      { term: 'Attempt limit', definition: '5 attempts' },
      { term: 'Stops', definition: 'When the check passes, or after the last attempt' },
      { term: 'Created', definition: 'Fri, Oct 30, 8:12 AM by you' },
    ]);
  });
});

describe('a goal that was stopped (rows 67q, 67r and 67s)', () => {
  test('lists the canceled attempt with when it was canceled, and the one before it as Check not met', () => {
    const rows = attemptRows(summarizeRefunds(), {
      agent: 'Tool runner',
      zone: ZONE,
      now: 0,
      liveWait: undefined,
    });
    expect(rows.map((row) => [row.title, row.word, row.lineTwo])).toEqual([
      ['Attempt 2', 'Canceled', 'Tool runner, canceled at 10:08 AM after 1 min 12 s'],
      ['Attempt 1', 'Check not met', 'Tool runner, took 2 min 5 s'],
    ]);
  });

  test('has a neutral note that never says who stopped it, and opens the canceled attempt', () => {
    const note = goalNote(summarizeRefunds(), { zone: ZONE, liveWait: undefined });
    expect(note?.tone).toBe('neutral');
    expect(note?.text).toBe(
      'Stopped on Fri, Oct 30 at 10:08 AM, after 2 of 5 attempts. Attempt 2 was canceled; the work it did is kept in its run.',
    );
    expect(note?.text).not.toContain('by you');
    expect(note?.link?.label).toBe('Open attempt 2');
  });

  test('says its check in words and who made it', () => {
    const facts = goalFacts(summarizeRefunds(), {
      agent: 'Tool runner',
      zone: ZONE,
      viewer: 'someone-else',
    });
    expect(facts[0]).toEqual({
      term: 'Check',
      definition: 'Summary lists every refund waiting for approval',
    });
    expect(facts[4]?.definition).toBe('Fri, Oct 30, 10:05 AM by anonymous:local');
  });

  test('offers Start again and not Stop goal', () => {
    expect(goalActions(summarizeRefunds())).toEqual({ stop: false, startAgain: true });
  });
});

describe('a goal that is done (rows 67t, 67u and 67v)', () => {
  test('has a note that says the check was met, and opens the attempt', () => {
    const note = goalNote(sayHello(), { zone: ZONE, liveWait: undefined });
    expect(note?.text).toBe('Done on attempt 1 of 1: the check was met on Fri, Oct 30 at 7:48 AM.');
    expect(note?.link?.label).toBe('Open attempt 1');
  });

  test('lists its attempt as Done, and says its limit in the singular', () => {
    const rows = attemptRows(sayHello(), {
      agent: 'Assistant',
      zone: ZONE,
      now: 0,
      liveWait: undefined,
    });
    expect(rows.map((row) => [row.word, row.lineTwo])).toEqual([['Done', 'Assistant, took 8 s']]);
    const facts = goalFacts(sayHello(), {
      agent: 'Assistant',
      zone: ZONE,
      viewer: 'anonymous:local',
    });
    expect(facts[2]).toEqual({ term: 'Attempt limit', definition: '1 attempt' });
    expect(facts[4]?.definition).toBe('Fri, Oct 30, 7:48 AM by you');
  });

  test('offers neither Start again nor Stop goal, since nothing is left to try', () => {
    expect(goalActions(sayHello())).toEqual({ stop: false, startAgain: false });
  });

  test('offers Start again on a goal that gave up or failed', () => {
    expect(goalActions(draftReleaseNotes()).startAgain).toBe(true);
    expect(goalActions(goalFixture('g', { status: 'failed' })).startAgain).toBe(true);
  });
});

describe('a goal whose result is being checked (rows 67w, 67x and 67y)', () => {
  test('lists attempt 2 as Running, checking the result, with what the agent took', () => {
    const rows = attemptRows(checkingRefunds(), {
      agent: 'Tool runner',
      zone: ZONE,
      now: 0,
      liveWait: undefined,
    });
    expect(rows.map((row) => [row.title, row.word, row.lineTwo])).toEqual([
      ['Attempt 2', 'Running, checking the result', 'Tool runner, Agent took 1 min 12 s'],
      ['Attempt 1', 'Check not met', 'Tool runner, took 2 min 5 s'],
    ]);
  });

  test('says why the agent stopped, in words, when it did not end its own way (sweep S73)', () => {
    const rows = attemptRows(checkingRefunds('tripwire'), {
      agent: 'Tool runner',
      zone: ZONE,
      now: 0,
      liveWait: undefined,
    });
    expect(rows[0]?.lineTwo).toBe('Tool runner, Agent took 1 min 12 s, Agent stopped: a guardrail');
  });

  test('offers Stop goal, whose confirmation says the check is canceled and the work kept', () => {
    expect(goalActions(checkingRefunds())).toEqual({ stop: true, startAgain: false });
    expect(stopDescription(checkingRefunds())).toBe(
      'Attempt 2 has finished and its result is being checked. Stopping cancels the check, and the work the attempt did stays in its run. No more attempts start. You can start the goal again later.',
    );
    expect(copy.stop.title('Summarize open refunds')).toBe('Stop Summarize open refunds?');
  });

  test('has no note, and Details says it was made on Nov 2', () => {
    expect(goalNote(checkingRefunds(), { zone: ZONE, liveWait: undefined })).toBeUndefined();
    const facts = goalFacts(checkingRefunds(), {
      agent: 'Tool runner',
      zone: ZONE,
      viewer: 'anonymous:local',
    });
    expect(facts[4]?.definition).toBe('Mon, Nov 2, 10:41 AM by you');
  });

  test('is not offered Stop goal once it was asked to stop', () => {
    const asked = goalFixture('g', {
      status: 'running',
      cancellation: { requestedAt: '2026-11-02T16:50:00.000Z', reason: null },
    });
    expect(goalActions(asked).stop).toBe(false);
  });
});

describe('a goal whose attempt waits on you (rows 69b and 69c)', () => {
  test('reads the wait from the run and the review it is parked on', () => {
    expect(attemptWaitOf(parked, approval)).toEqual({
      kind: 'approval',
      tool: 'Issue refund',
      since: approval.requestedAt,
      reviewKey: `bureau:${approval.id}`,
    });
  });

  test('says the wait without the tool until the review is read, and is no wait for a run that waits on nobody', () => {
    expect(attemptWaitOf(parked, undefined)).toEqual({
      kind: 'approval',
      tool: undefined,
      since: undefined,
      reviewKey: `bureau:${approval.id}`,
    });
    expect(attemptWaitOf(taskFixture({ status: 'working' }), approval)).toBeUndefined();
    expect(attemptWaitOf(undefined, undefined)).toBeUndefined();
  });

  test('says a question waits for your answer', () => {
    const question = humanWaitFixture();
    const task = taskFixture({
      status: 'input-required',
      openWaits: [{ kind: 'human-wait', reviewId: question.id, signalName: 'environment' }],
    });
    expect(attemptWaitOf(task, question)?.kind).toBe('question');
  });

  test('lists the attempt as Waiting on you, with the tool and how long it has waited', () => {
    const goal = refundDamagedOrders();
    const liveWait = attemptWaitOf(parked, approval);
    expect(liveAttempt(goal)?.runId).toBe('run-1');
    const rows = attemptRows(goal, {
      agent: 'Tool runner',
      zone: ZONE,
      now: approval.requestedAt + 4 * 60_000,
      liveWait,
    });
    expect(rows.map((row) => [row.title, row.word, row.lineTwo])).toEqual([
      [
        'Attempt 1',
        'Waiting on you',
        'Tool runner, Issue refund is waiting for your approval, 4 min',
      ],
    ]);
  });

  test('has an amber note that names the tool and opens the review in Reviews', () => {
    const liveWait: AttemptWait | undefined = attemptWaitOf(parked, approval);
    const note = goalNote(refundDamagedOrders(), { zone: ZONE, liveWait });
    expect(note?.tone).toBe('warning');
    expect(note?.text).toBe(
      'Attempt 1 is waiting on you: Issue refund needs your approval before it can continue.',
    );
    expect(note?.link).toEqual({
      label: 'Open in Reviews',
      target: { kind: 'review', reviewKey: `bureau:${approval.id}` },
    });
  });

  test('offers Stop goal, and no Start again', () => {
    expect(goalActions(refundDamagedOrders())).toEqual({ stop: true, startAgain: false });
  });
});

describe('the addresses the page links to', () => {
  test('are the goal’s Edit page, New goal prefilled from it, and the review in Reviews', () => {
    expect(goalEditPath('summarize-open-refunds')).toBe('/goals/summarize-open-refunds/edit');
    expect(startAgainPath('summarize-open-refunds')).toBe('/goals/new?from=summarize-open-refunds');
    expect(reviewPath('bureau:approval:run-1:call-1')).toBe(
      '/reviews?review=bureau%3Aapproval%3Arun-1%3Acall-1',
    );
  });
});
