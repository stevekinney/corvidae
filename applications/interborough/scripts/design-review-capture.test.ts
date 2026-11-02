/**
 * The design-review capture's command line (`scripts/design-review-capture.ts`): the defaults that
 * a sweep relies on, the narrowing a sign-off uses, and the refusals that keep a typo from
 * silently capturing the wrong thing.
 */
import { describe, expect, test } from 'bun:test';

import { parseArguments } from './design-review-capture.ts';

const NOW = new Date('2026-11-02T08:30:00.000Z');

describe('parseArguments', () => {
  test('captures both specifications in both schemes into a time-stamped directory by default', () => {
    const options = parseArguments([], NOW);
    if (typeof options === 'string') throw new Error(options);
    expect(options.schemes).toEqual(['light', 'dark']);
    expect(options.specifications).toEqual([
      'tests/e2e/responsive.spec.ts',
      'tests/e2e/15-view-states.spec.ts',
    ]);
    expect(options.grep).toBeUndefined();
    expect(options.out).toEndWith('/tmp/design-review/2026-11-02T08-30-00-000Z');
  });

  test('narrows to one scheme, one specification and a title filter for a sign-off', () => {
    const options = parseArguments(
      ['--scheme', 'dark', '--specs', 'states', '--grep', 'schedules is', '--out', 'here'],
      NOW,
    );
    if (typeof options === 'string') throw new Error(options);
    expect(options.schemes).toEqual(['dark']);
    expect(options.specifications).toEqual(['tests/e2e/15-view-states.spec.ts']);
    expect(options.grep).toBe('schedules is');
    expect(options.out).toEndWith('/here');
  });

  test('refuses an unknown scheme, an unknown specification, an unknown flag and a missing value', () => {
    expect(parseArguments(['--scheme', 'purple'], NOW)).toContain('--scheme must be');
    expect(parseArguments(['--specs', 'everything'], NOW)).toContain('--specs must be');
    expect(parseArguments(['--color', 'dark'], NOW)).toBe('unknown flag --color');
    expect(parseArguments(['--grep'], NOW)).toBe('--grep needs a value');
    expect(parseArguments(['--out', '--scheme', 'dark'], NOW)).toBe('--out needs a value');
  });
});
