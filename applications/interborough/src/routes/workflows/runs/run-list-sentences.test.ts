/**
 * The words of `/runs` that are made from what is on screen (`run-list-states.ts`): the sentence of
 * a list the filters leave empty, in each combination of filters, and what a list that could not be
 * read says and holds behind its error details.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { TASK_COPY } from '../../../app/copy/tasks.ts';
import { ServerUnreachableError } from '../../../lib/faults.ts';
import { runListFailure, runNoMatchDescription, startedByPhrase } from './run-list-states.ts';
import { STARTED_BY_KINDS } from './started-by.ts';

describe('startedByPhrase', () => {
  test('reads each way a run can start after "started by"', () => {
    expect(startedByPhrase('goal')).toBe('a goal');
    expect(startedByPhrase('schedule')).toBe('a schedule');
    expect(startedByPhrase('chat')).toBe('a chat');
    expect(startedByPhrase('person')).toBe('a person');
    expect(startedByPhrase('api')).toBe('the API');
    expect(startedByPhrase('system')).toBe('Interborough');
  });

  test('never leaves a capital on the article of any kind the filter offers', () => {
    for (const kind of STARTED_BY_KINDS) {
      expect(startedByPhrase(kind)).not.toMatch(/^(A|An|The) /);
    }
  });
});

describe('runNoMatchDescription', () => {
  test('names the agent alone, and tells which filter to change (10r, 12t)', () => {
    expect(runNoMatchDescription({ agent: 'model-switcher' }, 'Model switcher')).toBe(
      'Model switcher has no runs. Try another agent.',
    );
  });

  test('names the agent and the origin together (52y)', () => {
    expect(
      runNoMatchDescription({ agent: 'model-switcher', startedBy: 'goal' }, 'Model switcher'),
    ).toBe('Model switcher has no runs started by a goal. Try another agent or origin.');
  });

  test('puts a status before "runs", and names every filter that is on', () => {
    expect(runNoMatchDescription({ status: 'failed' }, undefined)).toBe(
      'No failed runs. Try another status.',
    );
    expect(
      runNoMatchDescription(
        { status: 'canceled', agent: 'assistant', startedBy: 'schedule' },
        'Assistant',
      ),
    ).toBe(
      'Assistant has no canceled runs started by a schedule. Try another status, agent or origin.',
    );
  });

  test('quotes the words searched for', () => {
    expect(runNoMatchDescription({ search: 'refund' }, undefined)).toBe(
      'No runs matching “refund”. Try another search.',
    );
  });

  test('has one status word for each segment the bar draws', () => {
    const words = Object.keys(TASK_COPY.list.noMatch.statusWords);
    expect(words).toEqual(['waiting', 'running', 'done', 'failed', 'canceled']);
  });
});

describe('runListFailure', () => {
  test('says the server answered with its status, and holds the operation and the code behind the details', () => {
    const failure = runListFailure([
      { operation: 'bureau.tasks.list', error: null },
      {
        operation: 'bureau.contexts.list',
        error: new HttpClientError(500, 'The Bureau broke.'),
      },
    ]);
    expect(failure.description).toBe(
      'The server answered with an error (500). Nothing you did caused it.',
    );
    expect(failure.detail).toBe('bureau.contexts.list: HTTP 500: The Bureau broke.');
  });

  test('lists every read that failed, one to a line', () => {
    const failure = runListFailure([
      { operation: 'bureau.tasks.list', error: new HttpClientError(503, 'Unavailable') },
      { operation: 'bureau.goals.list', error: new Error('boom') },
    ]);
    expect(failure.detail.split('\n')).toEqual([
      'bureau.tasks.list: HTTP 503: Unavailable',
      'bureau.goals.list: Error: boom',
    ]);
  });

  test('does not invent a status for an error that carried none', () => {
    const failure = runListFailure([{ operation: 'bureau.tasks.list', error: new Error('boom') }]);
    expect(failure.description).toBe(
      'The server answered with an error. Nothing you did caused it.',
    );
  });

  test('says the server did not answer when no read got an answer at all', () => {
    const failure = runListFailure([
      { operation: 'bureau.tasks.list', error: new ServerUnreachableError() },
      { operation: 'bureau.goals.list', error: null },
    ]);
    expect(failure.description).toBe(TASK_COPY.list.loadFailed.unreachable);
  });
});
