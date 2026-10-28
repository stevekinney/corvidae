/**
 * Page reload after a development rebuild (COR-1745).
 *
 * The development host (`startHost({ development: true })`) serves a Server-Sent Events stream at
 * {@link DEV_RELOAD_ROUTE}. Each page `dev.ts` serves opens it through a small client script the
 * host injects into `index.html` at request time, and the host sends one `reload` event down every
 * open stream after each successful rebuild. A production host registers neither the route nor the
 * script, and the build never writes the script into `build/`, so nothing a person deploys carries
 * it.
 *
 * Events are not replayed: a page that connects after a rebuild has already loaded that rebuild's
 * output, so it waits for the next one. Each event's data is the number of rebuilds since the host
 * started, which lets a test tell a fresh event from a stale one.
 *
 * @module dev-reload
 */

/** The path of the reload stream. It exists only on a development host. */
export const DEV_RELOAD_ROUTE = '/__dev/reload';

/** The event name the host sends and the client script listens for. */
export const DEV_RELOAD_EVENT = 'reload';

/**
 * The client script. It reloads the page on a `reload` event, and also when the stream comes back
 * after a loss: `bun --watch` restarts the whole process when the host's own modules change, which
 * drops the stream, and `EventSource` reconnects on its own once the new process is listening.
 */
export const DEV_RELOAD_CLIENT = `<script>
(() => {
  const source = new EventSource(${JSON.stringify(DEV_RELOAD_ROUTE)});
  let lost = false;
  source.addEventListener(${JSON.stringify(DEV_RELOAD_EVENT)}, () => location.reload());
  source.addEventListener('error', () => {
    lost = true;
  });
  source.addEventListener('open', () => {
    if (lost) location.reload();
  });
})();
</script>`;

/** `html` with {@link DEV_RELOAD_CLIENT} before its last `</body>`, or at its end when it has none. */
export function injectDevReloadClient(html: string): string {
  const end = html.toLowerCase().lastIndexOf('</body>');
  if (end === -1) return `${html}\n${DEV_RELOAD_CLIENT}\n`;
  return `${html.slice(0, end)}${DEV_RELOAD_CLIENT}\n${html.slice(end)}`;
}

/** The open reload streams of one development host. */
export type DevReload = {
  /** Open a stream for a page: a `text/event-stream` response that stays open until it is closed. */
  connect(): Response;
  /** Send one `reload` event to every open stream. */
  notify(): void;
  /** End every open stream. Later `connect` calls answer 503, so a closing host takes no new page. */
  close(): void;
  /** How many streams are open. */
  connectionCount(): number;
};

/** Create the registry of reload streams for one host. */
export function createDevReload(): DevReload {
  const encoder = new TextEncoder();
  const connections = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let rebuilds = 0;
  let closed = false;

  /** Write to a stream, dropping it when it can no longer take a write. */
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, text: string): void => {
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      connections.delete(controller);
    }
  };

  return {
    connect() {
      if (closed) return new Response('The development host is shutting down.', { status: 503 });
      let opened: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          opened = controller;
          connections.add(controller);
          // A comment line flushes the response headers, so the page's `EventSource` opens now.
          send(controller, ': connected\n\n');
        },
        cancel() {
          if (opened !== undefined) connections.delete(opened);
        },
      });
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    },
    notify() {
      rebuilds += 1;
      for (const controller of connections) {
        send(controller, `event: ${DEV_RELOAD_EVENT}\ndata: ${rebuilds}\n\n`);
      }
    },
    close() {
      closed = true;
      for (const controller of connections) {
        connections.delete(controller);
        try {
          controller.close();
        } catch {
          // Already closed or errored by its reader: nothing is left to end.
        }
      }
    },
    connectionCount: () => connections.size,
  };
}
