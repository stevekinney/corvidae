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
});
