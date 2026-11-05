import { openTemporaryBungalow, type ConfigurationWriteResult } from '@lostgradient/bungalow';
import { expect, test } from 'bun:test';
import { createWorkspaceSecrets } from './workspace-secrets.ts';

test('preparation is invisible until configuration publishes its exact reference', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  await home.deploymentSecrets.write('api-key', 'original');
  const secrets = createWorkspaceSecrets(home);
  const input = { operationId: 'first', key: 'api-key', value: 'next', expectedRevision: null };
  const prepared = await home.secretProvider.prepare(input);
  expect(await secrets.read('api-key')).toBe('original');
  expect(await secrets.publish({ ...input, document: {} })).toMatchObject({ outcome: 'committed' });
  expect(await secrets.read('api-key')).toBe('next');
  const standing = await home.secretProvider.getOperation('first');
  expect(standing?.reference).toEqual(prepared.reference);
  expect(await secrets.publish({ ...input, document: {} })).toMatchObject({ outcome: 'committed' });
});

test('two clients preparing the same revision publish at most one value', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  const first = createWorkspaceSecrets(home);
  const second = createWorkspaceSecrets(home);
  const results = await Promise.all([
    first.publish({
      operationId: 'first',
      key: 'api-key',
      value: 'first',
      expectedRevision: null,
      document: {},
    }),
    second.publish({
      operationId: 'second',
      key: 'api-key',
      value: 'second',
      expectedRevision: null,
      document: {},
    }),
  ]);
  expect(results.map((result) => result.outcome).sort()).toEqual(['committed', 'conflict']);
  const value = await first.read('api-key');
  await second.reconcile();
  expect(await first.read('api-key')).toBe(value);
  const operations = await home.secretProvider.listOperations();
  expect(operations.map((operation) => operation.state).sort()).toEqual(['abandoned', 'published']);
});

test('lost publication response reconciles exact committed binding without retry', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  let calls = 0;
  const secrets = createWorkspaceSecrets({
    ...home,
    async writeConfiguration(text, condition): Promise<ConfigurationWriteResult> {
      calls++;
      await home.writeConfiguration(text, condition);
      return { outcome: 'unknown' };
    },
  });
  const input = {
    operationId: 'lost',
    key: 'api-key',
    value: 'secret',
    expectedRevision: null,
    document: {},
  };
  expect(await secrets.publish(input)).toMatchObject({ outcome: 'committed' });
  expect(await secrets.publish(input)).toMatchObject({ outcome: 'committed' });
  expect(calls).toBe(1);
  expect(await secrets.read('api-key')).toBe('secret');
});

test('uncertain superseded publication remains unknown and retained across replacement', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  let calls = 0;
  const secrets = createWorkspaceSecrets({
    ...home,
    async writeConfiguration(text, condition): Promise<ConfigurationWriteResult> {
      calls++;
      await home.writeConfiguration(text, condition);
      const current = await home.readConfiguration();
      await home.writeConfiguration('{}', { expectedRevision: current.revision });
      return { outcome: 'unknown' };
    },
  });
  const input = {
    operationId: 'lost',
    key: 'api-key',
    value: 'secret',
    expectedRevision: null,
    document: {},
  };
  expect(await secrets.publish(input)).toEqual({ outcome: 'unknown' });
  const replacement = createWorkspaceSecrets(home);
  expect(await replacement.reconcile()).toEqual([{ id: 'lost', state: 'unknown' }]);
  expect(await secrets.publish(input)).toEqual({ outcome: 'unknown' });
  expect(calls).toBe(1);
  const operation = await home.secretProvider.getOperation('lost');
  expect(operation?.state).toBe('unknown');
  expect(await home.secretProvider.readVersion(operation!.reference)).toBe('secret');
});

test('committed configuration activates despite failed provider acknowledgement', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  const provider = home.secretProvider;
  const secrets = createWorkspaceSecrets({
    ...home,
    secretProvider: {
      ...provider,
      async transitionOperation(id, transition) {
        if (transition.to === 'published') throw new Error('provider unavailable');
        return provider.transitionOperation(id, transition);
      },
    },
  });
  expect(
    await secrets.publish({
      operationId: 'ack',
      key: 'api-key',
      value: 'secret',
      expectedRevision: null,
      document: {},
    }),
  ).toMatchObject({ outcome: 'committed' });
  expect(await secrets.read('api-key')).toBe('secret');
  expect(secrets.pending()).toEqual([{ id: 'ack', state: 'publishing' }]);
  const replacement = createWorkspaceSecrets(home);
  expect(await replacement.reconcile()).toEqual([]);
  const standing = await provider.getOperation('ack');
  expect(standing?.state).toBe('published');
});

test('startup abandons never-attempted preparation without exposing it', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  const operation = await home.secretProvider.prepare({
    operationId: 'crash',
    key: 'api-key',
    value: 'secret',
    expectedRevision: null,
  });
  const replacement = createWorkspaceSecrets(home);
  expect(await replacement.reconcile()).toEqual([]);
  expect(await replacement.read('api-key')).toBeUndefined();
  expect(
    await home.secretProvider.readVersion(operation.reference).then(
      () => undefined,
      (error: unknown) => error,
    ),
  ).toBeInstanceOf(Error);
  const standing = await home.secretProvider.getOperation('crash');
  expect(standing?.state).toBe('abandoned');
});

test('malformed injected preparation is rejected before configuration publication', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  const provider = home.secretProvider;
  for (const field of ['id', 'workspaceId', 'key', 'expectedRevision'] as const) {
    let writes = 0;
    const secrets = createWorkspaceSecrets({
      ...home,
      async writeConfiguration() {
        writes++;
        return { outcome: 'committed' };
      },
      secretProvider: {
        ...provider,
        async prepare(input) {
          return { ...(await provider.prepare(input)), [field]: 'incorrect' };
        },
      },
    });
    expect(
      await secrets
        .publish({
          operationId: `bad-${field}`,
          key: 'api-key',
          value: 'secret',
          document: {},
          expectedRevision: null,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    ).toMatchObject({ message: expect.stringContaining('invalid secret operation') });
    expect(writes).toBe(0);
  }
});

test('a crash after claiming publication retains the uncertain version without sending CAS', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  const input = { operationId: 'claimed', key: 'api-key', value: 'secret', expectedRevision: null };
  const prepared = await home.secretProvider.prepare(input);
  await home.secretProvider.transitionOperation('claimed', { from: 'prepared', to: 'publishing' });
  let calls = 0;
  const replacement = createWorkspaceSecrets({
    ...home,
    async writeConfiguration() {
      calls++;
      return { outcome: 'committed' };
    },
  });
  expect(await replacement.reconcile()).toEqual([{ id: 'claimed', state: 'unknown' }]);
  expect(await replacement.publish({ ...input, document: {} })).toEqual({ outcome: 'unknown' });
  expect(calls).toBe(0);
  expect(await home.secretProvider.readVersion(prepared.reference)).toBe('secret');
});

test('rotation retains admitted versions and missing versions never fall back to a legacy key', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  await home.deploymentSecrets.write('api-key', 'legacy');
  const secrets = createWorkspaceSecrets(home);
  await secrets.write('api-key', 'first', 'first');
  const first = await home.secretProvider.getOperation('first');
  await secrets.write('api-key', 'second', 'second');
  await secrets.reconcile();
  expect(await home.secretProvider.readVersion(first!.reference)).toBe('first');
  expect(await secrets.read('api-key')).toBe('second');
  const unavailable = createWorkspaceSecrets({
    ...home,
    secretProvider: {
      ...home.secretProvider,
      async readVersion() {
        throw new Error('secret-value-must-not-leak');
      },
    },
  });
  const error = await unavailable.read('api-key').catch((reason: unknown) => reason);
  expect(error).toMatchObject({ code: 'unavailable' });
  expect(String(error)).not.toContain('secret-value-must-not-leak');
  expect((error as Error).cause).toBeUndefined();
});

test('provider unavailability never changes a pending operation into abandonment', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  await home.secretProvider.prepare({
    operationId: 'pending',
    key: 'api-key',
    value: 'value',
    expectedRevision: null,
  });
  await home.secretProvider.transitionOperation('pending', { from: 'prepared', to: 'publishing' });
  const secrets = createWorkspaceSecrets({
    ...home,
    async readConfiguration() {
      throw new Error('offline');
    },
  });
  expect(await secrets.reconcile()).toEqual([{ id: 'pending', state: 'unknown' }]);
  const standing = await home.secretProvider.getOperation('pending');
  expect(standing?.state).toBe('publishing');
});

test('failed acknowledgement stays visible in reconciliation diagnostics', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  const provider = home.secretProvider;
  const secrets = createWorkspaceSecrets({
    ...home,
    secretProvider: {
      ...provider,
      async transitionOperation(id, transition) {
        if (transition.to === 'published') throw new Error('unavailable');
        return provider.transitionOperation(id, transition);
      },
    },
  });
  await secrets.write('api-key', 'value', 'pending-ack');
  expect(await secrets.reconcile()).toEqual([{ id: 'pending-ack', state: 'publishing' }]);
  expect(await secrets.read('api-key')).toBe('value');
});

test('publication audit evidence hashes the exact document including its version reference', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  const { createHash } = await import('node:crypto');
  const result = await createWorkspaceSecrets(home).publish({
    operationId: 'audit',
    key: 'api-key',
    value: 'not-in-audit',
    document: { plugins: {} },
    expectedRevision: null,
  });
  const snapshot = await home.readConfiguration();
  expect(result.configurationHash).toBe(createHash('sha256').update(snapshot.text!).digest('hex'));
  expect(JSON.stringify(result)).not.toContain('not-in-audit');
});

test('recovery never reclaims an active reference when provider metadata reports a different key', async () => {
  using home = await openTemporaryBungalow({ name: 'secret-test' });
  const original = createWorkspaceSecrets(home);
  await original.write('api-key', 'active-value', 'bound');
  const provider = home.secretProvider;
  const operation = await provider.getOperation('bound');
  if (operation === undefined) throw new Error('Expected a published operation');
  let reclaimed = 0;
  const recovery = createWorkspaceSecrets({
    ...home,
    secretProvider: {
      ...provider,
      async listOperations() {
        return [{ ...operation, key: 'incorrect-metadata-key', state: 'abandoned' as const }];
      },
      async reclaim() {
        reclaimed += 1;
      },
    },
  });
  await recovery.reconcile();
  expect(reclaimed).toBe(0);
  expect(await recovery.read('api-key')).toBe('active-value');
});
