import { describe, expect, test } from 'bun:test';

import { awaitedSignalOf } from './engine-run-tasks';

const agent = { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Do it.' } };
const signal = { kind: 'await-signal', signal: 'notes-approved' };
const person = { kind: 'await-signal', signal: 'release-approved', review: true };
const ordered = [agent, signal, person].map((step, index) => ({ step, index }));

describe('the signal a run’s row says it waits for (correction round one, item 2)', () => {
  test('a signal wait names its signal', () => {
    expect(awaitedSignalOf('notes-approved', ordered, 2)).toBe('notes-approved');
    expect(awaitedSignalOf('notes-approved', ordered, null)).toBe('notes-approved');
  });

  test('a wait for a person is a review, never a signal wait', () => {
    expect(awaitedSignalOf('release-approved', ordered, 3)).toBeNull();
    expect(awaitedSignalOf('release-approved', ordered, null)).toBeNull();
  });

  test('the step the history names decides when a signal is both a review and a plain wait', () => {
    const shared = [
      { step: { kind: 'await-signal', signal: 'go' }, index: 0 },
      { step: { kind: 'await-signal', signal: 'go', review: true }, index: 1 },
    ];
    expect(awaitedSignalOf('go', shared, 1)).toBe('go');
    expect(awaitedSignalOf('go', shared, 2)).toBeNull();
    // With no step named, a signal a plain wait also waits for stays a signal wait.
    expect(awaitedSignalOf('go', shared, null)).toBe('go');
  });

  test('nothing waited for, or steps no longer recorded, say what the engine says', () => {
    expect(awaitedSignalOf(null, ordered, 2)).toBeNull();
    expect(awaitedSignalOf('release-approved', undefined, null)).toBe('release-approved');
  });
});
