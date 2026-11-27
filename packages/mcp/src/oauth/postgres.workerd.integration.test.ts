import {
  openPostgresTestDatabase,
  postgresTestDatabase,
  requireOpenedPostgresTestDatabase,
} from '@lostgradient/testing/postgres-server';
import { withWorker } from '@lostgradient/workerd-testing';
import { afterAll, describe, expect, test } from 'bun:test';

const entry = new URL('./postgres.workerd-fixture.ts', import.meta.url).pathname;
const database = await openPostgresTestDatabase();

function hyperdriveUrl(url: string): string {
  if (postgresTestDatabase?.kind !== 'cluster') return url;
  const connection = new URL(url);
  connection.password = 'workerd-test';
  return connection.toString();
}

describe.skipIf(database === null)('Postgres OAuth stores through workerd Hyperdrive', () => {
  afterAll(async () => {
    await requireOpenedPostgresTestDatabase(database)[Symbol.asyncDispose]();
  });

  test('registers a client and reads it on a second Worker request', async () => {
    await withWorker(
      {
        entry,
        hyperdrives: {
          HYPERDRIVE: hyperdriveUrl(requireOpenedPostgresTestDatabase(database).url),
        },
      },
      async ({ dispatchFetch }) => {
        const client = {
          issuer: 'https://issuer.test',
          clientId: crypto.randomUUID(),
          name: 'Hyperdrive client',
          redirectUris: ['https://client.test/callback'],
          grantTypes: ['authorization_code'],
          authentication: 'none' as const,
          secretHash: null,
          secretExpiresAt: null,
        };
        const registration = await dispatchFetch('https://issuer.test/client', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(client),
        });
        expect(registration.status).toBe(201);
        expect(await registration.json()).toBe(true);

        const read = await dispatchFetch(
          `https://issuer.test/client?${new URLSearchParams({ id: client.clientId })}`,
        );
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual(client);
      },
    );
  });
});
