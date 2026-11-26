import { expect, test } from 'bun:test';

import { withWorker } from '@lostgradient/workerd-testing';

const entry = new URL('./fixture-worker.ts', import.meta.url).pathname;

test('runs D1Storage and OAuthStore in a bundled Worker', async () => {
  await withWorker({ entry, d1Databases: ['DB'] }, async ({ dispatchFetch }) => {
    const success = await dispatchFetch('https://storage.test/conditional/success').then(
      (response) => response.json(),
    );
    expect(success).toEqual({ applied: true, value: 'one' });

    const failure = await dispatchFetch('https://storage.test/conditional/failure').then(
      (response) => response.json(),
    );
    expect(failure).toEqual({ applied: false, version: 'one', created: null });

    const oauth = await dispatchFetch('https://storage.test/oauth').then((response) =>
      response.json(),
    );
    expect(oauth).toMatchObject({
      registered: true,
      client: { clientId: 'fixture-client', name: 'Fixture client' },
    });
  });
});
