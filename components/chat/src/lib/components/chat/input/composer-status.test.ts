import { describe, expect, test } from 'bun:test';

import { composerStatusText, isComposerDrawerStatus } from './composer-status.ts';

describe('composerStatusText', () => {
  test('reads a single queued follow-up in the singular', () => {
    expect(composerStatusText({ kind: 'queued', count: 1 })).toBe(
      'Follow-up queued · sends when the run is ready',
    );
  });

  test('reads several queued follow-ups with their count', () => {
    expect(composerStatusText({ kind: 'queued', count: 3 })).toBe(
      '3 follow-ups queued · they send when the run is ready',
    );
  });

  test('reads the offline drawer with the draft kept and Send coming back', () => {
    expect(composerStatusText({ kind: 'offline' })).toBe(
      "You're offline. Your draft is saved here, and Send comes back when you reconnect.",
    );
  });

  test('reads the draft-restored drawer with when the draft is from', () => {
    expect(composerStatusText({ kind: 'draft-restored', when: 'yesterday at 4:12 PM' })).toBe(
      'Restored your unsent draft from yesterday at 4:12 PM.',
    );
  });

  test('draws offline and a restored draft as drawers, and every other status as the line', () => {
    expect(isComposerDrawerStatus({ kind: 'offline' })).toBe(true);
    expect(isComposerDrawerStatus({ kind: 'draft-restored', when: 'today' })).toBe(true);
    expect(isComposerDrawerStatus({ kind: 'steering' })).toBe(false);
    expect(isComposerDrawerStatus(undefined)).toBe(false);
  });

  test('reads an approval wait, and says a message steers the run when one would', () => {
    expect(composerStatusText({ kind: 'waiting' })).toBe('Waiting for your approval');
    expect(composerStatusText({ kind: 'waiting', steers: true })).toBe(
      'Waiting for your approval · a message now steers the run',
    );
  });
});
