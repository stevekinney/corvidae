import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { openBungalow, openTemporaryBungalow } from './bungalow.ts';
import { processEnvironment } from './environment-configuration.ts';
import { BungalowInputError, BungalowStateError } from './errors.ts';
import {
  homeEnvironment,
  TEST_HOME_VARIABLE,
  TEST_NAME,
  useTemporaryDirectories,
} from './fixtures.test-support.ts';
import { isUlid } from './ulid.ts';

const temporaryDirectory = useTemporaryDirectories();

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function openIn(root: string) {
  return openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
}

describe('openBungalow layout', () => {
  test('creates the root 0700 with secrets (0700) and logs, and no database or configuration', () => {
    const root = join(temporaryDirectory(), 'home');
    using handle = openIn(root);
    expect(handle.root).toBe(root);
    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(handle.secrets)).toBe(0o700);
    expect(statSync(handle.logs).isDirectory()).toBe(true);
    expect(handle.secrets).toBe(join(root, 'secrets'));
    expect(handle.logs).toBe(join(root, 'logs'));
    expect(handle.database).toBe(join(root, 'database.sqlite'));
    expect(handle.configuration).toBe(join(root, 'configuration.json'));
    expect(existsSync(handle.database)).toBe(false);
    expect(existsSync(handle.configuration)).toBe(false);
    expect(readdirSync(root).toSorted()).toEqual(['deployment-id', 'lock', 'logs', 'secrets']);
  });

  test('uses the home directory when the override is unset and NODE_ENV is not test', () => {
    const home = temporaryDirectory();
    using handle = openBungalow({ name: TEST_NAME, environment: {}, homeDirectory: home });
    expect(handle.root).toBe(join(home, `.${TEST_NAME}`));
    expect(modeOf(handle.root)).toBe(0o700);
  });

  test('reopens an existing root without altering what is in it', () => {
    const root = temporaryDirectory();
    openIn(root).close();
    writeFileSync(join(root, 'configuration.json'), '{}');
    using handle = openIn(root);
    expect(readFileSync(handle.configuration, 'utf8')).toBe('{}');
  });

  test('rejects an invalid name', () => {
    expect(() => openBungalow({ name: '../x', environment: {} })).toThrow(BungalowInputError);
  });
});

describe('directory', () => {
  test('creates <root>/<name> with mode 0700 and returns its absolute path', () => {
    const root = temporaryDirectory();
    using handle = openIn(root);
    const agents = handle.directory('agents');
    expect(agents).toBe(join(root, 'agents'));
    expect(modeOf(agents)).toBe(0o700);
  });

  test('returns an existing directory without touching its contents', () => {
    using handle = openIn(temporaryDirectory());
    const workflows = handle.directory('workflows');
    writeFileSync(join(workflows, 'one.md'), 'one');
    expect(handle.directory('workflows')).toBe(workflows);
    expect(readFileSync(join(workflows, 'one.md'), 'utf8')).toBe('one');
  });

  test.each(['../x', 'Agents', '', 'a/b', 'secrets', 'logs', 'lock', 'deployment-id'])(
    'rejects %p with BungalowInputError',
    (name) => {
      using handle = openIn(temporaryDirectory());
      expect(() => handle.directory(name)).toThrow(BungalowInputError);
    },
  );
});

describe('deploymentId', () => {
  test('is a ULID, persisted at deployment-id, and identical on reopen', () => {
    const root = temporaryDirectory();
    const first = openIn(root);
    const identifier = first.deploymentId;
    first.close();
    expect(identifier).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(readFileSync(join(root, 'deployment-id'), 'utf8').trim()).toBe(identifier);
    expect(modeOf(join(root, 'deployment-id'))).toBe(0o600);

    using second = openIn(root);
    expect(second.deploymentId).toBe(identifier);
  });

  test('differs between roots', () => {
    using first = openIn(temporaryDirectory());
    using second = openIn(temporaryDirectory());
    expect(first.deploymentId).not.toBe(second.deploymentId);
  });

  test('refuses a corrupt identifier instead of silently replacing the deployment identity', () => {
    const root = temporaryDirectory();
    openIn(root).close();
    writeFileSync(join(root, 'deployment-id'), 'not-a-ulid\n');
    expect(() => openIn(root)).toThrow(BungalowStateError);
    // The failed open released its lock, so a repaired file opens.
    writeFileSync(join(root, 'deployment-id'), '01ARYZ6S41TSV4RRFFQ69G5FAV\n');
    using handle = openIn(root);
    expect(handle.deploymentId).toBe('01ARYZ6S41TSV4RRFFQ69G5FAV');
  });
});

describe('secrets', () => {
  test('stores each secret in its own 0600 file and reads it back verbatim', () => {
    using handle = openIn(temporaryDirectory());
    handle.writeSecret('api-key', 'line one\nline two ');
    handle.writeSecret('token', 'second');
    expect(handle.readSecret('api-key')).toBe('line one\nline two ');
    expect(handle.readSecret('token')).toBe('second');
    expect(modeOf(join(handle.secrets, 'api-key'))).toBe(0o600);
    expect(modeOf(join(handle.secrets, 'token'))).toBe(0o600);
    expect(readdirSync(handle.secrets).toSorted()).toEqual(['api-key', 'token']);
  });

  test('returns undefined for a missing key', () => {
    using handle = openIn(temporaryDirectory());
    expect(handle.readSecret('missing')).toBeUndefined();
  });

  test('replaces an earlier value, leaving no temporary file behind', () => {
    using handle = openIn(temporaryDirectory());
    handle.writeSecret('token', 'first');
    handle.writeSecret('token', 'second');
    expect(handle.readSecret('token')).toBe('second');
    expect(readdirSync(handle.secrets)).toEqual(['token']);
    expect(modeOf(join(handle.secrets, 'token'))).toBe(0o600);
  });

  test('stores an empty value distinctly from a missing key', () => {
    using handle = openIn(temporaryDirectory());
    handle.writeSecret('blank', '');
    expect(handle.readSecret('blank')).toBe('');
  });

  test('persists across reopen', () => {
    const root = temporaryDirectory();
    const first = openIn(root);
    first.writeSecret('token', 'kept');
    first.close();
    using second = openIn(root);
    expect(second.readSecret('token')).toBe('kept');
  });

  test.each(['../x', 'Key', '', 'a.b', '-a'])('rejects the key %p', (key) => {
    using handle = openIn(temporaryDirectory());
    expect(() => handle.writeSecret(key, 'value')).toThrow(BungalowInputError);
    expect(() => handle.readSecret(key)).toThrow(BungalowInputError);
  });
});

describe('close', () => {
  test('is idempotent and releases the lock', () => {
    const root = temporaryDirectory();
    const handle = openIn(root);
    expect(existsSync(join(root, 'lock'))).toBe(true);
    handle.close();
    expect(existsSync(join(root, 'lock'))).toBe(false);
    expect(() => handle.close()).not.toThrow();

    // A later handle holds the lock now; the first handle's repeated close must not release it.
    using second = openIn(root);
    handle.close();
    expect(readFileSync(join(root, 'lock'), 'utf8')).toBe(`${process.pid}\n`);
    expect(second.root).toBe(root);
  });

  test('makes every later use throw BungalowStateError', () => {
    const handle = openIn(temporaryDirectory());
    handle.close();
    expect(() => handle.directory('agents')).toThrow(BungalowStateError);
    expect(() => handle.writeSecret('token', 'value')).toThrow(BungalowStateError);
    expect(() => handle.readSecret('token')).toThrow(BungalowStateError);
  });
});

describe('NODE_ENV=test guard', () => {
  test('refuses to open the real home directory when <NAME>_HOME is unset or empty', () => {
    const home = temporaryDirectory();
    for (const environment of [
      { NODE_ENV: 'test' },
      { NODE_ENV: 'test', [TEST_HOME_VARIABLE]: '' },
    ]) {
      expect(() => openBungalow({ name: TEST_NAME, environment, homeDirectory: home })).toThrow(
        BungalowInputError,
      );
    }
    expect(readdirSync(home)).toEqual([]);
  });

  test('applies to the process environment by default, where bun test sets NODE_ENV to test', () => {
    expect(processEnvironment()['NODE_ENV']).toBe('test');
    expect(processEnvironment()[TEST_HOME_VARIABLE]).toBeUndefined();
    expect(() => openBungalow({ name: TEST_NAME })).toThrow(BungalowInputError);
  });

  test('allows an explicit <NAME>_HOME under test', () => {
    const root = temporaryDirectory();
    using handle = openBungalow({
      name: TEST_NAME,
      environment: { NODE_ENV: 'test', ...homeEnvironment(root) },
    });
    expect(handle.root).toBe(root);
  });
});

describe('openTemporaryBungalow', () => {
  test('creates an isolated root under the temporary directory and removes it on close', () => {
    const handle = openTemporaryBungalow({ name: TEST_NAME });
    const root = handle.root;
    try {
      expect(root.startsWith(tmpdir())).toBe(true);
      expect(modeOf(root)).toBe(0o700);
      handle.writeSecret('token', 'value');
      expect(handle.readSecret('token')).toBe('value');
      expect(isUlid(handle.deploymentId)).toBe(true);
    } finally {
      handle.close();
    }
    expect(existsSync(root)).toBe(false);
    expect(() => handle.close()).not.toThrow();
  });

  test('gives each call its own root', () => {
    using first = openTemporaryBungalow({ name: TEST_NAME });
    using second = openTemporaryBungalow({ name: TEST_NAME });
    expect(first.root).not.toBe(second.root);
    expect(first.deploymentId).not.toBe(second.deploymentId);
  });

  test('rejects an invalid name', () => {
    expect(() => openTemporaryBungalow({ name: '../x' })).toThrow(BungalowInputError);
  });
});
