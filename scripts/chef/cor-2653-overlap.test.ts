import { expect, test } from 'bun:test';
import {
  actionAfterRelease,
  actionsBracketAssertion,
  competitorActions,
  performCompetitionActions,
  plantDirectSupervisorFailure,
  qualificationMode,
} from './cor-2653-overlap.ts';

test('plants the direct restart failure once, leaving the owned branch unchanged', async () => {
  const source = await Bun.file(
    new URL('../../applications/interborough/src/host/supervisor.ts', import.meta.url),
  ).text();
  const altered = plantDirectSupervisorFailure(source);
  expect(altered).toContain('if (code !== RESTART_EXIT_CODE) return code;');
  expect(altered).toContain(
    'if (stopping) return code === RESTART_EXIT_CODE || signal !== null ? 0 : code;\n      if (code !== RESTART_EXIT_CODE || code === 75) return code;',
  );
  expect(() => plantDirectSupervisorFailure(altered)).toThrow('exactly one');
  expect(() => plantDirectSupervisorFailure(`${source}\n${source}`)).toThrow('exactly one');
  expect(() => plantDirectSupervisorFailure('')).toThrow('exactly one');
});

test('performs a verified action after an immediate release acknowledgement', async () => {
  const events: string[] = [];
  await performCompetitionActions(
    async () => {
      events.push('action');
    },
    async () => {
      events.push('released');
      return true;
    },
  );
  expect(events).toEqual(['action', 'released', 'action']);
});

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

test('requires an action marker after release, not only before it', () => {
  const action = 'COR2653_ACTION 2026-11-24T06:17:30.481Z\n';
  const release = 'COR2653_RELEASE 2026-11-24T06:17:30.494Z\n';
  expect(actionAfterRelease(action + release)).toBe(false);
  expect(actionAfterRelease(action + release + 'COR2653_ACTION 2026-11-24T06:17:30.495Z\n')).toBe(
    true,
  );
});
