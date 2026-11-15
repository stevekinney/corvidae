/**
 * Secret providers. The cases the provider factory alone can express live in `conformance.ts`, and
 * this file runs them against each provider the package ships; the cases that write a provider's
 * files directly, reopen a root, or take no provider stay here.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentSecretProvider } from './environment-secret-provider.ts';

import { afterEach, describe, expect, test } from 'bun:test';

import type { Bungalow } from './bungalow.ts';
import { openLocalBungalow } from './bungalow.ts';
import { describeSecretProvider } from './conformance.ts';
import { TEST_NAME } from './fixtures.test-support.ts';
import {
  SecretProviderError,
  createLocalSecretProvider,
  type SecretProvider,
} from './secret-provider.ts';
import { generateUlid } from './ulid.ts';

const roots: string[] = [];
const homes: Bungalow[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungalow-secrets-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SEED = { key: 'seeded-key', value: 'seeded-value' } as const;

/** The provider of a read-only local home, whose identity is the `deployment-id` it is given. */
async function readOnlyHomeProvider(workspaceId: string): Promise<SecretProvider> {
  const root = temporaryRoot();
  writeFileSync(join(root, 'deployment-id'), `${workspaceId}\n`);
  mkdirSync(join(root, 'secrets'));
  writeFileSync(join(root, 'secrets', SEED.key), SEED.value, { mode: 0o600 });
  const home = await openLocalBungalow({ name: TEST_NAME, root, access: 'read', workspaceId });
  homes.push(home);
  return home.secretProvider;
}

// Each `describe` below also states which branch of the check its subject takes, since a rule that
// does not apply to a provider passes without running.

describe('the local secret provider conforms', () => {
  const create = (workspaceId: string): SecretProvider =>
    createLocalSecretProvider({ root: temporaryRoot(), workspaceId });
  test('can prepare and transition, so the preparation rules apply', () => {
    expect(create('workspace-a').capabilities).toEqual({
      read: true,
      prepare: true,
      transitions: true,
    });
  });
  describeSecretProvider(create);
});

describe('the environment secret provider conforms', () => {
  const create = (workspaceId: string): SecretProvider =>
    createEnvironmentSecretProvider({ workspaceId, values: { [SEED.key]: SEED.value } });
  test('cannot prepare, so the read-only rules apply', () => {
    expect(create('workspace-a').capabilities.prepare).toBe(false);
  });
  describeSecretProvider(create, SEED);
});

describe('the secret provider of a read-only local home conforms', () => {
  test('cannot prepare, so the read-only rules apply', async () => {
    const provider = await readOnlyHomeProvider(generateUlid());
    expect(provider.capabilities.prepare).toBe(false);
    expect(await provider.readLegacy(SEED.key)).toBe(SEED.value);
  });
  describeSecretProvider(readOnlyHomeProvider, SEED);
});

describe('secret providers', () => {
  test('recovers a version written before an operation record', async () => {
    const root = temporaryRoot();
    const provider = createLocalSecretProvider({ root, workspaceId: 'workspace-a' });
    writeFileSync(
      join(root, '.managed-secrets', 'versions', 'op-operation-crash'),
      JSON.stringify({
        workspaceId: 'workspace-a',
        key: 'token',
        operationId: 'operation-crash',
        requestDigest: 'a'.repeat(64),
        expectedRevision: '1',
        value: 'recovered',
      }),
      { mode: 0o600 },
    );
    for (const mismatch of [
      { key: 'other', expectedRevision: '1' },
      { key: 'token', expectedRevision: '2' },
    ]) {
      expect(
        await provider
          .prepare({
            operationId: 'operation-crash',
            value: 'recovered',
            requestDigest: 'a'.repeat(64),
            ...mismatch,
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          ),
      ).toMatchObject({ code: 'conflict' });
    }
    expect(await provider.listOperations()).toHaveLength(1);
    const prepared = await provider.prepare({
      operationId: 'operation-crash',
      key: 'token',
      value: 'recovered',
      requestDigest: 'a'.repeat(64),
      expectedRevision: '1',
    });
    expect(prepared.reference.version).toBe('op-operation-crash');
    expect(await provider.readVersion(prepared.reference)).toBe('recovered');
    expect(await provider.getOperation('operation-crash')).toEqual(prepared);
  });

  test('reopens durable operations and keeps files private', async () => {
    const root = temporaryRoot();
    const first = createLocalSecretProvider({ root, workspaceId: 'workspace-a' });
    const prepared = await first.prepare({
      operationId: 'operation-4',
      key: 'token',
      value: 'plain-value-not-metadata',
      requestDigest: 'a'.repeat(64),
      expectedRevision: '1',
    });
    const second = createLocalSecretProvider({ root, workspaceId: 'workspace-a' });
    expect(await second.getOperation('operation-4')).toEqual(prepared);
    expect(await second.readVersion(prepared.reference)).toBe('plain-value-not-metadata');
    expect(
      statSync(join(root, '.managed-secrets', 'versions', prepared.reference.version)).mode & 0o777,
    ).toBe(0o600);
    const operationText = readFileSync(
      join(root, '.managed-secrets', 'operations', 'operation-4.json'),
      'utf8',
    );
    expect(operationText).not.toContain('plain-value-not-metadata');
  });

  test('environment values are captured and read-only', async () => {
    const values = { token: 'captured' };
    const provider = createEnvironmentSecretProvider({ workspaceId: 'workspace-a', values });
    values.token = 'changed';
    expect(await provider.readLegacy('token')).toBe('captured');
    expect(
      await provider
        .prepare({
          operationId: 'operation-5',
          key: 'token',
          value: 'x',
          requestDigest: 'a'.repeat(64),
          expectedRevision: '1',
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    ).toMatchObject({ code: 'read-only' });
    expect(provider.capabilities.prepare).toBe(false);
  });
});

test('typed errors never carry secret values', () => {
  const error = new SecretProviderError(
    'conflict',
    'The operation is already bound to different input.',
  );
  expect(error.message).not.toContain('secret');
});

test('managed storage preserves every valid legacy flat key name', async () => {
  const root = temporaryRoot();
  mkdirSync(join(root, 'secrets'));
  for (const key of ['workspace-id', 'versions', 'operations']) {
    writeFileSync(join(root, 'secrets', key), `original-${key}`, { mode: 0o600 });
  }
  const provider = createLocalSecretProvider({ root, workspaceId: 'workspace-a' });
  for (const key of ['workspace-id', 'versions', 'operations']) {
    expect(await provider.readLegacy(key)).toBe(`original-${key}`);
  }
});

test('historical versions remain readable but cannot authorize a new preparation', async () => {
  const root = temporaryRoot();
  const provider = createLocalSecretProvider({ root, workspaceId: 'workspace-a' });
  writeFileSync(
    join(root, '.managed-secrets', 'versions', 'op-historical'),
    JSON.stringify({
      workspaceId: 'workspace-a',
      operationId: 'historical',
      key: 'token',
      value: 'preserved',
      expectedRevision: null,
    }),
    { mode: 0o600 },
  );
  const receipt = await provider.getOperation('historical');
  expect(receipt).toBeDefined();
  if (receipt === undefined) throw new Error('Missing recovered receipt');
  expect(await provider.readVersion(receipt.reference)).toBe('preserved');
  expect(
    await provider
      .prepare({
        operationId: 'historical',
        key: 'token',
        value: 'preserved',
        expectedRevision: null,
        requestDigest: 'a'.repeat(64),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      ),
  ).toMatchObject({ code: 'conflict' });
});
