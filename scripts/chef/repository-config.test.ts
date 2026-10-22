import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIGURATION_PATH,
  expandHome,
  loadRepositoryConfig,
  run,
  UsageError,
  validateRepositoryConfig,
} from './repository-config.ts';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'repository-config-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function valid(): Record<string, unknown> {
  return {
    repository: 'owner/name',
    defaultBranch: 'main',
    worktreeRoots: { claude: '/roots/claude', codex: '/roots/codex' },
    manifestName: 'name',
    installCommand: 'bun install',
    gateCommand: 'bun run validate',
    affectedCheckCommand: 'bun run check',
    mergeMethod: 'squash',
  };
}

function expectInvalid(change: (value: Record<string, unknown>) => void, message: string) {
  const value = valid();
  change(value);
  expect(() => validateRepositoryConfig(value, 'cfg')).toThrow(UsageError);
  expect(() => validateRepositoryConfig(value, 'cfg')).toThrow(message);
}

describe('validateRepositoryConfig', () => {
  test('accepts a complete configuration, with and without the optional fields', () => {
    expect(validateRepositoryConfig(valid()).gateWrapper).toBeUndefined();
    const full = { ...valid(), gateWrapper: 'caffeinate -ims', lockPattern: '^bun ' };
    const config = validateRepositoryConfig(full);
    expect(config.gateWrapper).toBe('caffeinate -ims');
    expect(config.lockPattern).toBe('^bun ');
  });

  test('names each invalid field', () => {
    expectInvalid((value) => delete value.repository, '"repository"');
    expectInvalid((value) => (value.repository = 'no-slash'), 'owner/name');
    expectInvalid((value) => (value.defaultBranch = ''), '"defaultBranch"');
    expectInvalid((value) => (value.checkout = '/somewhere'), 'unknown field "checkout"');
    expectInvalid((value) => (value.worktreeRoots = []), '"worktreeRoots"');
    expectInvalid((value) => (value.worktreeRoots = { claude: '/a' }), '"codex"');
    expectInvalid((value) => (value.worktreeRoots = { claude: '/a', codex: 'b' }), 'absolute path');
    expectInvalid(
      (value) => (value.worktreeRoots = { claude: '/a', codex: '/b', other: '/c' }),
      'not a known provider',
    );
    expectInvalid((value) => (value.manifestName = 3), '"manifestName"');
    expectInvalid((value) => delete value.installCommand, '"installCommand"');
    expectInvalid((value) => delete value.gateCommand, '"gateCommand"');
    expectInvalid((value) => delete value.affectedCheckCommand, '"affectedCheckCommand"');
    expectInvalid((value) => (value.mergeMethod = 'fast-forward'), 'squash, merge, rebase');
    expectInvalid((value) => (value.gateWrapper = ''), '"gateWrapper"');
    expectInvalid((value) => (value.lockPattern = '('), 'valid regular expression');
  });

  test('rejects an unknown field so a typo cannot pass silently', () => {
    expectInvalid((value) => (value.gateComand = 'x'), 'unknown field "gateComand"');
  });

  test('rejects a non-object', () => {
    expect(() => validateRepositoryConfig([])).toThrow(UsageError);
    expect(() => validateRepositoryConfig(null)).toThrow(UsageError);
  });
});

describe('loadRepositoryConfig', () => {
  test('reads a file, and rejects a missing or malformed one', () => {
    const path = join(sandbox, 'config.json');
    writeFileSync(path, JSON.stringify(valid()));
    expect(loadRepositoryConfig(path).repository).toBe('owner/name');
    expect(() => loadRepositoryConfig(join(sandbox, 'missing.json'))).toThrow('No such');
    writeFileSync(path, '{ nope');
    expect(() => loadRepositoryConfig(path)).toThrow('not valid JSON');
  });

  test('the shipped corvidae configuration is valid', () => {
    const config = loadRepositoryConfig();
    expect(DEFAULT_CONFIGURATION_PATH).toBe(join(import.meta.dir, 'repository.json'));
    // Portable: no account name, no personal path, and the main checkout is not configured.
    const raw = readFileSync(DEFAULT_CONFIGURATION_PATH, 'utf8');
    expect(raw).not.toContain('/Users/');
    expect(raw).toContain('"~/.agent-worktrees/claude/corvidae"');
    expect(raw).not.toContain('"checkout"');
    expect(config.worktreeRoots.claude).toBe(join(homedir(), '.agent-worktrees/claude/corvidae'));
    expect(config.worktreeRoots.codex).toBe(join(homedir(), '.agent-worktrees/codex/corvidae'));
    expect(config.repository).toBe('stevekinney/corvidae');
    expect(config.mergeMethod).toBe('squash');
    expect(
      new RegExp(config.lockPattern ?? '').test('bun /x/scripts/run-exclusively.ts validate'),
    ).toBe(true);
  });
});

describe('home expansion', () => {
  test('expands a leading ~ in a worktree root, and nothing else', () => {
    const value = {
      ...valid(),
      worktreeRoots: { claude: '~/roots/claude', codex: '/roots/~/codex' },
    };
    const config = validateRepositoryConfig(value, 'cfg', '/home/someone');
    expect(config.worktreeRoots).toEqual({
      claude: '/home/someone/roots/claude',
      codex: '/roots/~/codex',
    });
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~other/x', '/h')).toBe('~other/x');
  });

  test('a ~ that does not lead a root still has to be absolute', () => {
    const value = { ...valid(), worktreeRoots: { claude: 'roots/~', codex: '/b' } };
    expect(() => validateRepositoryConfig(value, 'cfg', '/h')).toThrow('absolute path');
  });
});

describe('run', () => {
  test('prints the validated configuration, and needs exactly one path', () => {
    const path = join(sandbox, 'config.json');
    writeFileSync(path, JSON.stringify(valid()));
    const result = run([path]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).manifestName).toBe('name');
    expect(() => run(['a', 'b'])).toThrow(UsageError);
    expect(run([]).code).toBe(0);
  });
});
