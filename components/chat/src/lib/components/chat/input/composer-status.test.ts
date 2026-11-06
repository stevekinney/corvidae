import { describe, expect, test } from 'bun:test';

import { composerStatusText } from './composer-status.ts';

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

  test('reads an approval wait, and says a message steers the run when one would', () => {
    expect(composerStatusText({ kind: 'waiting' })).toBe('Waiting for your approval');
    expect(composerStatusText({ kind: 'waiting', steers: true })).toBe(
      'Waiting for your approval · a message now steers the run',
    );
  });
});
