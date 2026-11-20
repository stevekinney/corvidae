/**
 * What a linked git worktree derives (COR-2540): a home under its own `tmp/` and a free port, in a
 * linked worktree only, and each only where the person has not set its variable. The git lookup is
 * replaced, so these read no checkout; `worktree-instances.integration.test.ts` runs the real git.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  deriveInstanceEnvironment,
  derivedInstanceMessage,
  linkedWorktreeRoot,
  worktreeHome,
  worktreeHomeFor,
  type GitReader,
} from './worktree-instance.ts';

const MAIN: GitReader = (directory) => ({
  gitDirectory: join(directory, '.git'),
  commonDirectory: join(directory, '.git'),
  topLevel: directory,
});

/** A linked worktree: its own git directory sits under the common one, as `git worktree add` makes it. */
const LINKED: GitReader = (directory) => ({
  gitDirectory: '/repository/.git/worktrees/feature',
  commonDirectory: '/repository/.git',
  topLevel: directory,
});

const NOT_A_REPOSITORY: GitReader = () => undefined;

describe('linkedWorktreeRoot', () => {
  test('is the checkout root where --git-dir and --git-common-dir differ', () => {
    expect(linkedWorktreeRoot('/work/feature', LINKED)).toBe('/work/feature');
  });

  test('is undefined in the main checkout, where the two are the same directory', () => {
    expect(linkedWorktreeRoot('/work/main', MAIN)).toBeUndefined();
  });

  test('is undefined outside a repository and where git is not installed', () => {
    expect(linkedWorktreeRoot('/work/elsewhere', NOT_A_REPOSITORY)).toBeUndefined();
  });

  test('compares the directories, not the spelling of their paths', () => {
    const spelledTwice: GitReader = () => ({
      gitDirectory: '/repository/.git',
      commonDirectory: '/repository/./.git/',
      topLevel: '/repository',
    });
    expect(linkedWorktreeRoot('/repository', spelledTwice)).toBeUndefined();
  });
});

describe('deriveInstanceEnvironment', () => {
  const freePort = () => 54_321;

  test('gives a linked worktree a home under its tmp/ and a free port when neither variable is set', async () => {
    const { environment, derived } = await deriveInstanceEnvironment(
      { PATH: '/bin' },
      '/work/feature',
      freePort,
    );
    expect(environment).toEqual({
      PATH: '/bin',
      INTERBOROUGH_HOME: join('/work/feature', 'tmp', 'interborough-dev'),
      INTERBOROUGH_PORT: '54321',
    });
    expect(worktreeHome('/work/feature')).toBe(environment['INTERBOROUGH_HOME']!);
    expect(derived).toEqual({
      root: '/work/feature',
      home: join('/work/feature', 'tmp', 'interborough-dev'),
      port: 54_321,
    });
  });

  test('treats an empty variable as unset', async () => {
    const { environment } = await deriveInstanceEnvironment(
      { INTERBOROUGH_HOME: '', INTERBOROUGH_PORT: '' },
      '/work/feature',
      freePort,
    );
    expect(environment['INTERBOROUGH_PORT']).toBe('54321');
    expect(environment['INTERBOROUGH_HOME']).toBe(join('/work/feature', 'tmp', 'interborough-dev'));
  });

  test('leaves the main checkout alone: no home, no port, the same environment object back', async () => {
    const environment = { PATH: '/bin' };
    const result = await deriveInstanceEnvironment(environment, undefined, () => {
      throw new Error('The main checkout must not ask for a port.');
    });
    expect(result.environment).toBe(environment);
    expect(result.derived).toBeUndefined();
  });

  test('lets INTERBOROUGH_HOME win and still derives the port', async () => {
    const { environment, derived } = await deriveInstanceEnvironment(
      { INTERBOROUGH_HOME: '/data/home' },
      '/work/feature',
      freePort,
    );
    expect(environment['INTERBOROUGH_HOME']).toBe('/data/home');
    expect(environment['INTERBOROUGH_PORT']).toBe('54321');
    expect(derived).toEqual({ root: '/work/feature', port: 54_321 });
  });

  test('lets INTERBOROUGH_PORT win and still derives the home, without asking for a port', async () => {
    const { environment, derived } = await deriveInstanceEnvironment(
      { INTERBOROUGH_PORT: '7234' },
      '/work/feature',
      () => {
        throw new Error('A port the person set must not be replaced.');
      },
    );
    expect(environment['INTERBOROUGH_PORT']).toBe('7234');
    expect(environment['INTERBOROUGH_HOME']).toBe(join('/work/feature', 'tmp', 'interborough-dev'));
    expect(derived?.port).toBeUndefined();
  });

  test('derives only the port for the showcase host, which keeps a home of its own', async () => {
    const { environment, derived } = await deriveInstanceEnvironment(
      {},
      '/work/feature',
      freePort,
      {
        home: false,
      },
    );
    expect(environment).toEqual({ INTERBOROUGH_PORT: '54321' });
    expect(derived).toEqual({ root: '/work/feature', port: 54_321 });
  });

  test('derives nothing when both are set, in a linked worktree too', async () => {
    const environment = { INTERBOROUGH_HOME: '/data/home', INTERBOROUGH_PORT: '7234' };
    const result = await deriveInstanceEnvironment(environment, '/work/feature', freePort);
    expect(result.environment).toBe(environment);
    expect(result.derived).toBeUndefined();
  });
});

describe('derivedInstanceMessage', () => {
  test('names the worktree and each derived value, and how to choose another', () => {
    const message = derivedInstanceMessage({
      root: '/work/feature',
      home: '/work/feature/tmp/interborough-dev',
      port: 54_321,
    });
    expect(message).toContain('/work/feature is a linked git worktree');
    expect(message).toContain('its state lives in /work/feature/tmp/interborough-dev');
    expect(message).toContain('it listens on port 54321');
    expect(message).toContain('INTERBOROUGH_HOME or INTERBOROUGH_PORT');
  });

  test('names only what was derived', () => {
    const message = derivedInstanceMessage({ root: '/work/feature', port: 54_321 });
    expect(message).toContain('it listens on port 54321');
    expect(message).not.toContain('state lives');
  });
});

describe('worktreeHomeFor', () => {
  test('is the worktree’s derived home, or the absolute INTERBOROUGH_HOME the person set', () => {
    expect(worktreeHomeFor('/work/feature', {}, LINKED)).toBe(
      join('/work/feature', 'tmp', 'interborough-dev'),
    );
    expect(worktreeHomeFor('/work/feature', { INTERBOROUGH_HOME: '/data/home' }, LINKED)).toBe(
      '/data/home',
    );
  });

  test('is undefined in the main checkout, and for a relative INTERBOROUGH_HOME, which no host accepts', () => {
    expect(worktreeHomeFor('/work/main', {}, MAIN)).toBeUndefined();
    expect(worktreeHomeFor('/work/feature', { INTERBOROUGH_HOME: 'relative' }, LINKED)).toBe(
      undefined,
    );
  });
});
