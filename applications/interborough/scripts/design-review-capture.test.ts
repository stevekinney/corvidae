/**
 * The design-review capture's command line (`scripts/design-review-capture.ts`): the defaults that
 * a sweep relies on, the narrowing a sign-off uses, and the refusals that keep a typo from
 * silently capturing the wrong thing.
 */
import { describe, expect, test } from 'bun:test';

import { parseArguments, portIsFree } from './design-review-capture.ts';

const NOW = new Date('2026-11-02T08:30:00.000Z');

describe('parseArguments', () => {
  test('captures all three specifications in both schemes into a time-stamped directory by default', () => {
    const options = parseArguments([], NOW);
    if (typeof options === 'string') throw new Error(options);
    expect(options.schemes).toEqual(['light', 'dark']);
    expect(options.specifications).toEqual([
      'tests/e2e/showcase.spec.ts',
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

  test('chooses the content with --data: showcase alone, the stress seed alone, or both', () => {
    const specificationsOf = (argv: string[]) => {
      const options = parseArguments(argv, NOW);
      if (typeof options === 'string') throw new Error(options);
      return options.specifications;
    };
    expect(specificationsOf(['--data', 'showcase'])).toEqual(['tests/e2e/showcase.spec.ts']);
    expect(specificationsOf(['--data', 'stress'])).toEqual([
      'tests/e2e/responsive.spec.ts',
      'tests/e2e/15-view-states.spec.ts',
    ]);
    expect(specificationsOf(['--data', 'both'])).toEqual(specificationsOf([]));
    expect(specificationsOf(['--data', 'stress', '--specs', 'states'])).toEqual([
      'tests/e2e/15-view-states.spec.ts',
    ]);
    expect(specificationsOf(['--specs', 'responsive', '--data', 'both'])).toEqual([
      'tests/e2e/showcase.spec.ts',
      'tests/e2e/responsive.spec.ts',
    ]);
    // `--specs` alone keeps meaning what it always meant: one of the stress specifications.
    expect(specificationsOf(['--specs', 'responsive'])).toEqual(['tests/e2e/responsive.spec.ts']);
  });

  test('refuses an unknown --data, and --specs with showcase data, which it would silently ignore', () => {
    expect(parseArguments(['--data', 'realistic'], NOW)).toBe(
      '--data must be showcase, stress or both, not "realistic"',
    );
    expect(parseArguments(['--data'], NOW)).toBe('--data needs a value');
    expect(parseArguments(['--data', 'showcase', '--specs', 'states'], NOW)).toContain(
      'cannot be used with --data showcase',
    );
    expect(parseArguments(['--specs', 'states', '--data', 'showcase'], NOW)).toContain(
      'cannot be used with --data showcase',
    );
  });

  test('refuses an unknown scheme, an unknown specification, an unknown flag and a missing value', () => {
    expect(parseArguments(['--scheme', 'purple'], NOW)).toContain('--scheme must be');
    expect(parseArguments(['--specs', 'everything'], NOW)).toContain('--specs must be');
    expect(parseArguments(['--color', 'dark'], NOW)).toBe('unknown flag --color');
    expect(parseArguments(['--grep'], NOW)).toBe('--grep needs a value');
    expect(parseArguments(['--out', '--scheme', 'dark'], NOW)).toBe('--out needs a value');
  });
});

describe('portIsFree', () => {
  test('answers false for a port something already listens on, and true once it is released', () => {
    const holder = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = holder.port;
    try {
      expect(portIsFree(port)).toBe(false);
    } finally {
      holder.stop(true);
    }
    expect(portIsFree(port)).toBe(true);
  });
});
