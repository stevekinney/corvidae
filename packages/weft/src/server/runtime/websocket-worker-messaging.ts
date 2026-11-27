/**
 * Low-level send/close primitives for the worker WebSocket protocol.
 *
 * Split out as a leaf module so both `websocket-worker.ts` (task/heartbeat
 * handling) and `websocket-worker-registration.ts` (registration handling)
 * can depend on it without forming an import cycle between those two.
 *
 * @module server/runtime/websocket-worker-messaging
 */

import type { Socket } from '@lostgradient/node-host';

import {
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
  type ProtocolErrorMessage,
  type RegisterErrorMessage,
} from '../../worker/protocol.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';

const WORKER_PROTOCOL_CLOSE_CODE = 1002;
const WORKER_REGISTRATION_CLOSE_CODE = 1008;

export function sendWorkerProtocolMessage(
  ws: Socket<WebSocketData>,
  message: ProtocolErrorMessage | RegisterErrorMessage | Record<string, unknown>,
): void {
  ws.send(JSON.stringify(message));
}

export function closeWorkerSocket(ws: Socket<WebSocketData>, code: number, reason: string): void {
  try {
    ws.unsubscribe(ws.data.pathname);
  } catch {
    // The socket may already be detached from the subscription set.
  }
  ws.close(code, reason);
  setTimeout(() => {
    try {
      ws.terminate();
    } catch {
      // The peer may have already completed the close handshake.
    }
  }, 10);
}

export function rejectRegistration(
  ws: Socket<WebSocketData>,
  code: RegisterErrorMessage['code'],
  message: string,
  requestedProtocolVersion?: number,
): void {
  sendWorkerProtocolMessage(ws, {
    type: 'registerError',
    code,
    message,
    supportedProtocolVersions: REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
    ...(requestedProtocolVersion !== undefined ? { requestedProtocolVersion } : {}),
  });
  closeWorkerSocket(ws, WORKER_REGISTRATION_CLOSE_CODE, code);
}

export function rejectProtocolMessage(
  ws: Socket<WebSocketData>,
  code: ProtocolErrorMessage['code'],
  message: string,
): void {
  sendWorkerProtocolMessage(ws, { type: 'protocolError', code, message });
  closeWorkerSocket(ws, WORKER_PROTOCOL_CLOSE_CODE, code);
}
