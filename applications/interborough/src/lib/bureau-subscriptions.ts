/**
 * What the followers of the Bureau's event feeds (`bureau.tasks.events`, `bureau.settings.events`)
 * need beside the generated subscription methods: the moment the Bureau accepted the stream, and a
 * refusal as the `HttpClientError` the console's treatments read (`classifyFault`, `./faults.ts`).
 * Reconnecting and backing off stay with each follower.
 */
import {
  CatalogClientError,
  type CatalogFetch,
  type SubscriptionMessage,
} from '@lostgradient/backchannel/client';
import { HttpClientError } from '@lostgradient/weft';

import type { Fetcher } from './bureau-client.ts';

/** The code the transport gives a stream that reports an error (an `event: error` frame). */
const STREAM_ERROR_CODE = -32000;

/**
 * The `fetch` a feed is opened with: the call's own, or the global one, which calls `onOpen` once
 * the Bureau has accepted the subscription, before any event arrives, and `onData` once the first
 * bytes of the stream arrive, a heartbeat included, which the subscription's messages leave out.
 */
export function acceptedFetch(options: {
  readonly fetch?: Fetcher | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly onData?: (() => void) | undefined;
}): CatalogFetch {
  return async (input, init) => {
    // The global is read at the call, so a replacement installed after the follower exists is used.
    const response = await (options.fetch ?? globalThis.fetch)(input, init);
    const contentType = response.headers.get('content-type');
    if (
      !response.ok ||
      contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream'
    ) {
      return response;
    }
    options.onOpen?.();
    if (options.onData === undefined || response.body === null) return response;
    const onData = options.onData;
    let seen = false;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (!seen) {
            seen = true;
            onData();
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** One event of a feed with the id to resume after it. */
export type FeedEvent<Data> = { readonly id: string; readonly data: Data };

/**
 * The events of a feed, without the replay marker. A refusal throws the `HttpClientError` the
 * response's status makes; a stream that reports an error, or ends, ends this generator, so the
 * follower resumes it as it does any end.
 */
export async function* eventsOf<Data>(
  messages: AsyncIterable<SubscriptionMessage<Data>>,
  noun: string,
): AsyncGenerator<FeedEvent<Data>, void, void> {
  try {
    for await (const message of messages) {
      if (message.type === 'event') yield { id: message.id, data: message.data };
    }
  } catch (error) {
    if (error instanceof CatalogClientError) {
      if (error.code === STREAM_ERROR_CODE) return;
      if (error.code >= 400 && error.code <= 599) {
        // A refusal on the REST surface is a flat `{ error: <message> }`, and its status is what
        // says what kind of fault it is; a body with no words is told in the stream's own.
        throw new HttpClientError(
          error.code,
          saysWhy(error.data) ? error.message : `The ${noun} answered ${error.code}.`,
        );
      }
    }
    throw error;
  }
}

/** Whether a refusal's body carried a message of its own. */
function saysWhy(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  return (
    typeof Reflect.get(body, 'message') === 'string' ||
    typeof Reflect.get(body, 'error') === 'string'
  );
}
