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
import { dirname, isAbsolute, join } from 'node:path';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterAll, describe, expect, test } from 'bun:test';

import {
  absoluteTemporaryDirectory,
  openAtRoot,
  openBungalow,
  openTemporaryBungalow,
  resolveOpenRoot,
} from './bungalow.ts';
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

/** Open the root and release it again, so the next open starts from a cleanly closed root. */
async function openAndClose(root: string): Promise<void> {
  const handle = await openIn(root);
  handle.close();
}

describe('openBungalow layout', () => {
  test('creates the root 0700 with secrets (0700) and logs, and no database or configuration', async () => {
    const root = join(temporaryDirectory(), 'home');
    using handle = await openIn(root);
    expect(handle.mode).toBe('local');
    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(join(root, 'secrets'))).toBe(0o700);
    expect(statSync(join(root, 'logs')).isDirectory()).toBe(true);
    expect(handle.logs).toBe(join(root, 'logs'));
    expect(handle.database).toEqual({ kind: 'sqlite', path: join(root, 'database.sqlite') });
    expect(handle.configurationLocation).toBe(join(root, 'configuration.json'));
    expect(handle.deploymentSecrets.location('api-key')).toBe(join(root, 'secrets', 'api-key'));
    expect(existsSync(join(root, 'database.sqlite'))).toBe(false);
    expect(existsSync(handle.configurationLocation)).toBe(false);
    const configurationSnapshot1 = await handle.readConfiguration();
    expect(configurationSnapshot1.text).toBeUndefined();
    expect(readdirSync(root).toSorted()).toEqual([
      '.managed-secrets',
      'deployment-id',
      'lock',
      'logs',
      'secrets',
      'workspace-id',
    ]);
  });

  test('reopens an existing root without altering what is in it', async () => {
    const root = temporaryDirectory();
    await openAndClose(root);
    writeFileSync(join(root, 'configuration.json'), '{}');
    using handle = await openIn(root);
    const configurationSnapshot2 = await handle.readConfiguration();
    expect(configurationSnapshot2.text).toBe('{}');
  });

  test('rejects an invalid name', async () => {
    expect(await throwingRejectionOf(openBungalow({ name: '../x', environment: {} }))).toThrow(
      BungalowInputError,
    );
  });
});

describe('content', () => {
  test('creates <root>/<name> with mode 0700 and returns its absolute path', async () => {
    const root = temporaryDirectory();
    using handle = await openIn(root);
    const agents = handle.content('agents');
    expect(agents).toEqual({ kind: 'directory', path: join(root, 'agents') });
    expect(modeOf(join(root, 'agents'))).toBe(0o700);
  });

  test('returns an existing directory without touching its contents', async () => {
    using handle = await openIn(temporaryDirectory());
    const workflows = handle.content('workflows');
    if (workflows.kind !== 'directory') throw new Error('Expected a directory.');
    writeFileSync(join(workflows.path, 'one.md'), 'one');
    expect(handle.content('workflows')).toEqual(workflows);
    expect(readFileSync(join(workflows.path, 'one.md'), 'utf8')).toBe('one');
  });

  test.each(['../x', 'Agents', '', 'a/b', 'secrets', 'logs', 'lock', 'deployment-id'])(
    'rejects %p with BungalowInputError',
    async (name) => {
      using handle = await openIn(temporaryDirectory());
      expect(() => handle.content(name)).toThrow(BungalowInputError);
    },
  );
});

describe('deploymentId', () => {
  test('is a ULID, persisted at deployment-id, and identical on reopen', async () => {
    const root = temporaryDirectory();
    const first = await openIn(root);
    const identifier = first.deploymentId;
    first.close();
    expect(identifier).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(readFileSync(join(root, 'deployment-id'), 'utf8').trim()).toBe(identifier);
    expect(readFileSync(join(root, 'workspace-id'), 'utf8').trim()).toBe(identifier);
    expect(modeOf(join(root, 'deployment-id'))).toBe(0o600);

    using second = await openIn(root);
    expect(second.deploymentId).toBe(identifier);
  });

  test('differs between roots', async () => {
    using first = await openIn(temporaryDirectory());
    using second = await openIn(temporaryDirectory());
    expect(first.deploymentId).not.toBe(second.deploymentId);
  });

  test('refuses a corrupt identifier instead of silently replacing the deployment identity', async () => {
    const root = temporaryDirectory();
    await openAndClose(root);
    writeFileSync(join(root, 'deployment-id'), 'not-a-ulid\n');
    expect(await throwingRejectionOf(openIn(root))).toThrow(BungalowStateError);
    // The failed open released its lock, so a repaired file opens.
    const repaired = '01ARYZ6S41TSV4RRFFQ69G5FAV';
    writeFileSync(join(root, 'deployment-id'), `${repaired}\n`);
    writeFileSync(join(root, 'workspace-id'), `${repaired}\n`);
    writeFileSync(join(root, '.managed-secrets', 'workspace-id'), `${repaired}\n`);
    using handle = await openIn(root);
    expect(handle.deploymentId).toBe(repaired);
  });

  test('refuses a nonempty root without a persisted identity', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'database.sqlite'), 'existing database');
    expect(await throwingRejectionOf(openIn(root))).toThrow(BungalowStateError);
    expect(existsSync(join(root, 'deployment-id'))).toBe(false);
    expect(readFileSync(join(root, 'database.sqlite'), 'utf8')).toBe('existing database');
  });

  test('recovers a fresh home interrupted before its identity rename', async () => {
    const root = temporaryDirectory();
    const temporary = join(root, 'deployment-id.4242-12345678-1234-1234-1234-123456789abc.tmp');
    writeFileSync(temporary, 'interrupted identity');
    using bungalow = await openIn(root);
    expect(bungalow.workspaceId).toBe(bungalow.deploymentId);
    expect(existsSync(temporary)).toBe(false);
  });

  test('refuses a workspace marker mismatch without rewriting either identity', async () => {
    const root = temporaryDirectory();
    await openAndClose(root);
    const deployment = readFileSync(join(root, 'deployment-id'), 'utf8');
    writeFileSync(join(root, 'workspace-id'), 'different-workspace\n');
    expect(await throwingRejectionOf(openIn(root))).toThrow(BungalowStateError);
    expect(readFileSync(join(root, 'deployment-id'), 'utf8')).toBe(deployment);
    expect(readFileSync(join(root, 'workspace-id'), 'utf8')).toBe('different-workspace\n');
  });
});

describe('writeConfiguration', () => {
  const SENTINEL = 'sentinel-configuration-text-4c1d';

  test('writes the configuration 0600, reads it back, and replaces an earlier one', async () => {
    const root = temporaryDirectory();
    using handle = await openIn(root);
    const configurationSnapshot3 = await handle.readConfiguration();
    expect(
      await handle.writeConfiguration('{"first":1}\n', {
        expectedRevision: configurationSnapshot3.revision,
      }),
    ).toEqual({ outcome: 'committed' });
    const configurationSnapshot4 = await handle.readConfiguration();
    expect(configurationSnapshot4.text).toBe('{"first":1}\n');
    const configurationSnapshot5 = await handle.readConfiguration();
    expect(
      await handle.writeConfiguration('{"second":2}\n', {
        expectedRevision: configurationSnapshot5.revision,
      }),
    ).toEqual({ outcome: 'committed' });
    const configurationSnapshot6 = await handle.readConfiguration();
    expect(configurationSnapshot6.text).toBe('{"second":2}\n');
    expect(modeOf(handle.configurationLocation)).toBe(0o600);
    expect(readdirSync(root).toSorted()).toEqual([
      '.managed-secrets',
      'configuration.json',
      'deployment-id',
      'lock',
      'logs',
      'secrets',
      'workspace-id',
    ]);
  });

  test('persists across reopen', async () => {
    const root = temporaryDirectory();
    const first = await openIn(root);
    const configurationSnapshot7 = await first.readConfiguration();
    expect(
      await first.writeConfiguration('{"kept":true}', {
        expectedRevision: configurationSnapshot7.revision,
      }),
    ).toEqual({ outcome: 'committed' });
    first.close();
    using second = await openIn(root);
    const configurationSnapshot8 = await second.readConfiguration();
    expect(configurationSnapshot8.text).toBe('{"kept":true}');
  });

  test('a failure while publishing the file leaves the previous file whole and no temporary file', async () => {
    const root = temporaryDirectory();
    using handle = openAtRoot(TEST_NAME, root, {
      renameConfiguration: () => {
        throw Object.assign(new Error(`rename ${root} failed`), { code: 'EIO', syscall: 'rename' });
      },
    });
    writeFileSync(join(root, 'configuration.json'), '{"previous":true}');
    const configurationSnapshot9 = await handle.readConfiguration();
    const result = await handle.writeConfiguration(SENTINEL, {
      expectedRevision: configurationSnapshot9.revision,
    });
    expect(result.outcome).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain(root);
    const configurationSnapshot10 = await handle.readConfiguration();
    expect(configurationSnapshot10.text).toBe('{"previous":true}');
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('a temporary file a crash left behind is removed on open and the previous file is intact', async () => {
    const root = temporaryDirectory();
    await openAndClose(root);
    writeFileSync(join(root, 'configuration.json'), '{"previous":true}');
    const leftover = `configuration.json.4242-${crypto.randomUUID()}.tmp`;
    writeFileSync(join(root, leftover), '{"half":');
    const unrelated = 'configuration.json.backup';
    writeFileSync(join(root, unrelated), 'mine');
    using handle = await openIn(root);
    expect(existsSync(join(root, leftover))).toBe(false);
    expect(existsSync(join(root, unrelated))).toBe(true);
    const configurationSnapshot11 = await handle.readConfiguration();
    expect(configurationSnapshot11.text).toBe('{"previous":true}');
  });

  test('refuses a closed handle and a value that is not text', async () => {
    const handle = await openIn(temporaryDirectory());
    expect(
      await throwingRejectionOf(
        handle.writeConfiguration(42 as unknown as string, { expectedRevision: null }),
      ),
    ).toThrow(BungalowInputError);
    handle.close();
    expect(
      await throwingRejectionOf(handle.writeConfiguration('{}', { expectedRevision: null })),
    ).toThrow(BungalowStateError);
  });
});

describe('secrets', () => {
  test('stores each secret in its own 0600 file and reads it back verbatim', async () => {
    const root = temporaryDirectory();
    using handle = await openIn(root);
    const secrets = join(root, 'secrets');
    await handle.deploymentSecrets.write('api-key', 'line one\nline two ');
    await handle.deploymentSecrets.write('token', 'second');
    expect(await handle.deploymentSecrets.read('api-key')).toBe('line one\nline two ');
    expect(await handle.deploymentSecrets.read('token')).toBe('second');
    expect(modeOf(handle.deploymentSecrets.location('api-key'))).toBe(0o600);
    expect(modeOf(handle.deploymentSecrets.location('token'))).toBe(0o600);
    expect(readdirSync(secrets).toSorted()).toEqual(['api-key', 'token']);
  });

  test('returns undefined for a missing key', async () => {
    using handle = await openIn(temporaryDirectory());
    expect(await handle.deploymentSecrets.read('missing')).toBeUndefined();
  });

  test('replaces an earlier value, leaving no temporary file behind', async () => {
    using handle = await openIn(temporaryDirectory());
    await handle.deploymentSecrets.write('token', 'first');
    await handle.deploymentSecrets.write('token', 'second');
    expect(await handle.deploymentSecrets.read('token')).toBe('second');
    expect(readdirSync(dirname(handle.deploymentSecrets.location('token'))).toSorted()).toEqual([
      'token',
    ]);
    expect(modeOf(handle.deploymentSecrets.location('token'))).toBe(0o600);
  });

  test('stores an empty value distinctly from a missing key', async () => {
    using handle = await openIn(temporaryDirectory());
    await handle.deploymentSecrets.write('blank', '');
    expect(await handle.deploymentSecrets.read('blank')).toBe('');
  });

  test('persists across reopen', async () => {
    const root = temporaryDirectory();
    const first = await openIn(root);
    await first.deploymentSecrets.write('token', 'kept');
    first.close();
    using second = await openIn(root);
    expect(await second.deploymentSecrets.read('token')).toBe('kept');
  });

  test.each(['../x', 'Key', '', 'a.b', '-a'])('rejects the key %p', async (key) => {
    using handle = await openIn(temporaryDirectory());
    expect(await throwingRejectionOf(handle.deploymentSecrets.write(key, 'value'))).toThrow(
      BungalowInputError,
    );
    expect(await throwingRejectionOf(handle.deploymentSecrets.read(key))).toThrow(
      BungalowInputError,
    );
    expect(() => handle.deploymentSecrets.location(key)).toThrow(BungalowInputError);
  });
});

describe('close', () => {
  test('is idempotent and releases the lock', async () => {
    const root = temporaryDirectory();
    const handle = await openIn(root);
    expect(await throwingRejectionOf(openIn(root))).toThrow(BungalowLockedError);
    handle.close();
    expect(() => handle.close()).not.toThrow();

    // A later handle holds the lock now; the first handle's repeated close must not release it.
    using second = await openIn(root);
    handle.close();
    expect(await throwingRejectionOf(openIn(root))).toThrow(BungalowLockedError);
    expect(second.configurationLocation).toBe(join(root, 'configuration.json'));
  });

  test('makes every later use throw BungalowStateError', async () => {
    const handle = await openIn(temporaryDirectory());
    handle.close();
    expect(() => handle.content('agents')).toThrow(BungalowStateError);
    expect(() => handle.deploymentSecrets.location('token')).toThrow(BungalowStateError);
    expect(await throwingRejectionOf(handle.readConfiguration())).toThrow(BungalowStateError);
    expect(await throwingRejectionOf(handle.deploymentSecrets.write('token', 'value'))).toThrow(
      BungalowStateError,
    );
    expect(await throwingRejectionOf(handle.deploymentSecrets.read('token'))).toThrow(
      BungalowStateError,
    );
  });

  test('can be retried after the lock fails to release, and releases once it succeeds', async () => {
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
    await handle.deploymentSecrets.write('token', 'still open');
    expect(await handle.deploymentSecrets.read('token')).toBe('still open');

    handle.close();
    expect(releases).toBe(2);
    expect(await throwingRejectionOf(handle.deploymentSecrets.read('token'))).toThrow(
      BungalowStateError,
    );
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
  test('refuses to open the real home directory when <NAME>_HOME is unset or empty', async () => {
    const home = temporaryDirectory();
    for (const environment of [
      { NODE_ENV: 'test' },
      { NODE_ENV: 'test', [TEST_HOME_VARIABLE]: '' },
    ]) {
      expect(
        await throwingRejectionOf(
          openBungalow({ name: TEST_NAME, environment, homeDirectory: home }),
        ),
      ).toThrow(BungalowInputError);
    }
    expect(readdirSync(home)).toEqual([]);
  });

  test('applies to the process environment by default, where bun test sets NODE_ENV to test', async () => {
    expect(processEnvironment()['NODE_ENV']).toBe('test');
    expect(processEnvironment()[TEST_HOME_VARIABLE]).toBeUndefined();
    expect(await throwingRejectionOf(openBungalow({ name: TEST_NAME }))).toThrow(
      BungalowInputError,
    );
  });

  test('cannot be bypassed by passing an environment that says nothing about NODE_ENV', async () => {
    const home = temporaryDirectory();
    expect(await throwingRejectionOf(openBungalow({ name: TEST_NAME, environment: {} }))).toThrow(
      BungalowInputError,
    );
    expect(
      await throwingRejectionOf(
        openBungalow({ name: TEST_NAME, environment: {}, homeDirectory: home }),
      ),
    ).toThrow(BungalowInputError);
    expect(readdirSync(home)).toEqual([]);
  });

  test('allows an explicit <NAME>_HOME under test', async () => {
    const root = temporaryDirectory();
    using handle = await openBungalow({
      name: TEST_NAME,
      environment: { NODE_ENV: 'test', ...homeEnvironment(root) },
    });
    expect(handle.configurationLocation).toBe(join(root, 'configuration.json'));
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
  test('is tightened to 0700, along with its secrets directory', async () => {
    const root = temporaryDirectory();
    await openAndClose(root);
    chmodSync(root, 0o755);
    chmodSync(join(root, 'secrets'), 0o755);
    using handle = await openIn(root);
    expect(handle.configurationLocation).toBe(join(root, 'configuration.json'));
    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(join(root, 'secrets'))).toBe(0o700);
  });

  test('has a secret that group or others can read tightened to 0600 before it is read', async () => {
    const root = temporaryDirectory();
    await openAndClose(root);
    const path = join(root, 'secrets', 'token');
    writeFileSync(path, 'loose');
    chmodSync(path, 0o644);
    using handle = await openIn(root);
    expect(await handle.deploymentSecrets.read('token')).toBe('loose');
    expect(modeOf(path)).toBe(0o600);
  });

  test('refuses a stored secret that is not a regular file, without changing its mode', async () => {
    const root = temporaryDirectory();
    using handle = await openIn(root);
    const path = join(root, 'secrets', 'blocked');
    mkdirSync(path, { mode: 0o755 });
    expect(await throwingRejectionOf(handle.deploymentSecrets.read('blocked'))).toThrow(
      BungalowStateError,
    );
    expect(modeOf(path)).toBe(0o755);
  });

  test('has the temporary files a crash left behind removed, and only those Bungalow names', async () => {
    const root = temporaryDirectory();
    await openAndClose(root);
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const leftovers = [
      join(root, `deployment-id.4242-${uuid}.tmp`),
      join(root, 'secrets', `token.4242-${uuid}.tmp`),
    ];
    const kept = [
      join(root, 'notes.tmp'),
      join(root, `notes.4242-${uuid}.tmp`),
      join(root, `token.4242-${uuid}.tmp`),
      join(root, 'secrets', 'token'),
      join(root, 'secrets', `Not_A_Key.4242-${uuid}.tmp`),
      join(root, 'secrets', `.hidden.4242-${uuid}.tmp`),
    ];
    for (const path of [...leftovers, ...kept]) writeFileSync(path, 'x');
    using handle = await openIn(root);
    expect(handle.configurationLocation).toBe(join(root, 'configuration.json'));
    for (const path of leftovers) expect(existsSync(path), path).toBe(false);
    for (const path of kept) expect(existsSync(path), path).toBe(true);
  });
});

describe('openTemporaryBungalow', () => {
  test('creates an isolated root under the temporary directory and removes it on close', async () => {
    const handle = await openTemporaryBungalow({ name: TEST_NAME });
    const root = dirname(handle.configurationLocation);
    try {
      expect(root.startsWith(tmpdir())).toBe(true);
      expect(modeOf(root)).toBe(0o700);
      await handle.deploymentSecrets.write('token', 'value');
      expect(await handle.deploymentSecrets.read('token')).toBe('value');
      expect(isUlid(handle.deploymentId)).toBe(true);
    } finally {
      handle.close();
    }
    expect(existsSync(root)).toBe(false);
    expect(() => handle.close()).not.toThrow();
  });

  test('always has an absolute root, since TMPDIR may be relative', async () => {
    using handle = await openTemporaryBungalow({ name: TEST_NAME });
    expect(isAbsolute(handle.configurationLocation)).toBe(true);
    expect(isAbsolute(absoluteTemporaryDirectory('relative/tmp'))).toBe(true);
    expect(absoluteTemporaryDirectory('/var/tmp/')).toBe('/var/tmp');
  });

  test('gives each call its own root', async () => {
    using first = await openTemporaryBungalow({ name: TEST_NAME });
    using second = await openTemporaryBungalow({ name: TEST_NAME });
    expect(first.configurationLocation).not.toBe(second.configurationLocation);
    expect(first.deploymentId).not.toBe(second.deploymentId);
  });

  test('rejects an invalid name', async () => {
    expect(await throwingRejectionOf(openTemporaryBungalow({ name: '../x' }))).toThrow(
      BungalowInputError,
    );
  });
});
