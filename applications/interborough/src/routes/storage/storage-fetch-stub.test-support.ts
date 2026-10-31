import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';

/**
 * Test-only `globalThis.fetch` stub for component tests exercising
 * `storage-client.ts` calls through a mounted `.svelte` component (rather
 * than calling the client functions directly, as `storage-client.test.ts`'s
 * `ScriptedFetch` does). Never imported by production code.
 */
export interface StubbedFetchCall {
  readonly url: string;
  readonly method: string;
  /** The request body when it was a string (a JSON-RPC envelope, for example) or a blob (a key's value), as text. */
  readonly body?: string;
  /** The abort signal the request was made with, when it had one. */
  readonly signal?: AbortSignal;
}

export function stubStorageFetch(
  handler: (call: StubbedFetchCall) => Response | Promise<Response>,
): { calls: StubbedFetchCall[]; restore: () => void } {
  const calls: StubbedFetchCall[] = [];

  const restore = installFetchImplementation(async (input, init) => {
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Blob
          ? await init.body.text()
          : undefined;
    const call: StubbedFetchCall = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      ...(body === undefined ? {} : { body }),
      ...(init?.signal ? { signal: init.signal } : {}),
    };
    calls.push(call);
    return handler(call);
  });

  return {
    calls,
    restore,
  };
}
