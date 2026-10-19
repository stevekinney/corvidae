/** Tests for the pure mapping behind the refresh panel (COR-166). */
import { describe, expect, test } from 'bun:test';

import {
  activeGeneration,
  formatPollDuration,
  hasPendingCandidate,
  modeSummary,
  parseRefreshDiagnostics,
  sourceFields,
} from './refresh-view.ts';

const NOW = 1_700_000_000_000;

const source = {
  name: 'order-processing',
  state: 'installed',
  etag: 'sha256:abc',
  checkedAt: NOW - 120_000,
  candidate: { revision: 'rev-2', digest: 'sha256:d2', contractHash: 'sha256:c2' },
  current: { revision: 'rev-1', generation: 3, contractHash: 'sha256:c1', digest: 'sha256:d1' },
} as const;

describe('parseRefreshDiagnostics', () => {
  test('maps a full response, polling included', () => {
    const view = parseRefreshDiagnostics({
      polling: {
        intervalMilliseconds: 60_000,
        maxBackoffMilliseconds: 900_000,
        backoffMilliseconds: 120_000,
        nextCheckAt: NOW + 30_000,
      },
      sources: [source],
    });

    expect(view?.sources).toEqual([source]);
    expect(view?.polling).toEqual({
      intervalMilliseconds: 60_000,
      maxBackoffMilliseconds: 900_000,
      backoffMilliseconds: 120_000,
      nextCheckAt: NOW + 30_000,
    });
  });

  test('a manual-maintenance response has no polling', () => {
    const view = parseRefreshDiagnostics({ sources: [{ name: 'a', state: 'idle' }] });

    expect(view).toEqual({ sources: [{ name: 'a', state: 'idle' }] });
    expect(view).not.toHaveProperty('polling');
  });

  test('an empty list is a valid, empty response', () => {
    expect(parseRefreshDiagnostics({ sources: [] })).toEqual({ sources: [] });
  });

  test.each([
    ['not an object', 'nope'],
    ['no sources array', { polling: undefined }],
    ['a source without a name', { sources: [{ state: 'idle' }] }],
    ['an unknown state', { sources: [{ name: 'a', state: 'sleeping' }] }],
    ['a wrongly typed field', { sources: [{ name: 'a', state: 'idle', etag: 7 }] }],
    [
      'a half-built candidate',
      { sources: [{ name: 'a', state: 'idle', candidate: { revision: 'r' } }] },
    ],
    [
      'a current without a generation',
      { sources: [{ name: 'a', state: 'idle', current: { revision: 'r' } }] },
    ],
    ['polling without an interval', { sources: [], polling: { backoffMilliseconds: 1 } }],
  ])('rejects %s as malformed', (_label, raw) => {
    expect(parseRefreshDiagnostics(raw)).toBeUndefined();
  });
});

describe('sourceFields', () => {
  test('shows current and candidate identity side by side, from the response', () => {
    const fields = sourceFields(source, NOW);

    expect(fields.map((field) => field.term)).toEqual([
      'Current revision',
      'Current contract hash',
      'Current digest',
      'Candidate revision',
      'Candidate contract hash',
      'Candidate digest',
      'ETag',
      'Last check',
    ]);
    expect(fields.find((field) => field.term === 'Current revision')?.value).toBe('rev-1');
    expect(fields.find((field) => field.term === 'Candidate revision')?.value).toBe('rev-2');
    expect(fields.find((field) => field.term === 'ETag')?.value).toBe('sha256:abc');
    // Hashes are shown whole (the panel wraps them), never cut to an ellipsis.
    expect(fields.find((field) => field.term === 'Candidate digest')?.value).toBe('sha256:d2');
    expect(fields.find((field) => field.term === 'Current contract hash')?.value).toBe('sha256:c1');
    expect(fields.find((field) => field.term === 'Last check')?.value).toContain('2m ago');
  });

  test('says so, in words, for identity the server did not report', () => {
    const fields = sourceFields({ name: 'a', state: 'idle' }, NOW);
    const value = (term: string) => fields.find((field) => field.term === term)?.value;

    expect(value('Current revision')).toBe('None active');
    expect(value('Candidate revision')).toBe('No candidate');
    expect(value('Current digest')).toBe('Not reported');
    expect(value('ETag')).toBe('Not reported');
    expect(value('Last check')).toBe('Never');
  });

  test('a current revision refresh did not activate has no digest', () => {
    const fields = sourceFields(
      { name: 'a', state: 'idle', current: { revision: 'r', generation: 1 } },
      NOW,
    );

    expect(fields.find((field) => field.term === 'Current digest')?.value).toBe('Not reported');
  });
});

describe('hasPendingCandidate and activeGeneration', () => {
  test('a candidate that is not the active revision is pending', () => {
    expect(hasPendingCandidate(source)).toBe(true);
  });

  test('a candidate that is the active revision is not pending', () => {
    expect(
      hasPendingCandidate({
        ...source,
        candidate: { revision: 'rev-1', digest: 'd', contractHash: 'c' },
      }),
    ).toBe(false);
  });

  test('no candidate is not pending', () => {
    expect(hasPendingCandidate({ name: 'a', state: 'idle' })).toBe(false);
  });

  test('the fence is the active generation, or 0 before any activation', () => {
    expect(activeGeneration(source)).toBe(3);
    expect(activeGeneration({ name: 'a', state: 'idle' })).toBe(0);
  });
});

describe('modeSummary', () => {
  test('without polling the mode is manual maintenance and shows no policy', () => {
    const summary = modeSummary(undefined, NOW);

    expect(summary.mode).toBe('manual');
    expect(summary).not.toHaveProperty('fields');
  });

  test('with polling it shows the policy, backoff, and next check from the server', () => {
    const summary = modeSummary(
      {
        intervalMilliseconds: 60_000,
        maxBackoffMilliseconds: 900_000,
        backoffMilliseconds: 120_000,
        nextCheckAt: NOW + 30_000,
      },
      NOW,
    );

    expect(summary.mode).toBe('polling');
    if (summary.mode !== 'polling') throw new Error('expected polling');
    expect(summary.fields.map((field) => [field.term, field.value.split(' (')[0]])).toEqual([
      ['Interval', '1m'],
      ['Maximum backoff', '15m'],
      ['Current backoff', '2m'],
      ['Next check', 'in 30s'],
    ]);
  });

  test('says a check is running when the server reports no next check', () => {
    const summary = modeSummary(
      { intervalMilliseconds: 1_000, maxBackoffMilliseconds: 2_000, backoffMilliseconds: 1_000 },
      NOW,
    );

    if (summary.mode !== 'polling') throw new Error('expected polling');
    expect(summary.fields.find((field) => field.term === 'Next check')?.value).toBe(
      'A check is running',
    );
  });
});

describe('formatPollDuration', () => {
  test.each([
    [500, '500ms'],
    [1_000, '1s'],
    [90_000, '90s'],
    [150_000, '150s'],
    [60_000, '1m'],
    [900_000, '15m'],
    [5_400_000, '90m'],
    [3_600_000, '1h'],
    [7_200_000, '2h'],
  ])('%d ms reads %s, never rounded to another value', (milliseconds, expected) => {
    expect(formatPollDuration(milliseconds)).toBe(expected);
  });
});
