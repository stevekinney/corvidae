import { expect, test } from 'bun:test';
import { secretService } from './workspace-secret-service.test-support.ts';
import { createWorkspaceSecrets } from './workspace-secrets.ts';

test('external provider survives client replacement and isolates workspace versions before I/O', async () => {
  await using service = await secretService();
  const first = service.client();
  const manager = createWorkspaceSecrets(first);
  await manager.write('api-key', 'first-value', 'operation-first');
  const operation = await first.secretProvider.getOperation('operation-first');
  const replacement = createWorkspaceSecrets(service.client());
  expect(await replacement.read('api-key')).toBe('first-value');
  const foreign = service.client(1);
  const before = service.valueReads();
  expect(() => foreign.secretProvider.readVersion(operation!.reference)).toThrow();
  expect(service.valueReads()).toBe(before);
  expect(await createWorkspaceSecrets(foreign).read('api-key')).toBeUndefined();
  expect(JSON.stringify(await first.secretProvider.listOperations())).not.toContain('first-value');
});

test('two external clients share idempotent preparation and one publication claim', async () => {
  await using service = await secretService();
  const first = service.client();
  const second = service.client();
  const input = {
    operationId: 'same-operation',
    key: 'api-key',
    value: 'same-value',
    expectedRevision: null,
  };
  const [one, two] = await Promise.all([
    first.secretProvider.prepare(input),
    second.secretProvider.prepare(input),
  ]);
  expect(one.reference).toEqual(two.reference);
  expect(
    await second.secretProvider.prepare({ ...input, expectedRevision: 'another-revision' }).then(
      () => undefined,
      (error: unknown) => error,
    ),
  ).toBeInstanceOf(Error);
  const results = await Promise.all([
    createWorkspaceSecrets(first).publish({ ...input, document: {} }),
    createWorkspaceSecrets(second).publish({ ...input, document: {} }),
  ]);
  expect(results.some((result) => result.outcome === 'committed')).toBe(true);
  expect(await createWorkspaceSecrets(service.client()).read('api-key')).toBe('same-value');
});

test('concurrent remote clients generate one active plugin key using their observed revision', async () => {
  await using service = await secretService();
  const { createPluginManager } = await import('./plugin-manager.ts');
  const { definePlugin } = await import('@lostgradient/interborough-plugin');
  async function manager() {
    const client = service.client();
    return createPluginManager({
      reservedSecretKeys: [],
      reservedSecretPrefixes: [],
      bungalow: {
        ...client,
        mode: 'remote',
        deploymentSecrets: {
          read: async () => undefined,
          write: async () => {
            throw new Error('read-only');
          },
          location: (key) => key,
        },
      },
      plugins: [
        {
          source: 'package',
          location: '@fixture/concurrent-secret',
          descriptor: definePlugin({
            name: 'concurrent-secret',
            version: '1.0.0',
            description: 'Concurrent generation fixture.',
            secrets: [{ key: 'generated-key', generated: true }],
          }),
        },
      ],
      listing: async () => [],
    });
  }
  const [first, second] = await Promise.all([manager(), manager()]);
  try {
    await Promise.all([first.ensureGeneratedSecrets(), second.ensureGeneratedSecrets()]);
    const one = await first.secrets.get('generated-key');
    expect(one).toBeDefined();
    expect(await second.secrets.get('generated-key')).toBe(one);
    const operations = await service.client().secretProvider.listOperations();
    expect(operations.filter((operation) => operation.state === 'published')).toHaveLength(1);
  } finally {
    first.close();
    second.close();
  }
});

test('an external service commits before losing its acknowledgement and replacement clients reconcile', async () => {
  await using service = await secretService();
  const request = {
    operationId: 'lost-http-response',
    key: 'api-key',
    value: 'retained',
    expectedRevision: null,
    document: {},
  };
  service.loseNextAcknowledgement();
  expect(await createWorkspaceSecrets(service.client()).publish(request)).toMatchObject({
    outcome: 'committed',
  });
  const replacement = createWorkspaceSecrets(service.client());
  expect(await replacement.publish(request)).toMatchObject({ outcome: 'committed' });
  expect(service.configurationWrites()).toBe(1);
  expect(await replacement.read('api-key')).toBe('retained');
});
