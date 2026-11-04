import { describe, expect, test } from 'bun:test';

import { SAMPLE_NOW, SAMPLE_NOW_MILLISECONDS, SAMPLE_TIME_ZONE } from '../fixtures/sample-now.ts';
import { captureClock } from './e2e/capture-clock.ts';

describe('the sample world clock', () => {
  // The boards' "now" is Monday, Nov 2, 10:46 AM Central time. Nov 1, 2026 ends daylight saving
  // time, so the instant is read back in the zone rather than trusting the offset it was written with.
  test('is 10:46 AM CST on Monday, Nov 2, 2026 in the viewer’s zone', () => {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: SAMPLE_TIME_ZONE,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(SAMPLE_NOW_MILLISECONDS));
    expect(SAMPLE_TIME_ZONE).toBe('America/Chicago');
    expect(formatted).toBe('Monday, November 2, 2026 at 10:46 AM CST');
  });

  test('pins a design-review capture to the sample now in Central time', () => {
    expect(captureClock('/tmp/design-review/capture')).toEqual({
      now: SAMPLE_NOW,
      timeZone: 'America/Chicago',
    });
  });

  test('leaves an ordinary end-to-end run on the real clock', () => {
    expect(captureClock(undefined)).toBeUndefined();
  });
});
