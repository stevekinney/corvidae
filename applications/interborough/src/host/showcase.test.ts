/**
 * The showcase development host's pieces (`showcase.ts`): the flag, the home it defaults to, and
 * what it writes into that home so the demo plugin is on and the model picker has models.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  prepareShowcaseHome,
  SHOWCASE_FLAG,
  SHOWCASE_MODELS,
  showcaseEnvironment,
  splitShowcaseFlag,
} from './showcase.ts';

const scratch = await mkdtemp(join(tmpdir(), 'interborough-showcase-test-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('splitShowcaseFlag', () => {
  test('finds the flag anywhere and leaves the other arguments in order', () => {
    expect(splitShowcaseFlag([])).toEqual({ showcase: false, rest: [] });
    expect(splitShowcaseFlag(['--plugin', '/a', SHOWCASE_FLAG, '--plugin', '/b'])).toEqual({
      showcase: true,
      rest: ['--plugin', '/a', '--plugin', '/b'],
    });
  });
});

describe('showcaseEnvironment', () => {
  test('defaults the home to tmp/interborough-showcase in the repository, and keeps the rest', () => {
    const environment = showcaseEnvironment({ INTERBOROUGH_PORT: '7000' }, '/repository');
    expect(environment['INTERBOROUGH_HOME']).toBe('/repository/tmp/interborough-showcase');
    expect(environment['INTERBOROUGH_PORT']).toBe('7000');
    expect(showcaseEnvironment({ INTERBOROUGH_HOME: '' }, '/repository')['INTERBOROUGH_HOME']).toBe(
      '/repository/tmp/interborough-showcase',
    );
  });

  test('keeps a home that is already set, so a person chooses where the content goes', () => {
    const environment = { INTERBOROUGH_HOME: '/somewhere/else' };
    expect(showcaseEnvironment(environment, '/repository')).toBe(environment);
  });
});

describe('prepareShowcaseHome', () => {
  test('turns the demo plugin on and gives the anthropic provider its models, and is safe to repeat', async () => {
    const home = join(scratch, 'home');
    await prepareShowcaseHome(home);
    await prepareShowcaseHome(home);
    const document = JSON.parse(await readFile(join(home, 'configuration.json'), 'utf8')) as {
      plugins: Record<string, { enabled?: boolean; configuration?: { models: string[] } }>;
    };
    expect(document.plugins['demo']?.enabled).toBe(true);
    expect(document.plugins['anthropic']?.configuration?.models).toEqual([...SHOWCASE_MODELS]);
  });
});
