import { describe, expect, test } from 'bun:test';

import { BungalowInputError } from './errors.ts';
import { bungalowHomeVariable, resolveBungalowRoot } from './resolve-root.ts';

describe('resolveBungalowRoot', () => {
  test('returns <NAME>_HOME when it is set and non-empty', () => {
    expect(
      resolveBungalowRoot({
        name: 'interborough',
        environment: { INTERBOROUGH_HOME: '/srv/interborough' },
        homeDirectory: '/home/steve',
      }),
    ).toBe('/srv/interborough');
  });

  test('turns hyphens into underscores in the variable name', () => {
    expect(bungalowHomeVariable('agent-bureau')).toBe('AGENT_BUREAU_HOME');
    expect(
      resolveBungalowRoot({
        name: 'agent-bureau',
        environment: { AGENT_BUREAU_HOME: '/srv/bureau' },
        homeDirectory: '/home/steve',
      }),
    ).toBe('/srv/bureau');
  });

  test.each([{}, { INTERBOROUGH_HOME: '' }])(
    'falls back to <homeDirectory>/.<name> when the variable is %p',
    (environment) => {
      expect(
        resolveBungalowRoot({
          name: 'interborough',
          environment,
          homeDirectory: '/home/steve',
        }),
      ).toBe('/home/steve/.interborough');
    },
  );

  test('ignores the variables of other applications', () => {
    expect(
      resolveBungalowRoot({
        name: 'interborough',
        environment: { OTHER_HOME: '/elsewhere' },
        homeDirectory: '/home/steve/',
      }),
    ).toBe('/home/steve/.interborough');
  });

  test('is pure: it creates nothing', async () => {
    const root = resolveBungalowRoot({
      name: 'interborough',
      environment: {},
      homeDirectory: '/definitely/not/a/real/home',
    });
    expect(await Bun.file(root).exists()).toBe(false);
    expect(await Bun.file('/definitely').exists()).toBe(false);
  });

  test('rejects a relative override or home directory', () => {
    expect(() =>
      resolveBungalowRoot({
        name: 'interborough',
        environment: { INTERBOROUGH_HOME: 'relative/path' },
        homeDirectory: '/home/steve',
      }),
    ).toThrow(BungalowInputError);
    expect(() =>
      resolveBungalowRoot({ name: 'interborough', environment: {}, homeDirectory: 'home' }),
    ).toThrow(BungalowInputError);
  });

  test('rejects an invalid name before reading the environment', () => {
    expect(() =>
      resolveBungalowRoot({ name: '../x', environment: {}, homeDirectory: '/home/steve' }),
    ).toThrow(BungalowInputError);
  });
});
