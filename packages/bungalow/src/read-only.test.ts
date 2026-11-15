import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { Bungalow } from './bungalow.ts';
import { openLocalBungalow } from './bungalow.ts';
import { BungalowInputError, BungalowStateError } from './errors.ts';
import { makeFifo } from './fifo.test-support.ts';
import { TEST_NAME, useTemporaryDirectories } from './fixtures.test-support.ts';
import {
  createLocalSecretProvider,
  SecretProviderError,
  type SecretReference,
} from './secret-provider.ts';

const temporaryDirectory = useTemporaryDirectories();

const ULID = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const DIGEST = 'a'.repeat(64);

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function openForReading(root: string, workspaceId?: string): Promise<Bungalow> {
  return openLocalBungalow({
    name: TEST_NAME,
    root,
    access: 'read',
    ...(workspaceId === undefined ? {} : { workspaceId }),
  });
}

async function rejectedBy(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to reject.');
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw.');
}

type Entry = {
  readonly path: string;
  readonly type: 'directory' | 'file' | 'symlink' | 'other';
  readonly mode: number;
  readonly size: number;
  readonly modified: bigint;
  readonly content: string | undefined;
};

/**
 * Every entry under `root`, the root itself included: name, type, mode, size, modification time in
 * nanoseconds, and content. It walks with `lstat`, so a link is recorded and never followed.
 */
function snapshotOf(root: string): readonly Entry[] {
  const entries: Entry[] = [];
  const visit = (path: string): void => {
    const status = lstatSync(path, { bigint: true });
    const type = status.isDirectory()
      ? 'directory'
      : status.isFile()
        ? 'file'
        : status.isSymbolicLink()
          ? 'symlink'
          : 'other';
    entries.push({
      path: relative(root, path) || '.',
      type,
      mode: Number(status.mode & 0o7777n),
      size: Number(status.size),
      modified: status.mtimeNs,
      content: type === 'file' ? readFileSync(path, 'utf8') : undefined,
    });
    if (type === 'directory') {
      for (const name of readdirSync(path).toSorted()) visit(join(path, name));
    }
  };
  visit(root);
  return entries;
}

/** A directory somebody else owns, which no read-only operation may change. */
function foreignDirectory(): string {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, 'theirs'), 'not bungalow');
  chmodSync(directory, 0o755);
  return directory;
}

type Seed = {
  readonly root: string;
  readonly deploymentId: string;
  readonly workspaceId: string;
  readonly recovered: SecretReference;
  readonly kept: SecretReference;
};

/**
 * A home a writer opened and closed: configuration, a deployment secret, a legacy secret, two
 * managed versions (one with its operation record, one without, so that it must be recovered),
 * and a content directory.
 */
async function seededHome(): Promise<Seed> {
  const root = temporaryDirectory();
  const writer = await openLocalBungalow({ name: TEST_NAME, root });
  await writer.writeConfiguration('{"seeded":true}', { expectedRevision: null });
  await writer.deploymentSecrets.write('token', 'deployment-value');
  writeFileSync(join(root, 'secrets', 'legacy'), 'legacy-value', { mode: 0o600 });
  const recovered = await writer.secretProvider.prepare({
    operationId: 'recovered',
    key: 'api-key',
    value: 'recovered-value',
    requestDigest: DIGEST,
    expectedRevision: null,
  });
  const kept = await writer.secretProvider.prepare({
    operationId: 'kept',
    key: 'api-key',
    value: 'kept-value',
    requestDigest: DIGEST,
    expectedRevision: null,
  });
  writer.content('agents');
  const { deploymentId, workspaceId } = writer;
  writer.close();
  return {
    root,
    deploymentId,
    workspaceId,
    recovered: recovered.reference,
    kept: kept.reference,
  };
}

/** Loosen every mode a read could be tempted to tighten, and leave what a crash leaves behind. */
function loosen(root: string): void {
  for (const path of [
    join(root, 'secrets', 'token'),
    join(root, 'secrets', 'legacy'),
    join(root, '.managed-secrets', 'versions', 'op-recovered'),
    join(root, '.managed-secrets', 'versions', 'op-kept'),
  ]) {
    chmodSync(path, 0o644);
  }
  for (const path of [
    join(root, 'secrets'),
    join(root, 'agents'),
    join(root, '.managed-secrets'),
    join(root, '.managed-secrets', 'versions'),
    join(root, '.managed-secrets', 'operations'),
    root,
  ]) {
    chmodSync(path, 0o755);
  }
  // The operation record of `recovered` is gone, so reading it recovers it from its version.
  unlinkSync(join(root, '.managed-secrets', 'operations', 'recovered.json'));
  writeFileSync(join(root, `deployment-id.4242-${UUID}.tmp`), 'leftover');
  writeFileSync(join(root, 'secrets', `token.4242-${UUID}.tmp`), 'leftover');
}

describe('a read-only open', () => {
  test('and every member of its handle create, change, and delete nothing', async () => {
    const seed = await seededHome();
    loosen(seed.root);
    const before = snapshotOf(seed.root);
    // The record is only as strong as the fixture: the things a read could change are present.
    expect(before.find(({ path }) => path === '.')?.mode).toBe(0o755);
    expect(before.find(({ path }) => path === 'secrets/token')?.mode).toBe(0o644);
    expect(before.map(({ path }) => path)).toContain(`deployment-id.4242-${UUID}.tmp`);
    expect(before.map(({ path }) => path)).not.toContain(
      '.managed-secrets/operations/recovered.json',
    );

    const handle = await openForReading(seed.root);
    const configuration = await handle.readConfiguration();
    expect(configuration.text).toBe('{"seeded":true}');
    expect(await handle.deploymentSecrets.read('token')).toBe('deployment-value');
    expect(handle.content('agents')).toEqual({
      kind: 'directory',
      path: join(seed.root, 'agents'),
    });
    expect(await handle.secretProvider.readLegacy('legacy')).toBe('legacy-value');
    expect(await handle.secretProvider.readVersion(seed.kept)).toBe('kept-value');
    expect(await handle.secretProvider.readVersion(seed.recovered)).toBe('recovered-value');
    expect(await handle.secretProvider.getOperation('recovered')).toEqual({
      id: 'recovered',
      workspaceId: seed.workspaceId,
      key: 'api-key',
      reference: seed.recovered,
      expectedRevision: null,
      state: 'prepared',
    });
    expect(await handle.secretProvider.getOperation('kept')).toMatchObject({ id: 'kept' });
    const operations = await handle.secretProvider.listOperations();
    expect(operations.map(({ id }) => id).toSorted()).toEqual(['kept', 'recovered']);
    // The members that refuse change nothing either.
    expect(await handle.writeConfiguration('{}', { expectedRevision: null })).toEqual({
      outcome: 'read-only',
    });
    await rejectedBy(handle.deploymentSecrets.write('token', 'changed'));
    await rejectedBy(
      handle.secretProvider.prepare({
        operationId: 'fresh',
        key: 'api-key',
        value: 'v',
        requestDigest: DIGEST,
        expectedRevision: null,
      }),
    );
    await rejectedBy(
      handle.secretProvider.transitionOperation('kept', { from: 'prepared', to: 'publishing' }),
    );
    await rejectedBy(handle.secretProvider.reclaim(seed.kept));
    handle.close();
    handle.close();

    expect(snapshotOf(seed.root)).toEqual(before);
  });

  test('the same calls on a read-write handle do change the root, so the record can tell', async () => {
    const seed = await seededHome();
    loosen(seed.root);
    const before = snapshotOf(seed.root);
    const handle = await openLocalBungalow({ name: TEST_NAME, root: seed.root });
    await handle.deploymentSecrets.read('token');
    await handle.secretProvider.getOperation('recovered');
    handle.close();
    expect(snapshotOf(seed.root)).not.toEqual(before);
  });
});

describe('a read-only open of a root that is not a home yet', () => {
  test('rejects a root that does not exist, and creates nothing', async () => {
    const root = join(temporaryDirectory(), 'absent');
    expect(await rejectedBy(openForReading(root))).toBeInstanceOf(BungalowStateError);
    expect(existsSync(root)).toBe(false);
  });

  test('rejects a root with no deployment-id, and creates nothing', async () => {
    const root = temporaryDirectory();
    const before = snapshotOf(root);
    expect(await rejectedBy(openForReading(root))).toBeInstanceOf(BungalowStateError);
    expect(snapshotOf(root)).toEqual(before);
  });

  test('rejects a deployment-id that is not a ULID', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'deployment-id'), 'not-a-ulid\n');
    expect(await rejectedBy(openForReading(root))).toBeInstanceOf(BungalowStateError);
  });

  test('opens a root with deployment-id and no workspace-id with the deployment identity, writing nothing', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'deployment-id'), `${ULID}\n`);
    const before = snapshotOf(root);
    const handle = await openForReading(root);
    expect(handle.deploymentId).toBe(ULID);
    expect(handle.workspaceId).toBe(ULID);
    expect(await handle.secretProvider.readLegacy('anything')).toBeUndefined();
    handle.close();
    expect(snapshotOf(root)).toEqual(before);
    expect(readdirSync(root)).toEqual(['deployment-id']);
  });

  test('opens a root with no .managed-secrets, whose provider reads as empty', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'deployment-id'), `${ULID}\n`);
    const prepared = await createLocalSecretProvider({
      root: temporaryDirectory(),
      workspaceId: ULID,
    }).prepare({
      operationId: 'elsewhere',
      key: 'api-key',
      value: 'v',
      requestDigest: DIGEST,
      expectedRevision: null,
    });
    const reference = prepared.reference;
    const before = snapshotOf(root);
    const handle = await openForReading(root);
    expect(await handle.secretProvider.readLegacy('api-key')).toBeUndefined();
    expect(await handle.secretProvider.getOperation('elsewhere')).toBeUndefined();
    expect(await handle.secretProvider.listOperations()).toEqual([]);
    const error = await rejectedBy(handle.secretProvider.readVersion(reference));
    expect(error).toBeInstanceOf(SecretProviderError);
    expect((error as SecretProviderError).code).toBe('missing');
    handle.close();
    expect(snapshotOf(root)).toEqual(before);
  });

  test('opens a root with no secrets/, where a deployment secret reads as undefined', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'deployment-id'), `${ULID}\n`);
    const before = snapshotOf(root);
    const handle = await openForReading(root);
    expect(await handle.deploymentSecrets.read('token')).toBeUndefined();
    expect(await handle.secretProvider.readLegacy('token')).toBeUndefined();
    handle.close();
    expect(snapshotOf(root)).toEqual(before);
  });
});

describe('a read-only handle', () => {
  test('reports a read-only configuration, and writeConfiguration resolves read-only', async () => {
    const seed = await seededHome();
    const handle = await openForReading(seed.root);
    expect(handle.configurationWriteCapability).toBe('read-only');
    expect(await handle.writeConfiguration('{}', { expectedRevision: null })).toEqual({
      outcome: 'read-only',
    });
    expect(handle.mode).toBe('local');
    expect(handle.capabilities).toEqual({ sharedBetweenInstances: false, personalMachine: true });
    handle.close();
  });

  test('has deployment secrets that are not writable and reject write', async () => {
    const seed = await seededHome();
    const handle = await openForReading(seed.root);
    expect(handle.deploymentSecrets.writable).toBe(false);
    expect(await rejectedBy(handle.deploymentSecrets.write('token', 'changed'))).toBeInstanceOf(
      BungalowStateError,
    );
    expect(await handle.deploymentSecrets.read('token')).toBe('deployment-value');
    handle.close();
  });

  test('has a provider that cannot prepare or transition', async () => {
    const seed = await seededHome();
    const handle = await openForReading(seed.root);
    expect(handle.secretProvider.capabilities).toEqual({
      read: true,
      prepare: false,
      transitions: false,
    });
    handle.close();
  });

  test.each([
    [
      'prepare',
      (handle: Bungalow) =>
        handle.secretProvider.prepare({
          operationId: 'fresh',
          key: 'api-key',
          value: 'v',
          requestDigest: DIGEST,
          expectedRevision: null,
        }),
    ],
    [
      'transitionOperation',
      (handle: Bungalow) =>
        handle.secretProvider.transitionOperation('kept', { from: 'prepared', to: 'publishing' }),
    ],
    ['reclaim', (handle: Bungalow, seed: Seed) => handle.secretProvider.reclaim(seed.kept)],
  ])('rejects %s with SecretProviderError code read-only', async (_name, call) => {
    const seed = await seededHome();
    const handle = await openForReading(seed.root);
    const error = await rejectedBy(call(handle, seed));
    expect(error).toBeInstanceOf(SecretProviderError);
    expect((error as SecretProviderError).code).toBe('read-only');
    handle.close();
  });

  test('returns the location of an existing content directory, and throws for a missing one', async () => {
    const seed = await seededHome();
    const handle = await openForReading(seed.root);
    expect(handle.content('agents')).toEqual({
      kind: 'directory',
      path: join(seed.root, 'agents'),
    });
    expect(thrownBy(() => handle.content('missing'))).toBeInstanceOf(BungalowStateError);
    expect(existsSync(join(seed.root, 'missing'))).toBe(false);
    handle.close();
  });

  test('has a logs path whether or not the directory exists', async () => {
    const seed = await seededHome();
    const handle = await openForReading(seed.root);
    expect(handle.logs).toBe(join(seed.root, 'logs'));
    handle.close();
    rmSync(join(seed.root, 'logs'), { recursive: true });
    const again = await openForReading(seed.root);
    expect(again.logs).toBe(join(seed.root, 'logs'));
    expect(existsSync(join(seed.root, 'logs'))).toBe(false);
    again.close();
  });

  test('refuses every later use once closed', async () => {
    const seed = await seededHome();
    const handle = await openForReading(seed.root);
    handle.close();
    expect(await rejectedBy(handle.readConfiguration())).toBeInstanceOf(BungalowStateError);
    expect(await rejectedBy(handle.deploymentSecrets.read('token'))).toBeInstanceOf(
      BungalowStateError,
    );
    expect(thrownBy(() => handle.content('agents'))).toBeInstanceOf(BungalowStateError);
  });

  test('is not blocked by a read-write handle on the same root, and does not disturb it', async () => {
    const seed = await seededHome();
    using writer = await openLocalBungalow({ name: TEST_NAME, root: seed.root });
    const reader = await openForReading(seed.root);
    expect(reader.deploymentId).toBe(writer.deploymentId);
    reader.close();
    expect(readFileSync(join(seed.root, 'lock'), 'utf8')).toBe(`${process.pid}\n`);
    await writer.deploymentSecrets.write('token', 'still-writable');
  });
});

describe('a read-only open with an option it refuses', () => {
  test.each([
    ['acquireLock', { acquireLock: () => ({ release: () => undefined }) }],
    ['deploymentSecrets', { deploymentSecrets: () => undefined as never }],
    ['secretProvider', { secretProvider: () => undefined as never }],
  ] as const)(
    'rejects %s with BungalowInputError before touching the root',
    async (_name, option) => {
      const root = join(temporaryDirectory(), 'absent');
      const error = await rejectedBy(
        openLocalBungalow({ name: TEST_NAME, root, access: 'read', ...option }),
      );
      expect(error).toBeInstanceOf(BungalowInputError);
      expect(existsSync(root)).toBe(false);
    },
  );

  test('rejects an access that is neither read nor write', async () => {
    const root = join(temporaryDirectory(), 'absent');
    const error = await rejectedBy(
      openLocalBungalow({ name: TEST_NAME, root, access: 'append' as never }),
    );
    expect(error).toBeInstanceOf(BungalowInputError);
    expect(existsSync(root)).toBe(false);
  });

  test('takes the read-write path when access is write', async () => {
    const root = join(temporaryDirectory(), 'created');
    using handle = await openLocalBungalow({ name: TEST_NAME, root, access: 'write' });
    expect(handle.configurationWriteCapability).toBe('writable');
    expect(handle.deploymentSecrets.writable).toBe(true);
    expect(existsSync(join(root, 'lock'))).toBe(true);
  });
});

describe('a read-only open still refuses a different identity', () => {
  test('a configured workspace identity that differs from the stored one', async () => {
    const seed = await seededHome();
    const before = snapshotOf(seed.root);
    expect(await rejectedBy(openForReading(seed.root, 'another-workspace'))).toBeInstanceOf(
      BungalowStateError,
    );
    expect(snapshotOf(seed.root)).toEqual(before);
  });

  test('a configured workspace identity that differs from deployment-id when none is stored', async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'deployment-id'), `${ULID}\n`);
    expect(await rejectedBy(openForReading(root, 'another-workspace'))).toBeInstanceOf(
      BungalowStateError,
    );
    expect(readdirSync(root)).toEqual(['deployment-id']);
  });

  test('a configured workspace identity equal to the stored one opens', async () => {
    const seed = await seededHome();
    const handle = await openForReading(seed.root, seed.workspaceId);
    expect(handle.workspaceId).toBe(seed.workspaceId);
    handle.close();
  });

  test('a stored workspace identity that is not the configured one', async () => {
    const seed = await seededHome();
    writeFileSync(join(seed.root, 'workspace-id'), 'someone-else\n');
    expect(await rejectedBy(openForReading(seed.root))).toBeInstanceOf(BungalowStateError);
  });

  test('a managed secret store that belongs to another workspace', async () => {
    const seed = await seededHome();
    writeFileSync(join(seed.root, '.managed-secrets', 'workspace-id'), 'someone-else\n');
    const error = await rejectedBy(openForReading(seed.root));
    expect(error).toBeInstanceOf(SecretProviderError);
    expect((error as SecretProviderError).code).toBe('rejected');
  });
});

/** Every entry a read-only handle reads, replaced by something it must not trust. */
describe('a read-only open and an entry that is not what Bungalow expects', () => {
  type Replace = (path: string) => { readonly target?: string };

  const symbolicLink: Replace = (path) => {
    const target = join(temporaryDirectory(), 'theirs');
    writeFileSync(target, 'not bungalow');
    chmodSync(target, 0o644);
    symlinkSync(target, path);
    return { target };
  };
  const hardLink: Replace = (path) => {
    const target = join(temporaryDirectory(), 'theirs');
    writeFileSync(target, 'not bungalow');
    chmodSync(target, 0o644);
    linkSync(target, path);
    return { target };
  };
  const fifo: Replace = (path) => {
    makeFifo(path);
    return {};
  };
  const directoryLink: Replace = (path) => {
    symlinkSync(foreignDirectory(), path);
    return {};
  };

  function expectUntouched(target: string | undefined): void {
    if (target === undefined) return;
    expect(readFileSync(target, 'utf8')).toBe('not bungalow');
    expect(modeOf(target)).toBe(0o644);
  }

  const atOpen: readonly [string, string, Replace][] = [
    ['deployment-id', 'a symbolic link', symbolicLink],
    ['deployment-id', 'a FIFO', fifo],
    ['deployment-id', 'a hard link', hardLink],
    ['workspace-id', 'a symbolic link', symbolicLink],
    ['workspace-id', 'a FIFO', fifo],
    ['workspace-id', 'a hard link', hardLink],
    ['secrets', 'a symbolic link', directoryLink],
    ['.managed-secrets', 'a symbolic link', directoryLink],
    ['.managed-secrets/workspace-id', 'a symbolic link', symbolicLink],
    ['.managed-secrets/workspace-id', 'a FIFO', fifo],
    ['.managed-secrets/workspace-id', 'a hard link', hardLink],
  ];

  test.each(atOpen)(
    '%s as %s is refused at open and nothing is read through it',
    async (entry, _kind, replace) => {
      const seed = await seededHome();
      const path = join(seed.root, entry);
      rmSync(path, { recursive: true, force: true });
      const { target } = replace(path);
      const error = await rejectedBy(openForReading(seed.root));
      expect(error).toBeInstanceOf(
        entry.startsWith('.managed-secrets') ? SecretProviderError : BungalowStateError,
      );
      expectUntouched(target);
    },
  );

  test('a symbolic link as the root is refused', async () => {
    const target = foreignDirectory();
    const root = join(temporaryDirectory(), 'link');
    symlinkSync(target, root);
    expect(await rejectedBy(openForReading(root))).toBeInstanceOf(BungalowStateError);
    expect(readdirSync(target)).toEqual(['theirs']);
  });

  type Read = (handle: Bungalow, seed: Seed) => Promise<unknown>;
  const fileKinds: readonly (readonly [string, Replace])[] = [
    ['a symbolic link', symbolicLink],
    ['a FIFO', fifo],
    ['a hard link', hardLink],
  ];
  const fileReads: readonly (readonly [string, Read])[] = [
    ['configuration.json', (handle) => handle.readConfiguration()],
    ['secrets/token', (handle) => handle.deploymentSecrets.read('token')],
    ['secrets/legacy', (handle) => handle.secretProvider.readLegacy('legacy')],
    [
      '.managed-secrets/versions/op-kept',
      (handle, seed) => handle.secretProvider.readVersion(seed.kept),
    ],
    [
      '.managed-secrets/operations/kept.json',
      (handle) => handle.secretProvider.getOperation('kept'),
    ],
  ];
  const afterOpen: readonly (readonly [string, string, Replace, Read])[] = [
    ...fileReads.flatMap(([entry, read]) =>
      fileKinds.map(([kind, replace]) => [entry, kind, replace, read] as const),
    ),
    [
      '.managed-secrets/versions',
      'a symbolic link',
      directoryLink,
      (handle, seed) => handle.secretProvider.readVersion(seed.kept),
    ],
    [
      '.managed-secrets/operations',
      'a symbolic link',
      directoryLink,
      (handle) => handle.secretProvider.listOperations(),
    ],
  ];

  test.each(afterOpen)(
    '%s as %s is refused when it is read and nothing is read through it',
    async (entry, _kind, replace, read) => {
      const seed = await seededHome();
      const handle = await openForReading(seed.root);
      const path = join(seed.root, entry);
      rmSync(path, { recursive: true, force: true });
      const { target } = replace(path);
      const error = await rejectedBy(read(handle, seed));
      expect(error).toBeInstanceOf(
        entry.startsWith('.managed-secrets') || entry === 'secrets/legacy'
          ? SecretProviderError
          : BungalowStateError,
      );
      expectUntouched(target);
      handle.close();
    },
  );

  test('a symbolic link as a content directory is refused and its target left alone', async () => {
    const seed = await seededHome();
    const handle = await openForReading(seed.root);
    const target = foreignDirectory();
    rmSync(join(seed.root, 'agents'), { recursive: true });
    symlinkSync(target, join(seed.root, 'agents'));
    expect(thrownBy(() => handle.content('agents'))).toBeInstanceOf(BungalowStateError);
    expect(modeOf(target)).toBe(0o755);
    expect(readdirSync(target)).toEqual(['theirs']);
    handle.close();
  });

  test('a lock that is a symbolic link is never read, so the open is unaffected', async () => {
    const seed = await seededHome();
    rmSync(join(seed.root, 'lock'));
    const target = join(temporaryDirectory(), 'theirs');
    writeFileSync(target, 'not bungalow');
    symlinkSync(target, join(seed.root, 'lock'));
    const handle = await openForReading(seed.root);
    expect(handle.deploymentId).toBe(seed.deploymentId);
    handle.close();
    expect(readFileSync(target, 'utf8')).toBe('not bungalow');
  });
});
