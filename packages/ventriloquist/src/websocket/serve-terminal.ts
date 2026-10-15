import { createBunProcessFactory } from './bun-process-factory.ts';
import { createTerminalWebSocketServer, type TerminalWebSocketServer } from './websocket-server.ts';
import type { SocketData, TerminalWebSocketServerOptions } from './websocket-types.ts';

export type ServeTerminalOptions = Omit<
  TerminalWebSocketServerOptions,
  'createProcess' | 'boundHostname'
> &
  Partial<Pick<TerminalWebSocketServerOptions, 'createProcess'>> & {
    readonly port?: number;
    /**
     * Bind to a specific interface. Required with `allowInsecureLoopback`, and then it must be
     * `127.0.0.1` (or any 127.x address), `::1` or `localhost`; anything else throws.
     */
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
  // The bound hostname comes from `hostname` alone: a property smuggled in past the type, or left
  // over from another options object, must not let a wildcard bind claim loopback.
  const { boundHostname: _injected, ...supplied } = options as typeof options & {
    boundHostname?: unknown;
  };
  const terminal = createTerminalWebSocketServer({
    ...supplied,
    createProcess: options.createProcess ?? createBunProcessFactory(),
    // `Bun.serve({ port })` listens on every interface but reports `localhost`, so the hostname that
    // is bound, not the one reported, is what the development switch is judged by.
    ...(options.hostname === undefined ? {} : { boundHostname: options.hostname }),
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
