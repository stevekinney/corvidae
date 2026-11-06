import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentSecretProvider } from './environment-secret-provider.ts';

import { afterEach, describe, expect, test } from 'bun:test';

import { SecretProviderError, createLocalSecretProvider } from './secret-provider.ts';

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungalow-secrets-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function local() {
  return createLocalSecretProvider({
    root: temporaryRoot(),
    workspaceId: 'workspace-a',
  });
}

describe('secret providers', () => {
  test('prepares idempotently and reads the exact version', async () => {
    const provider = local();
    const first = await provider.prepare({
      operationId: 'operation-1',
      key: 'api-key',
      value: 'secret',
      requestDigest: 'a'.repeat(64),
      expectedRevision: '7',
    });
    expect(
      await provider.prepare({
        operationId: 'operation-1',
        key: 'api-key',
        value: 'secret',
        requestDigest: 'a'.repeat(64),
        expectedRevision: '7',
      }),
    ).toEqual(first);
    expect(await provider.readVersion(first.reference)).toBe('secret');
    expect(
      await provider
        .prepare({
          operationId: 'operation-1',
          key: 'api-key',
          value: 'changed',
          requestDigest: 'b'.repeat(64),
          expectedRevision: '7',
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    ).toMatchObject({ code: 'conflict' });
    expect(
      await provider
        .prepare({
          operationId: 'operation-1',
          key: 'api-key',
          value: 'secret',
          requestDigest: 'a'.repeat(64),
          expectedRevision: '8',
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    ).toMatchObject({ code: 'conflict' });
    expect(
      await provider
        .prepare({
          operationId: 'operation-1',
          key: 'api-key',
          value: 'secret',
          requestDigest: 'a'.repeat(64),
          expectedRevision: null,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    ).toMatchObject({ code: 'conflict' });
  });

  test('enforces the publication state machine and redacts operation records', async () => {
    const provider = local();
    const prepared = await provider.prepare({
      operationId: 'operation-2',
      key: 'token',
      value: 'do-not-persist-in-metadata',
      requestDigest: 'a'.repeat(64),
      expectedRevision: '1',
    });
    const operations = await provider.listOperations();
    expect(operations[0]).toEqual(prepared);
    expect(
      await provider
        .transitionOperation('operation-2', {
          from: 'prepared',
          to: 'published',
        } as never)
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    ).toMatchObject({ code: 'rejected' });
    expect(
      await provider
        .transitionOperation('operation-2', { from: 'publishing', to: 'published' })
        .then(
          () => undefined,
          (error: unknown) => error,
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
  });

  test('rejects a foreign reference before reading the backend', async () => {
    const first = local();
    const second = createLocalSecretProvider({
      root: temporaryRoot(),
      workspaceId: 'workspace-b',
    });
    const prepared = await first.prepare({
      operationId: 'operation-3',
      key: 'token',
      value: 'secret',
      requestDigest: 'a'.repeat(64),
      expectedRevision: '1',
    });
    expect(
      await second.readVersion(prepared.reference).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toMatchObject({
      code: 'rejected',
    });
  });

  test('reclaims only an abandoned version', async () => {
    const provider = local();
    const prepared = await provider.prepare({
      operationId: 'operation-reclaim',
      key: 'token',
      value: 'temporary',
      requestDigest: 'a'.repeat(64),
      expectedRevision: null,
    });
    expect(
      await provider.reclaim(prepared.reference).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toMatchObject({ code: 'conflict' });
    await provider.transitionOperation('operation-reclaim', { from: 'prepared', to: 'abandoned' });
    await provider.reclaim(prepared.reference);
    await provider.reclaim(prepared.reference);
    expect(
      await provider.readVersion(prepared.reference).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toMatchObject({
      code: 'missing',
    });
  });

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

test('maximum-length operation identifiers produce readable references', async () => {
  const provider = local();
  const operation = await provider.prepare({
    operationId: 'a'.repeat(160),
    key: 'token',
    value: 'value',
    requestDigest: 'a'.repeat(64),
    expectedRevision: null,
  });
  expect(await provider.readVersion(operation.reference)).toBe('value');
  expect(await provider.getOperation('a'.repeat(160))).toEqual(operation);
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

test('logical receipts accept randomized encodings but reject a different request', async () => {
  const provider = local();
  const input = {
    operationId: 'logical-retry',
    key: 'token',
    value: 'ciphertext-one',
    expectedRevision: '1',
    requestDigest: 'a'.repeat(64),
  };
  const first = await provider.prepare(input);
  const retry = await provider.prepare({ ...input, value: 'ciphertext-two' });
  expect(retry).toEqual(first);
  expect(await provider.readVersion(retry.reference)).toBe('ciphertext-one');
  expect(
    await provider.prepare({ ...input, requestDigest: 'b'.repeat(64) }).then(
      () => undefined,
      (error: unknown) => error,
    ),
  ).toMatchObject({ code: 'conflict' });
  expect(JSON.stringify(await provider.listOperations())).not.toContain(input.requestDigest);
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

test.each(['', 'A'.repeat(64), 'a'.repeat(63), 'private-invalid-digest'])(
  'rejects malformed request digests without disclosing input: %s',
  async (requestDigest) => {
    expect(
      await local()
        .prepare({
          operationId: 'invalid',
          key: 'token',
          value: 'secret',
          expectedRevision: null,
          requestDigest,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    ).toMatchObject({ message: 'A secret value and expected revision are required.' });
  },
);
