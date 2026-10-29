/**
 * The one `websocket` object the public listener registers. Bun's `serve` takes a single set of
 * WebSocket handlers, and two planes upgrade through it: the engine relay (`engine-proxy.ts`) and
 * the Bureau handler (`createBureauHandler`'s own `upgrade` and `websocket`). Every upgraded
 * socket carries a `plane` tag in `data`, set where its upgrade was accepted, and the handlers
 * here send each event to the plane that owns the socket, so a Bureau socket never reaches the
 * engine relay and an engine socket never reaches Bureau.
 *
 * Neither plane defines `drain`, so there is none to dispatch.
 *
 * @module host-websocket
 */

import type { createBureauHandler } from '@lostgradient/bureau';
import type { ServerWebSocket } from 'bun';

import { webSocketRelayHandlers, type WebSocketRelayData } from './engine-proxy.ts';

/** The Bureau handler the host serves under `/bureau`. */
export type BureauHandler = ReturnType<typeof createBureauHandler>;

/** The socket type Bureau's own `websocket` handlers take. */
type BureauServerWebSocket = Parameters<BureauHandler['websocket']['open']>[0];

/** What Bureau keeps on each of its sockets: its own data, which it fills in as the session opens. */
type BureauWebSocketState = BureauServerWebSocket['data'];

/** What the host keeps for a socket Bureau's handler upgraded: Bureau's data, tagged as Bureau's. */
export type BureauSocketData = BureauWebSocketState & { readonly plane: 'bureau' };

/** What the host keeps for any socket on the public listener, whichever plane upgraded it. */
export type HostSocketData = WebSocketRelayData | BureauSocketData;

/** The part of Bun's server a Bureau upgrade needs, which is all `OperationHandler.upgrade` takes. */
type UpgradeListener = {
  upgrade(request: Request, options: { data: BureauSocketData }): boolean;
};

/**
 * The server Bureau's `upgrade` is handed. Bureau calls `server.upgrade(request, { data })` with
 * the request it was given, which is the one with the `/bureau` prefix removed; Bun can only
 * upgrade the request it received, so this upgrades `original` and adds the Bureau tag to the data
 * Bureau chose.
 */
export function bureauUpgradeServer(
  listener: UpgradeListener,
  original: Request,
): Parameters<BureauHandler['upgrade']>[1] {
  return {
    upgrade: (_request, { data }) =>
      listener.upgrade(original, { data: { ...data, plane: 'bureau' } }),
  };
}

/** Whether `request` asks to become a WebSocket. */
export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function isBureauSocket(
  socket: ServerWebSocket<HostSocketData>,
): socket is ServerWebSocket<BureauSocketData> {
  return socket.data.plane === 'bureau';
}

function isEngineSocket(
  socket: ServerWebSocket<HostSocketData>,
): socket is ServerWebSocket<WebSocketRelayData> {
  return socket.data.plane === 'engine';
}

/**
 * The handlers `Bun.serve` registers: each event goes to the plane that owns the socket. `engine`
 * defaults to the relay's own handlers and is a parameter only so a test can watch which plane an
 * event reached.
 */
export function hostWebSocketHandlers(
  bureau: BureauHandler['websocket'],
  engine: Bun.WebSocketHandler<WebSocketRelayData> = webSocketRelayHandlers,
): Bun.WebSocketHandler<HostSocketData> {
  return {
    open(socket) {
      if (isBureauSocket(socket)) bureau.open(socket);
      else if (isEngineSocket(socket)) return engine.open?.(socket);
    },
    message(socket, message) {
      if (isBureauSocket(socket)) bureau.message(socket, message);
      else if (isEngineSocket(socket)) return engine.message?.(socket, message);
    },
    close(socket, code, reason) {
      if (isBureauSocket(socket)) bureau.close(socket);
      else if (isEngineSocket(socket)) return engine.close?.(socket, code, reason);
    },
  };
}
