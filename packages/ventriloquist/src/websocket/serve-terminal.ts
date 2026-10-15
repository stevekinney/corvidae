import { createBunProcessFactory } from './bun-process-factory.ts';
import { createTerminalWebSocketServer, type TerminalWebSocketServer } from './websocket-server.ts';
import type { SocketData, TerminalWebSocketServerOptions } from './websocket-types.ts';

export type ServeTerminalOptions = Omit<TerminalWebSocketServerOptions, 'createProcess'> &
  Partial<Pick<TerminalWebSocketServerOptions, 'createProcess'>> & {
    readonly port?: number;
    /** Bind to a specific interface. Required for the loopback development switch to apply. */
    readonly hostname?: string;
    readonly tls?: Bun.TLSOptions;
    /** The only path that upgrades; everything else is a 404. Defaults to `/terminal`. */
    readonly path?: string;
  };

export type ServedTerminal = {
  readonly server: Bun.Server<SocketData>;
  readonly terminal: TerminalWebSocketServer;
};

/**
 * Start a `Bun.serve` listener that does nothing but the terminal upgrade. Applications that
 * serve other routes build the server with `createTerminalWebSocketServer` and call `handleUpgrade`
 * from their own `fetch`.
 */
export function serveTerminalWebSocket(options: ServeTerminalOptions): ServedTerminal {
  const path = options.path ?? '/terminal';
  const terminal = createTerminalWebSocketServer({
    ...options,
    createProcess: options.createProcess ?? createBunProcessFactory(),
  });
  const server = Bun.serve<SocketData>({
    port: options.port ?? 0,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    fetch: (request, listener) =>
      new URL(request.url).pathname === path
        ? terminal.handleUpgrade(request, listener)
        : new Response(null, { status: 404 }),
    websocket: terminal.websocket,
  });
  return { server, terminal };
}
