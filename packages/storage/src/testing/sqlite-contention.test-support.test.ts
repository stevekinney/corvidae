import { describe, expect, it } from 'bun:test';

import {
  describeSqliteContentionViolations,
  parseSqliteContentionReport,
  SQLITE_CONTENTION_ATTEMPTS_PER_PROCESS,
  SQLITE_CONTENTION_KEYS_PER_BATCH,
  type SqliteContentionReport,
} from './sqlite-contention.test-support.ts';

function report(overrides: Partial<SqliteContentionReport> = {}): SqliteContentionReport {
  return {
    tag: 'a',
    mode: 'conditionalBatch',
    attempts: SQLITE_CONTENTION_ATTEMPTS_PER_PROCESS,
    committed: 300,
    rejected: SQLITE_CONTENTION_ATTEMPTS_PER_PROCESS - 300,
    threw: 0,
    errors: [],
    ...overrides,
  };
}

describe('parseSqliteContentionReport', () => {
  it('reads the last JSON line a racing process wrote', () => {
    const written = report({ tag: 'b' });
    expect(parseSqliteContentionReport('b', 0, `noise\n${JSON.stringify(written)}\n`, '')).toEqual(
      written,
    );
  });

  it('explains a process that exited non-zero, with what it wrote', () => {
    expect(() => parseSqliteContentionReport('a', 1, 'partial output', 'boom')).toThrow(
      'racing process a exited with 1 and no report\nstdout:\npartial output\nstderr:\nboom',
    );
  });

  it('explains a process that exited cleanly without a report', () => {
    expect(() => parseSqliteContentionReport('a', 0, '', '')).toThrow(
      'racing process a exited with 0 and no report',
    );
  });
});

describe('describeSqliteContentionViolations', () => {
  it('accepts a race in which every attempt committed or was rejected and the counter reconciles', () => {
    const reports = [report({ tag: 'a' }), report({ tag: 'b', committed: 200, rejected: 300 })];
    expect(
      describeSqliteContentionViolations('conditionalBatch', reports, {
        finalCounter: 500,
        batchKeyCount: 0,
      }),
    ).toEqual([]);
  });

  it('reports a process count other than two, a short race, and outcomes that do not sum', () => {
    const violations = describeSqliteContentionViolations(
      'conditionalBatch',
      [report({ attempts: 10, committed: 1, rejected: 1 })],
      { finalCounter: 1, batchKeyCount: 0 },
    );
    expect(violations).toEqual([
      'expected 2 reports, got 1',
      'a made 10 attempts',
      "a's outcomes do not sum to its 10 attempts",
    ]);
  });

  it('reports attempts that threw, with the messages', () => {
    const violations = describeSqliteContentionViolations(
      'conditionalBatch',
      [
        report({
          committed: 100,
          rejected: 300,
          threw: 100,
          errors: [['database is locked', 100]],
        }),
        report({ tag: 'b' }),
      ],
      { finalCounter: 400, batchKeyCount: 0 },
    );
    expect(violations).toEqual([
      `a threw on 100 of ${SQLITE_CONTENTION_ATTEMPTS_PER_PROCESS} attempts: [["database is locked",100]]`,
    ]);
  });

  it('reports a counter that disagrees with the attempts that committed', () => {
    expect(
      describeSqliteContentionViolations('conditionalBatch', [report(), report({ tag: 'b' })], {
        finalCounter: 599,
        batchKeyCount: 0,
      }),
    ).toEqual(['counter ended at 599, 600 attempts committed']);
  });

  it('accepts a batch race whose stored keys match the attempts that committed', () => {
    const batch = (tag: string) =>
      report({
        tag,
        mode: 'batch',
        committed: SQLITE_CONTENTION_ATTEMPTS_PER_PROCESS,
        rejected: 0,
      });
    expect(
      describeSqliteContentionViolations('batch', [batch('a'), batch('b')], {
        finalCounter: 0,
        batchKeyCount:
          2 * SQLITE_CONTENTION_ATTEMPTS_PER_PROCESS * SQLITE_CONTENTION_KEYS_PER_BATCH,
      }),
    ).toEqual([]);
  });

  it('reports a batch race that lost keys or reported a rejection', () => {
    const lossy = (tag: string) => report({ tag, mode: 'batch', committed: 499, rejected: 1 });
    expect(
      describeSqliteContentionViolations('batch', [lossy('a'), lossy('b')], {
        finalCounter: 0,
        batchKeyCount: 1,
      }),
    ).toEqual([
      `1 keys stored, expected ${2 * 499 * SQLITE_CONTENTION_KEYS_PER_BATCH}`,
      '2 plain batch attempts reported a rejection',
    ]);
  });
});
