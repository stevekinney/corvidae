import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { openAtRoot, openBungalow, openTemporaryBungalow, resolveOpenRoot } from './bungalow.ts';
import { processEnvironment } from './environment-configuration.ts';
import {
  BungalowFilesystemError,
  BungalowInputError,
  BungalowLockedError,
  BungalowStateError,
} from './errors.ts';
import {
  homeEnvironment,
  TEST_HOME_VARIABLE,
  TEST_NAME,
  useTemporaryDirectories,
} from './fixtures.test-support.ts';
import { isUlid } from './ulid.ts';

const temporaryDirectory = useTemporaryDirectories();

// Mode assertions mean nothing under an arbitrary inherited umask, so fix one for this file.
const originalUmask = process.umask(0o022);
afterAll(() => {
  process.umask(originalUmask);
});

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
    expect(() => openIn(root)).toThrow(BungalowLockedError);
    handle.close();
    expect(() => handle.close()).not.toThrow();

    // A later handle holds the lock now; the first handle's repeated close must not release it.
    using second = openIn(root);
    handle.close();
    expect(() => openIn(root)).toThrow(BungalowLockedError);
    expect(second.root).toBe(root);
  });

  test('makes every later use throw BungalowStateError', () => {
    const handle = openIn(temporaryDirectory());
    handle.close();
    expect(() => handle.directory('agents')).toThrow(BungalowStateError);
    expect(() => handle.writeSecret('token', 'value')).toThrow(BungalowStateError);
    expect(() => handle.readSecret('token')).toThrow(BungalowStateError);
  });

  test('can be retried after the lock fails to release, and releases once it succeeds', () => {
    let releases = 0;
    const handle = openAtRoot(TEST_NAME, temporaryDirectory(), {
      acquireLock: () => ({
        release: () => {
          releases += 1;
          if (releases === 1) throw new BungalowFilesystemError('Could not release the lock file.');
        },
      }),
    });
    expect(() => handle.close()).toThrow(BungalowFilesystemError);
    // The root is still in use: the failed release did not end the handle.
    handle.writeSecret('token', 'still open');
    expect(handle.readSecret('token')).toBe('still open');

    handle.close();
    expect(releases).toBe(2);
    expect(() => handle.readSecret('token')).toThrow(BungalowStateError);
    handle.close();
    expect(releases).toBe(2);
  });

  test('a temporary Bungalow keeps its root until the release has succeeded', () => {
    const root = temporaryDirectory();
    let removed = 0;
    let fail = true;
    const handle = openAtRoot(TEST_NAME, root, {
      acquireLock: () => ({
        release: () => {
          if (fail) throw new BungalowFilesystemError('Could not release the lock file.');
        },
      }),
      onClose: () => {
        removed += 1;
      },
    });
    expect(() => handle.close()).toThrow(BungalowFilesystemError);
    expect(removed).toBe(0);
    fail = false;
    handle.close();
    expect(removed).toBe(1);
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

  test('cannot be bypassed by passing an environment that says nothing about NODE_ENV', () => {
    const home = temporaryDirectory();
    expect(() => openBungalow({ name: TEST_NAME, environment: {} })).toThrow(BungalowInputError);
    expect(() => openBungalow({ name: TEST_NAME, environment: {}, homeDirectory: home })).toThrow(
      BungalowInputError,
    );
    expect(readdirSync(home)).toEqual([]);
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

describe('resolveOpenRoot', () => {
  test("defaults the home directory to the operating system's, without opening anything", () => {
    expect(resolveOpenRoot({ name: TEST_NAME, environment: {} })).toBe(
      join(homedir(), `.${TEST_NAME}`),
    );
  });

  test('uses an injected home directory, and <NAME>_HOME over either', () => {
    expect(resolveOpenRoot({ name: TEST_NAME, environment: {}, homeDirectory: '/h' })).toBe(
      `/h/.${TEST_NAME}`,
    );
    expect(
      resolveOpenRoot({
        name: TEST_NAME,
        environment: homeEnvironment('/srv/root'),
        homeDirectory: '/h',
      }),
    ).toBe('/srv/root');
  });
});

describe('a root that already exists', () => {
  test('is tightened to 0700, along with its secrets directory', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'secrets'), { mode: 0o755 });
    chmodSync(root, 0o755);
    chmodSync(join(root, 'secrets'), 0o755);
    using handle = openIn(root);
    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(handle.secrets)).toBe(0o700);
  });

  test('has a secret that group or others can read tightened to 0600 before it is read', () => {
    const root = temporaryDirectory();
    openIn(root).close();
    const path = join(root, 'secrets', 'token');
    writeFileSync(path, 'loose');
    chmodSync(path, 0o644);
    using handle = openIn(root);
    expect(handle.readSecret('token')).toBe('loose');
    expect(modeOf(path)).toBe(0o600);
  });

  test('refuses a stored secret that is not a regular file, without changing its mode', () => {
    using handle = openIn(temporaryDirectory());
    const path = join(handle.secrets, 'blocked');
    mkdirSync(path, { mode: 0o755 });
    expect(() => handle.readSecret('blocked')).toThrow(BungalowStateError);
    expect(modeOf(path)).toBe(0o755);
  });

  test('has the temporary files a crash left behind removed, and only those', () => {
    const root = temporaryDirectory();
    openIn(root).close();
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const leftovers = [
      join(root, `deployment-id.4242-${uuid}.tmp`),
      join(root, 'secrets', `token.4242-${uuid}.tmp`),
    ];
    const kept = [join(root, 'notes.tmp'), join(root, 'secrets', 'token')];
    for (const path of [...leftovers, ...kept]) writeFileSync(path, 'x');
    using handle = openIn(root);
    expect(handle.root).toBe(root);
    for (const path of leftovers) expect(existsSync(path), path).toBe(false);
    for (const path of kept) expect(existsSync(path), path).toBe(true);
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
