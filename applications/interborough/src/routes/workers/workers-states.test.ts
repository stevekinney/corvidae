/**
 * The sentence of a failed read of the workers (row 78z): it names the status the server answered
 * with, carries the server's own words for a refusal, and says plainly when the server did not
 * answer or the person stopped the read.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { WORKER_COPY } from './worker-copy.ts';
import { workersLoadFailure } from './workers-states.ts';

const failed = WORKER_COPY.states.failed;

describe('workersLoadFailure', () => {
  test('names the status of a server error, and says nothing the person did caused it', () => {
    const result = workersLoadFailure(new HttpClientError(500, 'The engine broke.'), false);
    expect(result.title).toBe('Couldn’t load workers');
    expect(result.description).toBe(
      'The server answered with an error (500). Nothing you did caused it. Workers keep running while this page is down.',
    );
  });

  test('names whatever status the server answered with, not a fixed one', () => {
    expect(
      workersLoadFailure(new HttpClientError(503, 'Unavailable'), false).description,
    ).toContain('(503)');
  });

  test('carries the server’s own words for a refusal, which the person can fix', () => {
    const result = workersLoadFailure(
      new HttpClientError(403, 'Missing scope system:read.'),
      false,
    );
    expect(result.description).toBe(
      'The server answered with an error (403): Missing scope system:read. Workers keep running while this page is down.',
    );
  });

  test('says the server did not answer when the request got no answer', () => {
    expect(workersLoadFailure(new TypeError('Failed to fetch'), false).description).toBe(
      failed.noAnswer,
    );
  });

  test('says something went wrong for a failure that is neither', () => {
    expect(workersLoadFailure(new Error('boom'), false).description).toBe(failed.unknown);
  });

  test('says the person stopped the read, which failed nothing', () => {
    const result = workersLoadFailure(undefined, true);
    expect(result.title).toBe(failed.cancelledTitle);
    expect(result.description).toBe(failed.cancelledDescription);
  });
});
