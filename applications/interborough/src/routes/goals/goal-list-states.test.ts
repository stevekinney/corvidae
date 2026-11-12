/**
 * What the Goals list says when a read failed (design rows 68n and 14s): one title, a sentence that
 * names what happened, and the error's own words for the disclosure that holds the details.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { GOALS_COPY } from '../../app/copy/goals.ts';
import { goalsLoadFailure } from './goal-list-states.ts';

describe('a failed read of the goals', () => {
  test('says the server answered with an error, and that nothing the person did caused it', () => {
    const failure = goalsLoadFailure(new HttpClientError(500, 'Internal Server Error'));
    expect(failure.title).toBe('Couldn’t load goals');
    expect(failure.description).toBe(
      'The server answered with an error (500). Nothing you did caused it.',
    );
    expect(failure.detail).toBe('HTTP 500: Internal Server Error');
  });

  test('carries the server’s own words for a refusal, because that is something to fix', () => {
    const failure = goalsLoadFailure(new HttpClientError(403, 'Not yours.'));
    expect(failure.description).toBe('The server answered with an error (403): Not yours.');
  });

  test('says the server did not answer for a read that got no answer', () => {
    const failure = goalsLoadFailure(new TypeError('Failed to fetch'));
    expect(failure.description).toBe(GOALS_COPY.failed.noAnswer);
    expect(failure.detail).toBe('Failed to fetch');
  });

  test('says something went wrong for anything else, with no detail when the error said nothing', () => {
    expect(goalsLoadFailure(new Error('Unexpected shape.')).description).toBe(
      GOALS_COPY.failed.unknown,
    );
    const nothing = goalsLoadFailure('not an error');
    expect(nothing.description).toBe(GOALS_COPY.failed.unknown);
    expect(nothing.detail).toBeUndefined();
  });
});
