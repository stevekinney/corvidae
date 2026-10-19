/**
 * Reads an AG-UI event stream through `@ag-ui/client`'s own pipeline (`runHttpRequest` for the
 * response body, `transformHttpEventStream` for the Server-Sent Events), and hands the events
 * out as an async iterable, which is what `@lostgradient/chat`'s AG-UI transport takes.
 */
import { runHttpRequest, transformHttpEventStream } from '@ag-ui/client';

type Item =
  | { readonly kind: 'event'; readonly value: unknown }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly error: unknown };

/** The events of the response `open` resolves, in order, ending when the stream does. */
export async function* readEvents(open: () => Promise<Response>): AsyncGenerator<unknown> {
  const queue: Item[] = [];
  let wake: (() => void) | undefined;
  const push = (item: Item): void => {
    queue.push(item);
    wake?.();
  };
  const subscription = transformHttpEventStream(runHttpRequest(open)).subscribe({
    next: (value) => push({ kind: 'event', value }),
    error: (error: unknown) => push({ kind: 'error', error }),
    complete: () => push({ kind: 'done' }),
  });
  try {
    for (;;) {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      wake = undefined;
      const item = queue.shift();
      if (item === undefined || item.kind === 'done') return;
      if (item.kind === 'error') throw item.error;
      yield item.value;
    }
  } finally {
    subscription.unsubscribe();
  }
}
