import { openBungalow } from '@lostgradient/bungalow';
import {
  openPostgresTestDatabase,
  requireOpenedPostgresTestDatabase,
} from '@lostgradient/testing/postgres-server';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createS3TestServer } from '@lostgradient/testing/s3-server';
import { afterAll, expect, test } from 'bun:test';

import {
  claimWorkspaceBinding,
  createHostStorage,
  disposeHostStorage,
  WORKSPACE_BINDING_KEY,
} from './locations.ts';
import { createFreshDatabaseUrl, remoteEnvironment } from './remote-backends.test-support.ts';

const database = await openPostgresTestDatabase();
requireOpenedPostgresTestDatabase(database);
afterAll(async () => {
  await database?.[Symbol.asyncDispose]();
});

test('different prefixes and connection URLs cannot bind the same raw database', async () => {
  const server = createS3TestServer();
  const url = await createFreshDatabaseUrl(database);
  const alternate = new URL(url);
  alternate.password = 'alternate-credential';
  const stores = [url, alternate.toString()].map((connection) =>
    createHostStorage({ kind: 'postgres', url: connection }),
  );
  try {
    const outcomes = await Promise.allSettled(
      stores.map((storage, index) =>
        openBungalow({
          name: 'interborough',
          environment: remoteEnvironment(
            index === 0 ? url : alternate.toString(),
            server,
            `home-${index}`,
          ),
          databaseWorkspaceClaim: async (_url, prefix, workspaceId) =>
            claimWorkspaceBinding(storage, prefix, workspaceId),
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const binding = await stores[0]!.get(WORKSPACE_BINDING_KEY);
    expect(binding).not.toBeNull();
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled') {
        expect(JSON.parse(new TextDecoder().decode(binding!))).toMatchObject({
          workspaceId: outcome.value.workspaceId,
        });
        expect(server.objects().has(`home-${index}/workspace-id`)).toBe(true);
        outcome.value.close();
      } else {
        expect(server.objects().has(`home-${index}/workspace-id`)).toBe(false);
        expect(
          [...server.objects().keys()].filter(
            (key) => key.startsWith(`home-${index}/`) && key !== `home-${index}/deployment-id`,
          ),
        ).toEqual([]);
      }
    }
  } finally {
    for (const storage of stores) await disposeHostStorage(storage);
    await server.stop();
  }
});

test('concurrent openers of one prefix share its persisted database binding', async () => {
  const server = createS3TestServer();
  const url = await createFreshDatabaseUrl(database);
  const stores = [0, 1].map(() => createHostStorage({ kind: 'postgres', url }));
  try {
    const opened = await Promise.all(
      stores.map((storage) =>
        openBungalow({
          name: 'interborough',
          environment: remoteEnvironment(url, server, 'shared'),
          databaseWorkspaceClaim: async (_url, prefix, workspaceId) =>
            claimWorkspaceBinding(storage, prefix, workspaceId),
        }),
      ),
    );
    expect(opened[0]!.workspaceId).toBe(opened[1]!.workspaceId);
    for (const bungalow of opened) bungalow.close();
  } finally {
    for (const storage of stores) await disposeHostStorage(storage);
    await server.stop();
  }
});

test('existing database data without an identity refuses before publishing any identity', async () => {
  const server = createS3TestServer();
  const url = await createFreshDatabaseUrl(database);
  const storage = createHostStorage({ kind: 'postgres', url });
  try {
    const original = new TextEncoder().encode('existing session');
    await storage.put('session:existing', original);
    expect(
      await throwingRejectionOf(
        openBungalow({
          name: 'interborough',
          environment: remoteEnvironment(url, server, 'missing'),
          databaseWorkspaceClaim: async (_url, prefix, workspaceId) =>
            claimWorkspaceBinding(storage, prefix, workspaceId),
        }),
      ),
    ).toThrow('Restore');
    expect(server.objects().size).toBe(0);
    expect(await storage.get('session:existing')).toEqual(original);
    expect(await storage.get(WORKSPACE_BINDING_KEY)).toBeNull();
  } finally {
    await disposeHostStorage(storage);
    await server.stop();
  }
});
