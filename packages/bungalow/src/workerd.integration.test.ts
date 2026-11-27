import { withWorker } from '@lostgradient/workerd-testing';
import { describe, expect, test } from 'bun:test';

import type { R2Bucket } from '@lostgradient/object-store';
import { checkBungalow } from './conformance.ts';
import { openBindingBungalow, resolveWorkerBungalowDescriptor } from './index.ts';

const entry = new URL('./workerd-fixture.test-support.ts', import.meta.url).pathname;

describe('Worker bindings', () => {
  test('names invalid Worker entries without inferring their database kind', () => {
    expect(() =>
      resolveWorkerBungalowDescriptor({
        name: 'bungalow-test',
        env: { BUNGALOW_TEST_D1: {}, BUNGALOW_TEST_HYPERDRIVE: {}, BUNGALOW_TEST_BUCKET: {} },
      }),
    ).toThrow('BUNGALOW_TEST_D1');
    expect(() =>
      resolveWorkerBungalowDescriptor({
        name: 'bungalow-test',
        env: { BUNGALOW_TEST_D1: {}, BUNGALOW_TEST_BUCKET: {} },
      }),
    ).toThrow('BUNGALOW_TEST_D1');
  });

  test('opens, reopens, and rejects stale configuration inside the Worker', async () => {
    await withWorker(
      { entry, d1Databases: ['BUNGALOW_TEST_D1'], r2Buckets: ['BUNGALOW_TEST_BUCKET'] },
      async ({ dispatchFetch, getR2Bucket }) => {
        const first = await dispatchFetch('https://worker.test/');
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as Record<string, unknown>;
        expect(firstBody['secret']).toBe('worker-secret');
        expect(firstBody['write']).toEqual({ outcome: 'committed' });
        const second = await dispatchFetch('https://worker.test/reopen');
        expect(second.status).toBe(200);
        const secondBody = (await second.json()) as Record<string, unknown>;
        expect(secondBody['deploymentId']).toBe(firstBody['deploymentId']);
        expect(secondBody['workspaceId']).toBe(firstBody['workspaceId']);
        expect(secondBody['write']).toEqual({ outcome: 'conflict' });
        const bucket = (await getR2Bucket('BUNGALOW_TEST_BUCKET')) as unknown as R2Bucket;
        expect(await bucket.get('deployment-id')).not.toBeNull();
        expect(await bucket.get('workspace-id')).not.toBeNull();
        const foreign = await dispatchFetch('https://worker.test/foreign');
        expect(foreign.status).toBe(409);
        expect(await foreign.text()).toContain('Existing remote state');
      },
    );
  });

  test('runs home conformance against Miniflare D1 and R2 bindings', async () => {
    await withWorker(
      { entry, d1Databases: ['BUNGALOW_TEST_D1'], r2Buckets: ['BUNGALOW_TEST_BUCKET'] },
      async ({ getD1Database, getR2Bucket }) => {
        const bucket = (await getR2Bucket('BUNGALOW_TEST_BUCKET')) as unknown as R2Bucket;
        const descriptor = resolveWorkerBungalowDescriptor({
          name: 'bungalow-test',
          env: {
            BUNGALOW_TEST_D1: await getD1Database('BUNGALOW_TEST_D1'),
            BUNGALOW_TEST_BUCKET: bucket,
            BUNGALOW_TEST_SECRET_API_KEY: 'worker-secret',
          },
        });
        await checkBungalow((options) =>
          openBindingBungalow({
            name: 'bungalow-test',
            descriptor,
            databaseWorkspaceClaim: async () => {},
            writableConfiguration: true,
            ...options,
          }),
        );
        const claims: unknown[] = [];
        const homes = await Promise.all(
          Array.from({ length: 8 }, () =>
            openBindingBungalow({
              name: 'bungalow-test',
              descriptor,
              writableConfiguration: true,
              databaseWorkspaceClaim: async (database) => {
                claims.push(database);
              },
            }),
          ),
        );
        for (const home of homes) home.close();
        expect(claims.every((database) => database === descriptor.database)).toBe(true);
      },
    );
  });
});
