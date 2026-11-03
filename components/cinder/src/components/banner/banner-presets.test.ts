import { describe, expect, test } from 'bun:test';

import {
  BANNER_BACK_ONLINE_COPY,
  BANNER_PRESETS,
  bannerPresetCopy,
  formatBannerAsOf,
  type BannerPreset,
} from './banner-presets.ts';

// 10:44 AM Central standard time on Monday, November 2, 2026 (UTC-6).
const asOf = new Date('2026-11-02T16:44:00Z');
const facts = { asOf, timeZone: 'America/Chicago', now: new Date('2026-11-02T17:10:00Z') };

function words(preset: BannerPreset, extra: Parameters<typeof bannerPresetCopy>[1] = {}) {
  const { title, text } = bannerPresetCopy(preset, { ...facts, ...extra });
  return [title, text].filter(Boolean).join(' ');
}

describe('formatBannerAsOf', () => {
  test('names the absolute time with its zone, never an age', () => {
    expect(formatBannerAsOf(asOf, facts)).toBe('10:44 AM CST');
  });

  test('puts the day first when the data is from another day', () => {
    expect(formatBannerAsOf(asOf, { ...facts, now: new Date('2026-11-04T17:10:00Z') })).toBe(
      'Mon Nov 2, 10:44 AM CST',
    );
  });

  test('follows daylight saving in the zone abbreviation', () => {
    const summer = new Date('2026-07-01T16:44:00Z');
    expect(formatBannerAsOf(summer, { timeZone: 'America/Chicago', now: summer })).toBe(
      '11:44 AM CDT',
    );
  });

  test('says so for a date it cannot read', () => {
    expect(formatBannerAsOf('not a date', facts)).toBe('an unknown time');
  });
});

describe('bannerPresetCopy: the preset table, one wording everywhere', () => {
  test('offline', () => {
    expect(words('offline', { retryInSeconds: 8 })).toBe(
      'You’re offline. Showing what loaded as of 10:44 AM CST. Changes are off until you’re back. Retrying in 8 s.',
    );
  });

  test('unreachable carries its countdown and attempt', () => {
    expect(words('unreachable', { retryInSeconds: 4, attempt: 3 })).toBe(
      'Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Changes are off until it’s back. Retrying in 4 s (attempt 3 of 8).',
    );
  });

  test('stopped ends the countdown and leads with Stopped retrying', () => {
    expect(words('stopped')).toBe(
      'Stopped retrying. Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Changes are off until it’s back.',
    );
  });

  test('out-of-date is the stopped banner of a read-only page: no changes sentence, retries stopped', () => {
    expect(words('out-of-date')).toBe(
      'Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Retries stopped after 8 attempts.',
    );
    expect(words('out-of-date', { maxAttempts: 5 })).toContain('Retries stopped after 5 attempts.');
  });

  test('a read-only page leaves the changes sentence out of unreachable with consequence false', () => {
    expect(words('unreachable', { retryInSeconds: 8, attempt: 3, consequence: false })).toBe(
      'Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Retrying in 8 s (attempt 3 of 8).',
    );
  });

  test('refresh-failed does not say changes are off', () => {
    expect(words('refresh-failed')).toBe(
      'Couldn’t refresh this page. Showing what loaded as of 10:44 AM CST.',
    );
  });

  test('restarting never reuses the unreachable wording', () => {
    const copy = words('restarting');
    expect(copy).toBe(
      'Restarting Interborough. Your changes are saved. Running work picks up where it stopped; reviews stay waiting.',
    );
    expect(copy).not.toContain('reach');
    expect(copy).not.toContain('as of');
  });

  test('reconnecting counts its attempts', () => {
    expect(words('reconnecting', { attempt: 2 })).toBe(
      'Reconnecting… attempt 2 of 8. Your changes are saved. Running work picks up where it stopped; reviews stay waiting.',
    );
    expect(bannerPresetCopy('reconnecting').title).toBe('Reconnecting…');
  });

  test('restart-failed', () => {
    expect(words('restart-failed')).toBe(
      'Interborough didn’t come back. Your changes were saved first. Showing what loaded as of 10:44 AM CST. Changes are off until it’s back.',
    );
  });

  test('back-online is plain words with no lead', () => {
    expect(bannerPresetCopy('back-online')).toEqual({ text: BANNER_BACK_ONLINE_COPY });
    expect(BANNER_BACK_ONLINE_COPY).toBe('Back online. Updated just now.');
  });

  test('every preset has a table row', () => {
    for (const preset of BANNER_PRESETS) expect(words(preset).length).toBeGreaterThan(0);
  });
});

describe('bannerPresetCopy: what a page may change', () => {
  test('subject completes "Showing … as of …"', () => {
    expect(words('unreachable', { subject: 'reviews', retryInSeconds: 4, attempt: 3 })).toContain(
      'Showing reviews as of 10:44 AM CST.',
    );
    expect(words('unreachable', { subject: 'this schedule' })).toContain(
      'Showing this schedule as of',
    );
  });

  test('a consequence replaces the preset sentence, and false leaves it out', () => {
    expect(
      words('offline', {
        subject: 'runs',
        consequence: 'Start run is off until the connection is back.',
      }),
    ).toBe(
      'You’re offline. Showing runs as of 10:44 AM CST. Start run is off until the connection is back.',
    );
    expect(words('unreachable', { consequence: false, retryInSeconds: 8, attempt: 3 })).toBe(
      'Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Retrying in 8 s (attempt 3 of 8).',
    );
  });

  test('a retries-stopped sentence fits the unreachable preset', () => {
    expect(words('unreachable', { consequence: 'Retries stopped after 8 attempts.' })).toBe(
      'Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Retries stopped after 8 attempts.',
    );
  });

  test('a refresh failure can count down and name what is off', () => {
    expect(
      words('refresh-failed', {
        title: 'Couldn’t refresh memories',
        subject: 'the list',
        retryInSeconds: 8,
        consequence: 'Adding, correcting and forgetting are off until it refreshes.',
      }),
    ).toBe(
      'Couldn’t refresh memories Showing the list as of 10:44 AM CST. Retrying in 8 s. Adding, correcting and forgetting are off until it refreshes.',
    );
  });

  test('leaves out the as-of sentence when no time is known', () => {
    expect(bannerPresetCopy('unreachable').text).toBe('Changes are off until it’s back.');
  });

  test('counts attempts to a different total', () => {
    expect(words('unreachable', { retryInSeconds: 1, attempt: 1, maxAttempts: 5 })).toContain(
      '(attempt 1 of 5)',
    );
  });

  test('never prints a negative or fractional countdown', () => {
    expect(words('offline', { retryInSeconds: -2 })).toContain('Retrying in 0 s.');
    expect(words('offline', { retryInSeconds: 3.2 })).toContain('Retrying in 4 s.');
  });
});
