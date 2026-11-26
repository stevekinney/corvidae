import type { ServerHandle } from '../host.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';

const SERVER_FORCE_STOP_SETTLE_TIMEOUT_MS = 250;

export async function stopServerForShutdown(server: ServerHandle<WebSocketData>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopPromise = Promise.resolve(server.stop(true));
  stopPromise.catch((error: unknown) => {
    console.error('[weft] Bun server stop failed:', error);
  });

  try {
    await Promise.race([
      stopPromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SERVER_FORCE_STOP_SETTLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
