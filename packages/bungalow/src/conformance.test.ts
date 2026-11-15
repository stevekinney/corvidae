/**
 * The conformance checks, run against what the package ships (the default lock, the local and
 * environment deployment-secret stores, and a local, read-only, and remote home), and against
 * deliberately wrong implementations that each must reject by name.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createS3TestServer, type S3TestServer } from '@lostgradient/testing/s3-server';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { openBungalow, openLocalBungalow, type Bungalow } from './bungalow.ts';
import {
  checkBungalow,
  checkDeploymentSecrets,
  checkRootLock,
  checkSecretProvider,
  describeBungalow,
  describeDeploymentSecrets,
  describeRootLock,
} from './conformance.ts';
import type { DeploymentSecrets } from './deployment-secrets.ts';
import { createEnvironmentSecretProvider } from './environment-secret-provider.ts';
import { BungalowInputError, BungalowLockedError, BungalowStateError } from './errors.ts';
import { TEST_NAME, useTemporaryDirectories } from './fixtures.test-support.ts';
import { defaultAcquireLock, type RootLock } from './lock.ts';
import {
  createLocalSecretProvider,
  SecretProviderError,
  type SecretProvider,
} from './secret-provider.ts';
import { generateUlid } from './ulid.ts';

const temporaryDirectory = useTemporaryDirectories();
const homes: Bungalow[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

/** What a wrong implementation's check rejection must name. */
async function expectRuleBroken(check: Promise<void>, rule: string): Promise<void> {
  const failure = await rejectionOf(check);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(`breaks the rule "${rule}"`);
}

/** Open a home, hand it to `inspect`, and close it. */
async function inspectHome<Result>(
  open: (options: { workspaceId?: string }) => Promise<Bungalow>,
  inspect: (home: Bungalow) => Result,
): Promise<Result> {
  const home = await open({});
  try {
    return inspect(home);
  } finally {
    home.close();
  }
}

/* ---------------------------------------------------------------------------------------- */
/* The root lock                                                                            */
/* ---------------------------------------------------------------------------------------- */

const acquireLock = await defaultAcquireLock();

describe('the default lock conforms', () => {
  describeRootLock(acquireLock);
});

describe('a deliberately wrong lock is rejected', () => {
  test('one that grants two holders', async () => {
    await expectRuleBroken(
      checkRootLock(() => ({ release() {} })),
      'a second acquisition of a held root throws BungalowLockedError',
    );
  });

  test('one that refuses with another error', async () => {
    const held = new Set<string>();
    await expectRuleBroken(
      checkRootLock((root) => {
        if (held.has(root)) throw new Error('busy');
        held.add(root);
        return { release: () => void held.delete(root) };
      }),
      'a second acquisition of a held root throws BungalowLockedError',
    );
  });

  test('one that never lets go', async () => {
    const held = new Set<string>();
    await expectRuleBroken(
      checkRootLock((root) => {
        if (held.has(root)) throw new BungalowLockedError(root, undefined);
        held.add(root);
        return { release() {} };
      }),
      'release allows the next acquisition',
    );
  });

  test('one whose release throws the second time', async () => {
    const held = new Set<string>();
    await expectRuleBroken(
      checkRootLock((root) => {
        if (held.has(root)) throw new BungalowLockedError(root, undefined);
        held.add(root);
        let released = false;
        return {
          release() {
            if (released) throw new Error('already released');
            released = true;
            held.delete(root);
          },
        };
      }),
      'release is safe to call twice',
    );
  });
});

/* ---------------------------------------------------------------------------------------- */
/* Deployment secrets                                                                       */
/* ---------------------------------------------------------------------------------------- */

const SECRET_VALUE = 'sentinel-secret-value';

type Environment = Record<string, string | undefined>;

/** Every variable remote mode reads, set, under `NODE_ENV=test` with no `<NAME>_HOME`. */
function remoteEnvironment(endpoint: string, bucket: string): Environment {
  return {
    NODE_ENV: 'test',
    BUNGALOW_TEST_DATABASE_URL: 'postgres://bungalow:password@127.0.0.1:5432/bungalow',
    BUNGALOW_TEST_BUCKET: bucket,
    BUNGALOW_TEST_BUCKET_PREFIX: 'conformance',
    S3_ENDPOINT: endpoint,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'CONFORMANCEACCESSKEYID',
    S3_SECRET_ACCESS_KEY: 'conformance-secret-access-key',
    S3_SESSION_TOKEN: 'conformance-session-token',
    BUNGALOW_TEST_SECRET_API_KEY: SECRET_VALUE,
  };
}

/** A remote home on a server the enclosing `describe` runs, and the open function for it. */
function useRemoteHome(
  writableConfiguration: boolean,
): (options: { workspaceId?: string }) => Promise<Bungalow> {
  const bucket = 'conformance-bucket';
  let server: S3TestServer | undefined;
  beforeAll(() => {
    server = createS3TestServer({ bucket });
  });
  afterAll(async () => {
    await server?.stop();
  });
  return ({ workspaceId }) => {
    if (server === undefined) throw new Error('The S3 server has not started.');
    return openBungalow({
      name: TEST_NAME,
      environment: remoteEnvironment(server.endpoint, bucket),
      databaseWorkspaceClaim: async () => {},
      writableConfiguration,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
  };
}

/** A root that exists for a whole `describe`, so every open of the home reaches the same one. */
function useSharedRoot(prepare?: (root: string) => Promise<void> | void): () => string {
  let root: string | undefined;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bungalow-conformance-'));
    await prepare?.(root);
  });
  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });
  return () => {
    if (root === undefined) throw new Error('The shared root has not been made.');
    return root;
  };
}

// Each `describe` below also states which branch of the check its subject takes, since a rule that
// does not apply to a subject passes without running.

describe('the local file deployment-secret store conforms', () => {
  const create = async (): Promise<DeploymentSecrets> => {
    const home = await openLocalBungalow({ name: TEST_NAME, root: temporaryDirectory() });
    homes.push(home);
    return home.deploymentSecrets;
  };
  test('is writable, so the write rules apply', async () => {
    const store = await create();
    expect(store.writable).toBe(true);
  });
  describeDeploymentSecrets(create);
});

describe('the environment deployment-secret store conforms', () => {
  const openRemote = useRemoteHome(false);
  const create = async (): Promise<DeploymentSecrets> => {
    const home = await openRemote({});
    homes.push(home);
    return home.deploymentSecrets;
  };
  test('is not writable, so the seeded rules apply', async () => {
    const store = await create();
    expect(store.writable).toBe(false);
  });
  describeDeploymentSecrets(create, { key: 'api-key', value: SECRET_VALUE });
});

describe('the deployment-secret store of a read-only local home conforms', () => {
  const create = async (): Promise<DeploymentSecrets> => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'deployment-id'), `${generateUlid()}\n`);
    mkdirSync(join(root, 'secrets'));
    writeFileSync(join(root, 'secrets', 'seeded-key'), 'seeded-value', { mode: 0o600 });
    const home = await openLocalBungalow({ name: TEST_NAME, root, access: 'read' });
    homes.push(home);
    return home.deploymentSecrets;
  };
  test('is not writable, so the seeded rules apply', async () => {
    const store = await create();
    expect(store.writable).toBe(false);
  });
  describeDeploymentSecrets(create, { key: 'seeded-key', value: 'seeded-value' });
});

/**
 * An in-memory store that conforms, with some behaviour replaced by what `overrides` returns for
 * the map that holds the values.
 */
function memoryStore(
  overrides: (values: Map<string, string>) => Partial<DeploymentSecrets> = () => ({}),
): DeploymentSecrets {
  const values = new Map<string, string>();
  const assertKey = (key: string): void => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new BungalowInputError('A secret key is invalid.');
  };
  return {
    writable: true,
    async read(key) {
      assertKey(key);
      return values.get(key);
    },
    async write(key, value) {
      assertKey(key);
      values.set(key, value);
    },
    location(key) {
      assertKey(key);
      return `memory:${key}`;
    },
    ...overrides(values),
  };
}

describe('a deliberately wrong deployment-secret store is rejected', () => {
  test('a conforming one passes', async () => {
    await checkDeploymentSecrets(() => memoryStore());
  });

  test('one that reports writable and rejects write', async () => {
    await expectRuleBroken(
      checkDeploymentSecrets(() =>
        memoryStore(() => ({
          async write() {
            throw new BungalowStateError('read-only');
          },
        })),
      ),
      'on a writable store, a written key reads back',
    );
  });

  test('one that reports not writable and accepts write', async () => {
    await expectRuleBroken(
      checkDeploymentSecrets(() => memoryStore(() => ({ writable: false }))),
      'on a store that is not writable, write rejects',
    );
  });

  test('one that reads an unwritten key as an empty string', async () => {
    await expectRuleBroken(
      checkDeploymentSecrets(() => memoryStore(() => ({ read: async () => '' }))),
      'an unwritten key reads undefined',
    );
  });

  test('one that gives back a value other than the seeded one', async () => {
    await expectRuleBroken(
      checkDeploymentSecrets(
        () =>
          memoryStore(() => ({
            writable: false,
            write: async () => {
              throw new BungalowStateError('read-only');
            },
          })),
        { key: 'seeded-key', value: 'seeded-value' },
      ),
      'a seeded key reads its seeded value',
    );
  });

  test('one that accepts an invalid key', async () => {
    await expectRuleBroken(
      checkDeploymentSecrets(() =>
        memoryStore((values) => ({
          read: async (key) => values.get(key),
          write: async (key, value) => void values.set(key, value),
        })),
      ),
      'read and write reject an invalid key with BungalowInputError',
    );
  });

  test('one whose location holds the value', async () => {
    await expectRuleBroken(
      checkDeploymentSecrets(() =>
        memoryStore((values) => ({
          location: (key) => `memory:${key}=${values.get(key) ?? ''}`,
        })),
      ),
      'location returns a string that does not contain the secret value',
    );
  });

  test('one whose writable is not a boolean', async () => {
    await expectRuleBroken(
      checkDeploymentSecrets(() => memoryStore(() => ({ writable: 'yes' as never }))),
      'writable is a boolean',
    );
  });
});

/* ---------------------------------------------------------------------------------------- */
/* Secret providers                                                                         */
/* ---------------------------------------------------------------------------------------- */

function localProvider(workspaceId: string): SecretProvider {
  return createLocalSecretProvider({ root: temporaryDirectory(), workspaceId });
}

/** A provider that conforms, with some members replaced by `overrides`. */
function providerWith(base: SecretProvider, overrides: Partial<SecretProvider>): SecretProvider {
  return { ...base, ...overrides };
}

function environmentProvider(workspaceId: string): SecretProvider {
  return createEnvironmentSecretProvider({
    workspaceId,
    values: { 'seeded-key': 'seeded-value' },
  });
}

const SEED = { key: 'seeded-key', value: 'seeded-value' } as const;

describe('a deliberately wrong secret provider is rejected', () => {
  test('conforming ones pass', async () => {
    await checkSecretProvider(localProvider);
    await checkSecretProvider(environmentProvider, SEED);
  });

  test('a provider that cannot prepare but accepts prepare', async () => {
    await expectRuleBroken(
      checkSecretProvider(
        (workspaceId) =>
          providerWith(environmentProvider(workspaceId), {
            prepare: () =>
              localProvider(workspaceId).prepare({
                operationId: 'operation-1',
                key: 'token',
                value: 'secret',
                requestDigest: 'a'.repeat(64),
                expectedRevision: null,
              }),
          }),
        SEED,
      ),
      'prepare rejects with code read-only',
    );
  });

  test('a provider that cannot prepare and reads an unwritten key as empty', async () => {
    await expectRuleBroken(
      checkSecretProvider((workspaceId) =>
        providerWith(environmentProvider(workspaceId), { readLegacy: async () => '' }),
      ),
      'readLegacy of a key never written resolves undefined',
    );
  });

  test('a provider that cannot prepare and misreads its seed', async () => {
    await expectRuleBroken(
      checkSecretProvider(
        (workspaceId) =>
          providerWith(environmentProvider(workspaceId), {
            readLegacy: async () => undefined,
          }),
        SEED,
      ),
      'readLegacy of the seeded key resolves the seeded value',
    );
  });

  test('a provider that cannot prepare and transitions anyway', async () => {
    await expectRuleBroken(
      checkSecretProvider((workspaceId) =>
        providerWith(environmentProvider(workspaceId), {
          transitionOperation: async () => {
            throw new SecretProviderError('conflict', 'The operation has transitioned.');
          },
        }),
      ),
      'transitionOperation rejects with code read-only',
    );
  });

  test('a provider that cannot prepare and reclaims anyway', async () => {
    await expectRuleBroken(
      checkSecretProvider((workspaceId) =>
        providerWith(environmentProvider(workspaceId), { reclaim: async () => {} }),
      ),
      'reclaim rejects with code read-only',
    );
  });

  test('a provider that cannot prepare and reads a version that does not exist', async () => {
    await expectRuleBroken(
      checkSecretProvider((workspaceId) =>
        providerWith(environmentProvider(workspaceId), { readVersion: async () => 'invented' }),
      ),
      'readVersion of a reference that names no stored version rejects',
    );
  });

  test('a provider that replays an operation with a different request', async () => {
    await expectRuleBroken(
      checkSecretProvider((workspaceId) => {
        const base = localProvider(workspaceId);
        return providerWith(base, {
          prepare: async (input) =>
            base.prepare({ ...input, operationId: `${input.operationId}-${generateUlid()}` }),
        });
      }),
      'prepares idempotently and reads the exact version',
    );
  });

  test('a provider that lets a prepared operation skip publishing', async () => {
    await expectRuleBroken(
      checkSecretProvider((workspaceId) => {
        const base = localProvider(workspaceId);
        return providerWith(base, {
          transitionOperation: async (id, transition) => {
            if (transition.from === 'prepared' && transition.to === ('published' as never)) {
              await base.transitionOperation(id, { from: 'prepared', to: 'publishing' });
              return base.transitionOperation(id, { from: 'publishing', to: 'published' });
            }
            return base.transitionOperation(id, transition);
          },
        });
      }),
      'enforces the publication state machine and redacts operation records',
    );
  });

  test('a provider that reads a foreign reference', async () => {
    await expectRuleBroken(
      checkSecretProvider((workspaceId) => {
        const base = localProvider(workspaceId);
        return providerWith(base, {
          readVersion: async (reference) => {
            try {
              return await base.readVersion(reference);
            } catch (error) {
              if (error instanceof SecretProviderError && error.code === 'rejected') {
                throw new SecretProviderError('missing', 'The secret version is unavailable.');
              }
              throw error;
            }
          },
        });
      }),
      'rejects a foreign reference before reading the backend',
    );
  });

  test('a provider that reclaims a version that is not abandoned', async () => {
    await expectRuleBroken(
      checkSecretProvider((workspaceId) =>
        providerWith(localProvider(workspaceId), { reclaim: async () => {} }),
      ),
      'reclaims only an abandoned version',
    );
  });

  test('a provider that echoes a malformed request digest', async () => {
    await expectRuleBroken(
      checkSecretProvider((workspaceId) => {
        const base = localProvider(workspaceId);
        return providerWith(base, {
          prepare: async (input) => {
            try {
              return await base.prepare(input);
            } catch (error) {
              if (error instanceof BungalowInputError) {
                throw new BungalowInputError(`Invalid digest ${input.requestDigest}`);
              }
              throw error;
            }
          },
        });
      }),
      'rejects malformed request digests without disclosing input',
    );
  });
});

/* ---------------------------------------------------------------------------------------- */
/* Homes                                                                                    */
/* ---------------------------------------------------------------------------------------- */

describe('a local home conforms', () => {
  const root = useSharedRoot();
  const open = ({ workspaceId }: { workspaceId?: string }): Promise<Bungalow> =>
    openLocalBungalow({
      name: TEST_NAME,
      root: root(),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
  test('writes configuration and deployment secrets, so the write rules apply', async () => {
    const stated = await inspectHome(open, (home) => [
      home.configurationWriteCapability,
      home.deploymentSecrets.writable,
    ]);
    expect(stated).toEqual(['writable', true]);
  });
  describeBungalow(open);
});

describe('a read-only local home conforms', () => {
  const root = useSharedRoot(async (path) => {
    const home = await openLocalBungalow({ name: TEST_NAME, root: path });
    home.close();
  });
  const open = ({ workspaceId }: { workspaceId?: string }): Promise<Bungalow> =>
    openLocalBungalow({
      name: TEST_NAME,
      root: root(),
      access: 'read',
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
  test('writes nothing, so the refusal rules apply', async () => {
    const stated = await inspectHome(open, (home) => [
      home.configurationWriteCapability,
      home.deploymentSecrets.writable,
    ]);
    expect(stated).toEqual(['read-only', false]);
  });
  describeBungalow(open);
});

describe('a remote home conforms', () => {
  const open = useRemoteHome(false);
  test('writes no configuration and no deployment secrets, so the refusal rules apply', async () => {
    const stated = await inspectHome(open, (home) => [
      home.configurationWriteCapability,
      home.deploymentSecrets.writable,
    ]);
    expect(stated).toEqual(['read-only', false]);
  });
  describeBungalow(open);
});

describe('a remote home with writable configuration conforms', () => {
  const open = useRemoteHome(true);
  test('writes configuration and no deployment secrets, so the configuration rules apply', async () => {
    const stated = await inspectHome(open, (home) => [
      home.configurationWriteCapability,
      home.deploymentSecrets.writable,
    ]);
    expect(stated).toEqual(['writable', false]);
  });
  describeBungalow(open);
});

/** Open the local home at one fresh root each call, and let `override` replace some of its members. */
function wrongHome(
  override: (home: Bungalow, opens: number) => Partial<Bungalow>,
  options: { readonly refuseWorkspaceId?: false } = {},
): () => Promise<{
  open: (options: { workspaceId?: string }) => Promise<Bungalow>;
}> {
  return async () => {
    const root = temporaryDirectory();
    let opens = 0;
    return {
      open: async ({ workspaceId }) => {
        opens += 1;
        const home = await openLocalBungalow({
          name: TEST_NAME,
          root,
          ...(workspaceId === undefined || options.refuseWorkspaceId === false
            ? {}
            : { workspaceId }),
        });
        return { ...home, ...override(home, opens) };
      },
    };
  };
}

describe('a deliberately wrong home is rejected', () => {
  const cases: readonly {
    readonly name: string;
    readonly rule: string;
    readonly home: ReturnType<typeof wrongHome>;
  }[] = [
    {
      name: 'a workspace identity that changes on reopen',
      rule: 'deploymentId and workspaceId are the same on reopen',
      home: wrongHome(() => ({ workspaceId: generateUlid() })),
    },
    {
      name: 'a home that accepts any configured workspace identity',
      rule: 'a different configured workspaceId is refused',
      home: wrongHome(() => ({}), { refuseWorkspaceId: false }),
    },
    {
      name: 'a content method that answers after close',
      rule: 'the methods and deployment secrets throw BungalowStateError after close',
      home: wrongHome((home) => ({
        content: (name) => {
          try {
            return home.content(name);
          } catch {
            return { kind: 'directory', path: '/nowhere' };
          }
        },
      })),
    },
    {
      name: 'a close that throws the second time',
      rule: 'close is idempotent',
      home: wrongHome((home) => {
        let closes = 0;
        return {
          close() {
            closes += 1;
            if (closes > 1) throw new Error('Already closed.');
            home.close();
          },
        };
      }),
    },
    {
      name: 'a content method that accepts a reserved name',
      rule: 'content refuses reserved and malformed names',
      home: wrongHome((home) => ({
        content: (name) =>
          name === 'lock' ? { kind: 'directory', path: '/nowhere' } : home.content(name),
      })),
    },
    {
      name: 'capabilities that are not booleans',
      rule: 'capabilities are booleans and the same on reopen',
      home: wrongHome(() => ({
        capabilities: { sharedBetweenInstances: false, personalMachine: 'yes' as never },
      })),
    },
    {
      name: 'capabilities that change on reopen',
      rule: 'capabilities are booleans and the same on reopen',
      home: wrongHome((_home, opens) => ({
        capabilities: { sharedBetweenInstances: opens % 2 === 0, personalMachine: true },
      })),
    },
    {
      name: 'a writable home whose writes always commit',
      rule: 'configuration writes follow configurationWriteCapability',
      home: wrongHome((home) => ({
        writeConfiguration: async (text, condition) => {
          const result = await home.writeConfiguration(text, condition);
          return result.outcome === 'conflict' ? { outcome: 'committed' } : result;
        },
      })),
    },
    {
      name: 'a home that reports unsupported and writes anyway',
      rule: 'configuration writes follow configurationWriteCapability',
      home: wrongHome(() => ({ configurationWriteCapability: 'unsupported' })),
    },
    {
      name: 'deployment secrets that report writable and reject write',
      rule: 'deployment secrets follow writable',
      home: wrongHome((home) => ({
        deploymentSecrets: {
          ...home.deploymentSecrets,
          writable: true,
          write: async () => {
            throw new BungalowStateError('read-only');
          },
        },
      })),
    },
    {
      name: 'deployment secrets that report not writable and accept write',
      rule: 'deployment secrets follow writable',
      home: wrongHome((home) => ({
        deploymentSecrets: { ...home.deploymentSecrets, writable: false },
      })),
    },
  ];

  for (const { name, rule, home } of cases) {
    test(name, async () => {
      const { open } = await home();
      await expectRuleBroken(checkBungalow(open), rule);
    });
  }
});

/* ---------------------------------------------------------------------------------------- */
/* A rejection carries no value                                                             */
/* ---------------------------------------------------------------------------------------- */

describe('a rejection names the broken rule and carries no value', () => {
  const LEAK = 'TOP-SECRET-VALUE-9f3c1a7e';

  test('a lock that throws the secret', async () => {
    const failure = (await rejectionOf(
      checkRootLock(() => {
        throw new Error(`cannot lock ${LEAK}`);
      }),
    )) as Error;
    expect(failure.message).toContain(
      'breaks the rule "a second acquisition of a held root throws BungalowLockedError"',
    );
    expect(failure.message).not.toContain(LEAK);
    expect(failure.cause).toBeUndefined();
  });

  test('a lock whose second acquisition is refused with an error that holds the secret', async () => {
    const held = new Set<string>();
    const failure = (await rejectionOf(
      checkRootLock((root) => {
        if (held.has(root)) throw new Error(LEAK);
        held.add(root);
        return { release: () => void held.delete(root) };
      }),
    )) as Error;
    expect(failure.message).toContain('breaks the rule');
    expect(failure.message).not.toContain(LEAK);
    expect(failure.message).not.toContain(tmpdir());
    expect(failure.cause).toBeUndefined();
  });

  test('a store seeded with a value that reads back wrong', async () => {
    const failure = (await rejectionOf(
      checkDeploymentSecrets(
        () =>
          memoryStore((values) => ({
            writable: false,
            write: async () => {
              throw new BungalowStateError('read-only');
            },
            read: async (key) => (key === 'seeded-key' ? 'WRONG' : values.get(key)),
          })),
        { key: 'seeded-key', value: LEAK },
      ),
    )) as Error;
    expect(failure.message).toContain('breaks the rule "a seeded key reads its seeded value"');
    for (const hidden of [LEAK, 'WRONG', 'seeded-key'])
      expect(failure.message).not.toContain(hidden);
    expect(failure.cause).toBeUndefined();
  });

  test('a store whose location holds the seeded value', async () => {
    const failure = (await rejectionOf(
      checkDeploymentSecrets(
        () =>
          memoryStore(() => ({
            writable: false,
            write: async (key) => {
              await memoryStore().read(key);
              throw new BungalowStateError('read-only');
            },
            read: async (key) => (key === 'seeded-key' ? LEAK : memoryStore().read(key)),
            location: (key) => `memory:${key}=${LEAK}`,
          })),
        { key: 'seeded-key', value: LEAK },
      ),
    )) as Error;
    expect(failure.message).toContain(
      'breaks the rule "location returns a string that does not contain the secret value"',
    );
    for (const hidden of [LEAK, 'seeded-key']) expect(failure.message).not.toContain(hidden);
    expect(failure.cause).toBeUndefined();
  });

  test('a writable store that reads back a different value', async () => {
    const failure = (await rejectionOf(
      checkDeploymentSecrets(() =>
        memoryStore(() => ({
          read: async (key) => (key === 'conformance-key' ? LEAK : undefined),
        })),
      ),
    )) as Error;
    expect(failure.message).toContain(
      'breaks the rule "on a writable store, a written key reads back"',
    );
    for (const hidden of [LEAK, 'conformance-key']) expect(failure.message).not.toContain(hidden);
    expect(failure.cause).toBeUndefined();
  });

  test('a read-only provider whose seeded key reads wrong', async () => {
    const failure = (await rejectionOf(
      checkSecretProvider(
        (workspaceId) =>
          providerWith(environmentProvider(workspaceId), {
            readLegacy: async (key) => (key === 'seeded-key' ? 'WRONG' : undefined),
          }),
        { key: 'seeded-key', value: LEAK },
      ),
    )) as Error;
    expect(failure.message).toContain(
      'breaks the rule "readLegacy of the seeded key resolves the seeded value"',
    );
    for (const hidden of [LEAK, 'WRONG', 'seeded-key'])
      expect(failure.message).not.toContain(hidden);
    expect(failure.cause).toBeUndefined();
  });

  test('a provider that reads back a version holding the secret', async () => {
    const failure = (await rejectionOf(
      checkSecretProvider((workspaceId) => {
        const base = localProvider(workspaceId);
        return providerWith(base, { readVersion: async () => LEAK });
      }),
    )) as Error;
    expect(failure.message).toContain(
      'breaks the rule "prepares idempotently and reads the exact version"',
    );
    expect(failure.message).not.toContain(LEAK);
    expect(failure.cause).toBeUndefined();
  });

  test('a home that reads back a configuration holding the secret', async () => {
    const { open } = await wrongHome((home) => ({
      readConfiguration: async () => ({
        ...(await home.readConfiguration()),
        text: LEAK,
      }),
    }))();
    const failure = (await rejectionOf(checkBungalow(open))) as Error;
    expect(failure.message).toContain(
      'breaks the rule "configuration writes follow configurationWriteCapability"',
    );
    expect(failure.message).not.toContain(LEAK);
    expect(failure.message).not.toContain(tmpdir());
    expect(failure.cause).toBeUndefined();
  });

  test('a home that opens with a workspace identity that changes', async () => {
    const { open } = await wrongHome((_home, opens) => ({ workspaceId: `${LEAK}-${opens}` }))();
    const failure = (await rejectionOf(checkBungalow(open))) as Error;
    expect(failure.message).toContain(
      'breaks the rule "deploymentId and workspaceId are the same on reopen"',
    );
    expect(failure.message).not.toContain(LEAK);
    expect(failure.cause).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------------------- */
/* The composition the README shows                                                         */
/* ---------------------------------------------------------------------------------------- */

describe('a host that brings its own lock and deployment-secret store conforms', () => {
  const held = new Set<string>();
  function acquireOwnLock(root: string): RootLock {
    if (held.has(root)) throw new BungalowLockedError(root, undefined);
    held.add(root);
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        held.delete(root);
      },
    };
  }

  test('through the check functions', async () => {
    const root = temporaryDirectory();
    await checkRootLock(acquireOwnLock);
    await checkDeploymentSecrets(() => memoryStore());
    await checkSecretProvider((workspaceId) =>
      createLocalSecretProvider({ root: temporaryDirectory(), workspaceId }),
    );
    await checkBungalow((options) =>
      openLocalBungalow({
        name: TEST_NAME,
        root,
        ...options,
        acquireLock: acquireOwnLock,
        deploymentSecrets: ({ assertOpen }) => {
          const store = memoryStore();
          return {
            writable: store.writable,
            read: async (key) => (assertOpen(), store.read(key)),
            write: async (key, value) => (assertOpen(), store.write(key, value)),
            location: (key) => (assertOpen(), store.location(key)),
          };
        },
        secretProvider: (workspaceId) => createLocalSecretProvider({ root, workspaceId }),
      }),
    );
  });
});
