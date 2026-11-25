/**
 * Conformance checks for what Bungalow lets a host bring: a lock, a deployment-secret store, a
 * secret provider, or a whole home. Each `check…` function rejects with a message naming the first
 * rule the subject breaks; each `describe…` function registers the same rules as cases of the
 * runner it is given (`{ describe, test }` from `bun:test` or `node:test`), so a failing rule is a
 * failing case. A failure names the subject and the rule and nothing else: no compared value, key,
 * path, or cause, because the subject may hold a secret. A check makes its own temporary roots or
 * asks the factory it is given for a fresh subject, and removes or releases what it made.
 *
 * The module imports no test runner, so it loads on Bun and Node alike. It is still reachable only
 * through `@lostgradient/bungalow/conformance` and never from the package's index.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AcquireLock, Bungalow } from './bungalow.ts';
import { expect } from './conformance-expect.ts';
import type { DeploymentSecrets } from './deployment-secrets.ts';
import { BungalowInputError, BungalowLockedError, BungalowStateError } from './errors.ts';
import type { RootLock } from './lock.ts';
import {
  encode,
  type SecretProvider,
  type SecretProviderCapabilities,
  type SecretReference,
} from './secret-provider.ts';
import { generateUlid } from './ulid.ts';

/** A key and value a store or provider was seeded with, for one that cannot write them itself. */
export type ConformanceSeed = {
  /** The key the subject was seeded with. */
  readonly key: string;
  /** The value the subject holds for that key. */
  readonly value: string;
};

type Rule = { readonly name: string; readonly run: () => Promise<void> };

/**
 * Run one rule. A rule's failure is what an assertion printed or what the subject threw, and either
 * can hold the values the check exists to keep out (a seeded secret, a key, a path), so a failure
 * is replaced by one that names only the subject and the rule, and carries no cause.
 */
async function runRule(subject: string, rule: Rule): Promise<void> {
  try {
    await rule.run();
  } catch {
    throw new Error(`${subject} breaks the rule "${rule.name}".`);
  }
}

/** Run `rules` in order; the first to fail rejects with its name. */
async function runRules(subject: string, rules: readonly Rule[]): Promise<void> {
  for (const rule of rules) await runRule(subject, rule);
}

/**
 * The two functions of a test runner the `describe…` functions register cases with. `bun:test`
 * and `node:test` both provide them: pass `{ describe, test }` from either.
 */
export type ConformanceRunner = {
  /** Group the cases of one subject under `name`. */
  readonly describe: (name: string, body: () => void) => unknown;
  /** Register one rule as a case. */
  readonly test: (name: string, body: () => Promise<void>) => unknown;
};

/** Register each rule as one case under a `describe` block. */
function registerRules(runner: ConformanceRunner, subject: string, rules: readonly Rule[]): void {
  const { describe, test } = runner;
  describe(subject, () => {
    for (const rule of rules) test(rule.name, () => runRule(subject, rule));
  });
}

/** What `action` threw or rejected with, or `undefined` when it succeeded. */
async function failureOf(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

const INVALID_KEYS = ['', 'UPPER', 'has space', '../escape', 'a/b', '-leading', 'with.dot'];

/* ------------------------------------------------------------------------------------------ */
/* Root lock                                                                                  */
/* ------------------------------------------------------------------------------------------ */

function lockRules(acquireLock: AcquireLock): readonly Rule[] {
  /** Run `use` against a fresh root, and release whatever it acquired before removing the root. */
  const onFreshRoot =
    (use: (root: string, acquire: () => Promise<RootLock>) => Promise<void>) =>
    async (): Promise<void> => {
      const root = mkdtempSync(join(tmpdir(), 'bungalow-lock-conformance-'));
      const held: RootLock[] = [];
      const acquire = async (): Promise<RootLock> => {
        const lock = await acquireLock(root);
        held.push(lock);
        return lock;
      };
      try {
        await use(root, acquire);
      } finally {
        for (const lock of held) {
          try {
            lock.release();
          } catch {
            // Teardown: the rule's own failure is the one worth reporting.
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    };
  return [
    {
      name: 'a second acquisition of a held root throws BungalowLockedError',
      run: onFreshRoot(async (_root, acquire) => {
        await acquire();
        expect(await failureOf(acquire)).toBeInstanceOf(BungalowLockedError);
      }),
    },
    {
      name: 'release allows the next acquisition',
      run: onFreshRoot(async (_root, acquire) => {
        (await acquire()).release();
        expect(await failureOf(acquire)).toBeUndefined();
      }),
    },
    {
      name: 'release is safe to call twice',
      run: onFreshRoot(async (_root, acquire) => {
        const first = await acquire();
        first.release();
        expect(await failureOf(() => first.release())).toBeUndefined();
        expect(await failureOf(acquire)).toBeUndefined();
      }),
    },
  ];
}

/**
 * Check a single-instance lock: a second acquisition of a held root throws `BungalowLockedError`,
 * release allows the next acquisition, and release is safe to call twice. The check makes its own
 * temporary root. Rejects with a message naming the first rule broken.
 */
export async function checkRootLock(acquireLock: AcquireLock): Promise<void> {
  await runRules('The lock', lockRules(acquireLock));
}

/** Register the rules of {@link checkRootLock} as cases of `runner`. */
export function describeRootLock(runner: ConformanceRunner, acquireLock: AcquireLock): void {
  registerRules(runner, 'root lock conformance', lockRules(acquireLock));
}

/* ------------------------------------------------------------------------------------------ */
/* Deployment secrets                                                                         */
/* ------------------------------------------------------------------------------------------ */

type DeploymentSecretsFactory = () => DeploymentSecrets | Promise<DeploymentSecrets>;

function deploymentSecretsRules(
  create: DeploymentSecretsFactory,
  givenSeed: ConformanceSeed | undefined,
): readonly Rule[] {
  // The caller owns the seed and the rules read it after an await, so take a copy now.
  const seed = givenSeed === undefined ? undefined : { key: givenSeed.key, value: givenSeed.value };
  return [
    {
      name: 'writable is a boolean',
      run: async () => {
        const store = await create();
        expect(typeof store.writable).toBe('boolean');
      },
    },
    {
      name: 'an unwritten key reads undefined',
      run: async () => {
        const store = await create();
        expect(await store.read('conformance-unwritten')).toBeUndefined();
      },
    },
    {
      name: 'on a writable store, a written key reads back',
      run: async () => {
        const store = await create();
        if (!store.writable) return;
        const value = `conformance-value-${generateUlid()}`;
        await store.write('conformance-key', value);
        expect(await store.read('conformance-key')).toBe(value);
      },
    },
    {
      name: 'on a store that is not writable, write rejects',
      run: async () => {
        const store = await create();
        if (store.writable) return;
        expect(
          await failureOf(() => store.write('conformance-key', 'conformance-value')),
        ).toBeDefined();
      },
    },
    {
      name: 'a seeded key reads its seeded value',
      run: async () => {
        if (seed === undefined) return;
        const store = await create();
        expect(await store.read(seed.key)).toBe(seed.value);
      },
    },
    {
      name: 'read and write reject an invalid key with BungalowInputError',
      run: async () => {
        const store = await create();
        for (const key of INVALID_KEYS) {
          expect(
            await failureOf(() => store.read(key)),
            `read ${JSON.stringify(key)}`,
          ).toBeInstanceOf(BungalowInputError);
          expect(
            await failureOf(() => store.write(key, 'conformance-value')),
            `write ${JSON.stringify(key)}`,
          ).toBeInstanceOf(BungalowInputError);
        }
      },
    },
    {
      name: 'location returns a string that does not contain the secret value',
      run: async () => {
        const store = await create();
        let key = 'conformance-key';
        let value = `conformance-value-${generateUlid()}`;
        if (store.writable) await store.write(key, value);
        else if (seed === undefined) value = '';
        else ({ key, value } = seed);
        const location = store.location(key);
        expect(typeof location).toBe('string');
        if (value !== '') expect(location).not.toContain(value);
      },
    },
  ];
}

/**
 * Check a deployment-secret store. `create` returns a fresh store each call. For a store that is
 * not writable, pass the key and value it was seeded with. Covers: an unwritten key reads
 * `undefined`; on a writable store a written key reads back; `write` rejects when `writable` is
 * `false`; `read` and `write` reject an invalid key with `BungalowInputError`; and `location`
 * returns a string that does not contain the secret's value. Rejects with a message naming the
 * first rule broken.
 */
export async function checkDeploymentSecrets(
  create: DeploymentSecretsFactory,
  seed?: ConformanceSeed,
): Promise<void> {
  await runRules('The deployment secrets', deploymentSecretsRules(create, seed));
}

/** Register the rules of {@link checkDeploymentSecrets} as cases of `runner`. */
export function describeDeploymentSecrets(
  runner: ConformanceRunner,
  create: DeploymentSecretsFactory,
  seed?: ConformanceSeed,
): void {
  registerRules(runner, 'deployment secrets conformance', deploymentSecretsRules(create, seed));
}

/* ------------------------------------------------------------------------------------------ */
/* Secret provider                                                                            */
/* ------------------------------------------------------------------------------------------ */

type SecretProviderFactory = (workspaceId: string) => SecretProvider | Promise<SecretProvider>;

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

function providerRule(
  create: SecretProviderFactory,
  name: string,
  applies: (capabilities: SecretProviderCapabilities) => boolean,
  body: (provider: SecretProvider) => Promise<void>,
): Rule {
  return {
    name,
    run: async () => {
      const provider = await create(generateUlid());
      if (applies(provider.capabilities)) await body(provider);
    },
  };
}

function secretProviderRules(
  create: SecretProviderFactory,
  givenSeed: ConformanceSeed | undefined,
): readonly Rule[] {
  // The caller owns the seed and the rules read it after an await, so take a copy now.
  const seed = givenSeed === undefined ? undefined : { key: givenSeed.key, value: givenSeed.value };
  const prepares = (capabilities: SecretProviderCapabilities): boolean => capabilities.prepare;
  const preparesAndTransitions = (capabilities: SecretProviderCapabilities): boolean =>
    capabilities.prepare && capabilities.transitions;
  const cannotPrepare = (capabilities: SecretProviderCapabilities): boolean =>
    !capabilities.prepare;
  const reference = (provider: SecretProvider): SecretReference =>
    encode({
      workspaceId: provider.workspaceId,
      key: 'conformance-key',
      version: 'op-conformance-never-written',
    });
  const rule = (
    name: string,
    applies: (capabilities: SecretProviderCapabilities) => boolean,
    body: (provider: SecretProvider) => Promise<void>,
  ): Rule => providerRule(create, name, applies, body);

  return [
    rule('prepares idempotently and reads the exact version', prepares, async (provider) => {
      const first = await provider.prepare({
        operationId: 'operation-1',
        key: 'api-key',
        value: 'secret',
        requestDigest: DIGEST,
        expectedRevision: '7',
      });
      expect(
        await provider.prepare({
          operationId: 'operation-1',
          key: 'api-key',
          value: 'secret',
          requestDigest: DIGEST,
          expectedRevision: '7',
        }),
      ).toEqual(first);
      expect(await provider.readVersion(first.reference)).toBe('secret');
      expect(
        await failureOf(() =>
          provider.prepare({
            operationId: 'operation-1',
            key: 'api-key',
            value: 'changed',
            requestDigest: OTHER_DIGEST,
            expectedRevision: '7',
          }),
        ),
      ).toMatchObject({ code: 'conflict' });
      expect(
        await failureOf(() =>
          provider.prepare({
            operationId: 'operation-1',
            key: 'api-key',
            value: 'secret',
            requestDigest: DIGEST,
            expectedRevision: '8',
          }),
        ),
      ).toMatchObject({ code: 'conflict' });
      expect(
        await failureOf(() =>
          provider.prepare({
            operationId: 'operation-1',
            key: 'api-key',
            value: 'secret',
            requestDigest: DIGEST,
            expectedRevision: null,
          }),
        ),
      ).toMatchObject({ code: 'conflict' });
    }),
    rule(
      'enforces the publication state machine and redacts operation records',
      preparesAndTransitions,
      async (provider) => {
        const prepared = await provider.prepare({
          operationId: 'operation-2',
          key: 'token',
          value: 'do-not-persist-in-metadata',
          requestDigest: DIGEST,
          expectedRevision: '1',
        });
        const operations = await provider.listOperations();
        expect(operations[0]).toEqual(prepared);
        expect(
          await failureOf(() =>
            provider.transitionOperation('operation-2', {
              from: 'prepared',
              to: 'published',
            } as never),
          ),
        ).toMatchObject({ code: 'rejected' });
        expect(
          await failureOf(() =>
            provider.transitionOperation('operation-2', { from: 'publishing', to: 'published' }),
          ),
        ).toMatchObject({ code: 'conflict' });
        const publishing = await provider.transitionOperation('operation-2', {
          from: 'prepared',
          to: 'publishing',
        });
        const published = await provider.transitionOperation('operation-2', {
          from: 'publishing',
          to: 'published',
        });
        expect(publishing.state).toBe('publishing');
        expect(published.state).toBe('published');
      },
    ),
    rule('rejects a foreign reference before reading the backend', prepares, async (first) => {
      const second = await create(generateUlid());
      const prepared = await first.prepare({
        operationId: 'operation-3',
        key: 'token',
        value: 'secret',
        requestDigest: DIGEST,
        expectedRevision: '1',
      });
      expect(await failureOf(() => second.readVersion(prepared.reference))).toMatchObject({
        code: 'rejected',
      });
    }),
    rule('reclaims only an abandoned version', preparesAndTransitions, async (provider) => {
      const prepared = await provider.prepare({
        operationId: 'operation-reclaim',
        key: 'token',
        value: 'temporary',
        requestDigest: DIGEST,
        expectedRevision: null,
      });
      expect(await failureOf(() => provider.reclaim(prepared.reference))).toMatchObject({
        code: 'conflict',
      });
      await provider.transitionOperation('operation-reclaim', {
        from: 'prepared',
        to: 'abandoned',
      });
      await provider.reclaim(prepared.reference);
      await provider.reclaim(prepared.reference);
      expect(await failureOf(() => provider.readVersion(prepared.reference))).toMatchObject({
        code: 'missing',
      });
    }),
    rule(
      'maximum-length operation identifiers produce readable references',
      prepares,
      async (provider) => {
        const operation = await provider.prepare({
          operationId: 'a'.repeat(160),
          key: 'token',
          value: 'value',
          requestDigest: DIGEST,
          expectedRevision: null,
        });
        expect(await provider.readVersion(operation.reference)).toBe('value');
        expect(await provider.getOperation('a'.repeat(160))).toEqual(operation);
      },
    ),
    rule(
      'logical receipts accept randomized encodings but reject a different request',
      prepares,
      async (provider) => {
        const input = {
          operationId: 'logical-retry',
          key: 'token',
          value: 'ciphertext-one',
          expectedRevision: '1',
          requestDigest: DIGEST,
        };
        const first = await provider.prepare(input);
        const retry = await provider.prepare({ ...input, value: 'ciphertext-two' });
        expect(retry).toEqual(first);
        expect(await provider.readVersion(retry.reference)).toBe('ciphertext-one');
        expect(
          await failureOf(() => provider.prepare({ ...input, requestDigest: OTHER_DIGEST })),
        ).toMatchObject({ code: 'conflict' });
        expect(JSON.stringify(await provider.listOperations())).not.toContain(input.requestDigest);
      },
    ),
    {
      name: 'rejects malformed request digests without disclosing input',
      run: async () => {
        for (const requestDigest of [
          '',
          'A'.repeat(64),
          'a'.repeat(63),
          'private-invalid-digest',
        ]) {
          const provider = await create(generateUlid());
          if (!provider.capabilities.prepare) return;
          expect(
            await failureOf(() =>
              provider.prepare({
                operationId: 'invalid',
                key: 'token',
                value: 'secret',
                expectedRevision: null,
                requestDigest,
              }),
            ),
            `request digest ${JSON.stringify(requestDigest)}`,
          ).toMatchObject({ message: 'A secret value and expected revision are required.' });
        }
      },
    },
    rule(
      'readLegacy of a key never written resolves undefined',
      cannotPrepare,
      async (provider) => {
        expect(await provider.readLegacy('conformance-unwritten')).toBeUndefined();
      },
    ),
    rule(
      'readLegacy of the seeded key resolves the seeded value',
      cannotPrepare,
      async (provider) => {
        if (seed !== undefined) expect(await provider.readLegacy(seed.key)).toBe(seed.value);
      },
    ),
    rule('prepare rejects with code read-only', cannotPrepare, async (provider) => {
      expect(
        await failureOf(() =>
          provider.prepare({
            operationId: 'operation-read-only',
            key: 'token',
            value: 'secret',
            requestDigest: DIGEST,
            expectedRevision: null,
          }),
        ),
      ).toMatchObject({ code: 'read-only' });
    }),
    rule('transitionOperation rejects with code read-only', cannotPrepare, async (provider) => {
      expect(
        await failureOf(() =>
          provider.transitionOperation('operation-read-only', {
            from: 'prepared',
            to: 'publishing',
          }),
        ),
      ).toMatchObject({ code: 'read-only' });
    }),
    rule('reclaim rejects with code read-only', cannotPrepare, async (provider) => {
      expect(await failureOf(() => provider.reclaim(reference(provider)))).toMatchObject({
        code: 'read-only',
      });
    }),
    rule(
      'readVersion of a reference that names no stored version rejects',
      cannotPrepare,
      async (provider) => {
        expect(await failureOf(() => provider.readVersion(reference(provider)))).toBeDefined();
      },
    ),
  ];
}

/**
 * Check a managed secret provider. `create` returns a fresh provider for the workspace identity it
 * is given, and the check passes a different ULID each call. The rules come from the provider's own
 * `capabilities`. A provider that can prepare must keep preparation idempotent, enforce the
 * publication state machine, refuse a foreign reference, reclaim only an abandoned version, and
 * refuse a malformed request digest without echoing it. A provider that cannot prepare must resolve
 * `readLegacy` of an unwritten key as `undefined` and, given `seed`, of the seeded key as its
 * value; must reject `prepare`, `transitionOperation`, and `reclaim` with code `read-only`; and
 * must reject `readVersion` of a reference that names no stored version, with any code. Cases that
 * write the provider's files directly or reopen its root are not here. Rejects with a message
 * naming the first rule broken.
 */
export async function checkSecretProvider(
  create: SecretProviderFactory,
  seed?: ConformanceSeed,
): Promise<void> {
  await runRules('The secret provider', secretProviderRules(create, seed));
}

/** Register the rules of {@link checkSecretProvider} as cases of `runner`. */
export function describeSecretProvider(
  runner: ConformanceRunner,
  create: SecretProviderFactory,
  seed?: ConformanceSeed,
): void {
  registerRules(runner, 'secret provider conformance', secretProviderRules(create, seed));
}

/* ------------------------------------------------------------------------------------------ */
/* Home                                                                                       */
/* ------------------------------------------------------------------------------------------ */

type OpenHome = (options: { workspaceId?: string }) => Promise<Bungalow>;

/** Open a home, run `use` against it, and close it, whether `use` succeeded or not. */
async function withHome<Result>(
  open: OpenHome,
  options: { workspaceId?: string },
  use: (home: Bungalow) => Promise<Result> | Result,
): Promise<Result> {
  const home = await open(options);
  let result: Result;
  try {
    result = await use(home);
  } catch (error) {
    try {
      home.close();
    } catch {
      // The rule already failed; its error is the one worth reporting.
    }
    throw error;
  }
  home.close();
  return result;
}

const RESERVED_CONTENT_NAMES = ['secrets', 'logs', 'lock', 'deployment-id'];
const MALFORMED_CONTENT_NAMES = [
  '',
  'UPPER',
  'has space',
  '../escape',
  'a/b',
  '-leading',
  'with.dot',
  '.hidden',
];

function homeRules(open: OpenHome): readonly Rule[] {
  const rule = (name: string, run: () => Promise<void>): Rule => ({ name, run });
  return [
    rule('deploymentId and workspaceId are the same on reopen', async () => {
      const first = await withHome(open, {}, (home) => ({
        deploymentId: home.deploymentId,
        workspaceId: home.workspaceId,
      }));
      expect(first.deploymentId).not.toBe('');
      expect(first.workspaceId).not.toBe('');
      const second = await withHome(open, {}, (home) => ({
        deploymentId: home.deploymentId,
        workspaceId: home.workspaceId,
      }));
      expect(second).toEqual(first);
    }),
    rule('a different configured workspaceId is refused', async () => {
      const { workspaceId } = await withHome(open, {}, (home) => ({
        workspaceId: home.workspaceId,
      }));
      await withHome(open, { workspaceId }, (home) => {
        expect(home.workspaceId).toBe(workspaceId);
      });
      let opened: Bungalow | undefined;
      const failure = await failureOf(async () => {
        opened = await open({ workspaceId: `${workspaceId}-other` });
      });
      opened?.close();
      expect(failure).toBeDefined();
    }),
    rule('the methods and deployment secrets throw BungalowStateError after close', async () => {
      const home = await open({});
      home.close();
      const key = 'conformance-key';
      const calls: readonly [string, () => unknown][] = [
        ['content', () => home.content('conformance-content')],
        ['objectStore', () => home.objectStore()],
        ['readConfiguration', () => home.readConfiguration()],
        ['writeConfiguration', () => home.writeConfiguration('{}', { expectedRevision: null })],
        ['deploymentSecrets.read', () => home.deploymentSecrets.read(key)],
        ['deploymentSecrets.write', () => home.deploymentSecrets.write(key, 'conformance-value')],
        ['deploymentSecrets.location', () => home.deploymentSecrets.location(key)],
      ];
      for (const [member, call] of calls) {
        expect(await failureOf(call), member).toBeInstanceOf(BungalowStateError);
      }
    }),
    rule('close is idempotent', async () => {
      const home = await open({});
      home.close();
      expect(await failureOf(() => home.close())).toBeUndefined();
    }),
    rule('content refuses reserved and malformed names', async () => {
      await withHome(open, {}, async (home) => {
        for (const name of [...RESERVED_CONTENT_NAMES, ...MALFORMED_CONTENT_NAMES]) {
          expect(await failureOf(() => home.content(name)), JSON.stringify(name)).toBeInstanceOf(
            BungalowInputError,
          );
        }
      });
    }),
    rule('capabilities are booleans and the same on reopen', async () => {
      const capabilitiesOf = (home: Bungalow) => ({
        sharedBetweenInstances: home.capabilities.sharedBetweenInstances,
        personalMachine: home.capabilities.personalMachine,
      });
      const first = await withHome(open, {}, capabilitiesOf);
      expect(typeof first.sharedBetweenInstances).toBe('boolean');
      expect(typeof first.personalMachine).toBe('boolean');
      expect(await withHome(open, {}, capabilitiesOf)).toEqual(first);
    }),
    rule('configuration writes follow configurationWriteCapability', async () => {
      await withHome(open, {}, async (home) => {
        const capability = home.configurationWriteCapability;
        expect(['writable', 'read-only', 'unsupported']).toContain(capability);
        if (capability !== 'writable') {
          expect(await home.writeConfiguration('{}', { expectedRevision: null })).toEqual({
            outcome: capability,
          });
          return;
        }
        let current = await home.readConfiguration();
        if (current.revision === null) {
          const created = `{"conformance":"${generateUlid()}"}`;
          expect(await home.writeConfiguration(created, { expectedRevision: null })).toEqual({
            outcome: 'committed',
          });
          current = await home.readConfiguration();
          expect(current.text).toBe(created);
        }
        const replaced = `{"conformance":"${generateUlid()}"}`;
        expect(
          await home.writeConfiguration(replaced, { expectedRevision: current.revision }),
        ).toEqual({ outcome: 'committed' });
        const after = await home.readConfiguration();
        expect(after.text).toBe(replaced);
        expect(after.revision).not.toBe(current.revision);
        const stale = `{"conformance":"${generateUlid()}"}`;
        expect(
          await home.writeConfiguration(stale, { expectedRevision: current.revision }),
        ).toEqual({ outcome: 'conflict' });
        expect(await home.writeConfiguration(stale, { expectedRevision: null })).toEqual({
          outcome: 'conflict',
        });
        const unchanged = await home.readConfiguration();
        expect(unchanged.text).toBe(replaced);
      });
    }),
    rule('deployment secrets follow writable', async () => {
      await withHome(open, {}, async (home) => {
        const store = home.deploymentSecrets;
        expect(typeof store.writable).toBe('boolean');
        if (!store.writable) {
          expect(
            await failureOf(() => store.write('conformance-key', 'conformance-value')),
          ).toBeDefined();
          return;
        }
        const value = `conformance-value-${generateUlid()}`;
        await store.write('conformance-key', value);
        expect(await store.read('conformance-key')).toBe(value);
      });
    }),
  ];
}

/**
 * Check a whole home. `open` opens the same backing home on every call, with the workspace identity
 * the options give or the home's own, and the check closes what it opens before it opens again.
 * The rules come from the handle: `deploymentId` and `workspaceId` are the same on reopen; a
 * different configured `workspaceId` is refused; `content`, `objectStore`, `readConfiguration`,
 * `writeConfiguration`, and the members of `deploymentSecrets` throw `BungalowStateError` after
 * `close` (a secret provider is not asked to: its factory is given no way to know); `close` is
 * idempotent; `content` refuses reserved and malformed names; and
 * `capabilities.sharedBetweenInstances` and `capabilities.personalMachine` are booleans and the
 * same on reopen. When `configurationWriteCapability` is `'writable'`, configuration create,
 * replace, and conflict succeed and conflict as specified; otherwise `writeConfiguration` resolves
 * the outcome of the same name. When `deploymentSecrets.writable` is `true`, a written key reads
 * back; when it is `false`, `write` rejects. Rejects with a message naming the first rule broken.
 */
export async function checkBungalow(open: OpenHome): Promise<void> {
  await runRules('The home', homeRules(open));
}

/** Register the rules of {@link checkBungalow} as cases of `runner`. */
export function describeBungalow(runner: ConformanceRunner, open: OpenHome): void {
  registerRules(runner, 'home conformance', homeRules(open));
}
