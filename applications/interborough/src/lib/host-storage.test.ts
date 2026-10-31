/** Which storage keys the application manages: the request, and what the host may answer. */
import { describe, expect, test } from 'bun:test';

import { urlOf } from './bureau-stub.test-support.ts';
import { getHostStorage, HOST_STORAGE_ROUTE } from './host-storage.ts';

describe('getHostStorage', () => {
  test('asks the host and returns the prefixes it names', async () => {
    const seen: string[] = [];
    const storage = await getHostStorage({
      fetch: async (input) => {
        seen.push(urlOf(input));
        return Response.json({ bureauKeyPrefixes: ['settings', 'skill:'] });
      },
    });
    expect(seen).toEqual([HOST_STORAGE_ROUTE]);
    expect(storage.bureauKeyPrefixes).toEqual(['settings', 'skill:']);
  });

  test('hands the abort signal to the request', async () => {
    const controller = new AbortController();
    let received: AbortSignal | null | undefined;
    await getHostStorage({
      signal: controller.signal,
      fetch: async (_input, init) => {
        received = init?.signal;
        return Response.json({ bureauKeyPrefixes: [] });
      },
    });
    expect(received).toBe(controller.signal);
  });

  test('fails when the host refuses, and when it answers something else', async () => {
    const refused = await getHostStorage({
      fetch: async () => new Response('no', { status: 403 }),
    }).then(
      () => 'resolved',
      (error: unknown) => (error as Error).message,
    );
    expect(refused).toBe('The host answered 403.');
    const wrong = await getHostStorage({
      fetch: async () => Response.json({ elsewhere: 1 }),
    }).then(
      () => 'resolved',
      () => 'rejected',
    );
    expect(wrong).toBe('rejected');
  });
});
