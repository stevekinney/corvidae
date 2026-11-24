import { expect, test } from 'bun:test';
import {
  assertionOverlapsCompetitor,
  competitorIntervals,
  qualificationMode,
} from './cor-2653-overlap.ts';

test('names partial competition evidence separately and requires the complete exact revision', () => {
  const revision = 'a'.repeat(40);
  expect(qualificationMode(`COR-2653-qualification:${revision}`, revision)).toBe('full');
  expect(qualificationMode(`COR-2653-qualification:${revision}:competition`, revision)).toBe(
    'competition-only',
  );
  expect(
    qualificationMode(`COR-2653-qualification:${revision.slice(0, 10)}:competition`, revision),
  ).toBeUndefined();
  expect(
    qualificationMode(`COR-2653-qualification:${revision}:competition`, 'b'.repeat(40)),
  ).toBeUndefined();
});

test('requires the actual assertion to fall inside a competitor action interval', () => {
  const intervals = [
    { assertionAt: '2026-11-24T03:02:35.000Z', finishedAt: '2026-11-24T03:04:46.000Z' },
  ];
  expect(assertionOverlapsCompetitor('2026-11-24T03:03:03.000Z', intervals)).toBe(true);
  expect(assertionOverlapsCompetitor('2026-11-24T03:05:58.000Z', intervals)).toBe(false);
  expect(assertionOverlapsCompetitor(undefined, intervals)).toBe(false);
  expect(assertionOverlapsCompetitor('invalid', intervals)).toBe(false);
});

test('counts only independently passing competitor cases with assertion and completion markers', () => {
  const output = [
    'COR2653_ASSERTION 2026-11-24T03:02:35.000Z',
    'COR2653_TEST_END 2026-11-24T03:03:03.000Z passed',
    'COR2653_ASSERTION 2026-11-24T03:04:00.000Z',
    'COR2653_TEST_END 2026-11-24T03:04:46.000Z failed',
    'COR2653_TEST_END 2026-11-24T03:05:58.000Z passed',
  ].join('\n');
  expect(competitorIntervals(output)).toEqual([
    { assertionAt: '2026-11-24T03:02:35.000Z', finishedAt: '2026-11-24T03:03:03.000Z' },
  ]);
});
