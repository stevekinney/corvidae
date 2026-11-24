import { expect, test } from 'bun:test';
import {
  actionsBracketAssertion,
  competitorActions,
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

test('requires real actions on both sides of each target assertion', () => {
  const actions = ['2026-11-24T03:02:35.000Z', '2026-11-24T03:04:46.000Z'];
  expect(actionsBracketAssertion('2026-11-24T03:03:03.000Z', actions)).toBe(true);
  expect(actionsBracketAssertion('2026-11-24T03:05:58.000Z', actions)).toBe(false);
  expect(actionsBracketAssertion('2026-11-24T03:02:35.000Z', actions)).toBe(false);
  expect(actionsBracketAssertion(undefined, actions)).toBe(false);
  expect(actionsBracketAssertion('invalid', actions)).toBe(false);
});

test('extracts action markers rather than process or assertion markers', () => {
  expect(
    competitorActions(
      'COR2653_ACTION 2026-11-24T03:02:35.000Z\nCOR2653_ASSERTION 2026-11-24T03:03:03.000Z\n',
    ),
  ).toEqual(['2026-11-24T03:02:35.000Z']);
});
