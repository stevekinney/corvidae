import { openBungalow } from '@lostgradient/bungalow';
import type { Storage } from '@lostgradient/storage';
import { rethrow } from '@lostgradient/testing/module-scope-scenario';
import { createPostgresTestServer } from '@lostgradient/testing/postgres-server';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createS3TestServer } from '@lostgradient/testing/s3-server';
import { expect, it } from 'bun:test';
import { startHost } from './host.ts';
import { WORKSPACE_BINDING_KEY } from './locations.ts';
import { createFreshDatabaseUrl, remoteEnvironment } from './remote-backends.test-support.ts';
import { refundScenario } from './server-integration/refund-scenario.test-support.ts';

const scenario1 = await refundScenario(async (onHang) => {
  const database = await createPostgresTestServer();
  onHang(() => database[Symbol.asyncDispose]());
  let bucket: ReturnType<typeof createS3TestServer>;
  try {
    bucket = createS3TestServer();
  } catch (error) {
    await database[Symbol.asyncDispose]();
    throw error;
  }
  onHang(() => bucket.stop());
  let actual: Storage | undefined;
  let decoratedDisposed = false;
  let decorations = 0;
  let replacementCalled = false;
  try {
    const databaseUrl = await createFreshDatabaseUrl(database);
    const environment = remoteEnvironment(databaseUrl, bucket, 'refund-control/');
    const options = {
      environment,
      port: 0,
      async openHome(input: Parameters<typeof openBungalow>[0]) {
        const home = await openBungalow(input);
        options.decorateStorageForTesting = (storage: Storage) => {
          replacementCalled = true;
          return storage;
        };
        return home;
      },
      decorateStorageForTesting(storage: Storage) {
        decorations++;
        actual = storage;
        return new Proxy(storage, {
          get(target, property) {
            if (property === Symbol.dispose)
              return () => {
                decoratedDisposed = true;
              };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    const host = await startHost(options);
    onHang(() => host.close());
    try {
      expect(decorations).toBe(1);
      expect(replacementCalled).toBe(false);
      expect(await actual?.get(WORKSPACE_BINDING_KEY)).not.toBeNull();
      expect(
        await throwingRejectionOf(
          startHost({
            environment: remoteEnvironment(databaseUrl, bucket, 'other-control/'),
            port: 0,
            decorateStorageForTesting(storage) {
              decorations++;
              return storage;
            },
          }),
        ),
      ).toThrow();
      expect(decorations).toBe(1);
    } finally {
      await host.close();
    }
    expect(decoratedDisposed).toBe(false);
    if (!actual) throw new Error('Storage decorator was not called');
    expect(await throwingRejectionOf(actual.get(WORKSPACE_BINDING_KEY))).toThrow();
  } finally {
    await bucket.stop();
    await database[Symbol.asyncDispose]();
  }
});
it('decorates only claimed remote storage and disposes its underlying store', () =>
  rethrow(scenario1));
