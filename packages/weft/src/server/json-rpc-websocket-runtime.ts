import type { ServerWebSocket } from 'bun';

import type { FleetEventFeed } from './fleet-event-feed.ts';
import {
  createJsonRpcWebSocketSession,
  type JsonRpcWebSocketSession,
} from './json-rpc-websocket.ts';
import type { OperationRegistry } from './operation-catalog.ts';
import { anonymousPrincipal, type Principal } from './principal.ts';
import type { ConnectionLease } from './runtime/context.ts';
import type { WorkflowEventFeed } from './workflow-event-feed.ts';

export type ConnectionType = 'worker' | 'stream' | 'watch' | 'generic' | 'jsonrpc';

export interface WebSocketData {
  pathname: string;
  connectionType: ConnectionType;
  workflowId?: string;
  resumeFrom?: number;
  queue?: string;
  workerId?: string;
  workerRegistered?: boolean;
  workerProtocolVersion?: number;
  streamLastDeliveredSequence?: number;
  streamReplayInProgress?: boolean;
  pendingStreamMessages?: Array<{ sequence: number; message: string }>;
  watchLastDeliveredSequence?: number;
  watchReplayInProgress?: boolean;
  pendingWatchMessages?: Array<{ sequence: number; message: string }>;
  workflowStreamConnectionAccepted?: boolean;
  workflowWebSocketConnectionLease?: ConnectionLease;
  principal?: Principal;
  jsonRpcSession?: JsonRpcWebSocketSession;
  /** Current workspace authority, captured from the authenticated upgrade request. */
  revalidateWorkspace?: () => Promise<boolean>;
  /** Serialize admission checks without waiting for admitted operations to finish. */
  workspaceRequestTail?: Promise<void>;
  /** Preserve outgoing frame order while each frame resolves current authority. */
  workspaceReleaseTail?: Promise<void>;
  /** Fence pending checks and frames after revocation or socket closure. */
  workspaceClosed?: boolean;
}

async function workspaceAllowed(
  ws: Pick<ServerWebSocket<WebSocketData>, 'data' | 'close'>,
): Promise<boolean> {
  if (ws.data.workspaceClosed) return false;
  let allowed = false;
  try {
    allowed = (await ws.data.revalidateWorkspace?.()) ?? true;
  } catch {
    /* Fail closed. */
  }
  if (ws.data.workspaceClosed) return false;
  if (!allowed) {
    ws.data.workspaceClosed = true;
    ws.close(1008, 'Workspace membership required');
    await ws.data.jsonRpcSession?.close();
  }
  return allowed;
}

function workspaceEmitter(ws: Pick<ServerWebSocket<WebSocketData>, 'data' | 'send' | 'close'>) {
  return {
    send(message: string): void {
      if (ws.data.revalidateWorkspace === undefined) {
        ws.send(message);
        return;
      }
      ws.data.workspaceReleaseTail = (ws.data.workspaceReleaseTail ?? Promise.resolve())
        .then(async () => {
          if (await workspaceAllowed(ws)) ws.send(message);
          return undefined;
        })
        .catch(() => {
          ws.data.workspaceClosed = true;
          ws.close(1011, 'Workspace stream closed');
        });
    },
  };
}

async function admitWorkspaceMessage(
  ws: Pick<ServerWebSocket<WebSocketData>, 'data' | 'close'>,
  session: JsonRpcWebSocketSession,
  text: string,
): Promise<void> {
  if (!(await workspaceAllowed(ws))) return;
  void session.handleMessage(text).catch(() => {
    ws.data.workspaceClosed = true;
    ws.close(1011, 'Workspace request failed');
  });
}

export function handleJsonRpcWebSocketMessage(
  ws: Pick<ServerWebSocket<WebSocketData>, 'data' | 'close'>,
  rawMessage: string | Buffer,
): void {
  const session = ws.data.jsonRpcSession;
  if (!session) {
    console.error('[weft] /jsonrpc WS frame received with no session attached — closing');
    ws.close(1011, 'no jsonrpc session attached');
    return;
  }

  const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
  if (ws.data.revalidateWorkspace !== undefined) {
    ws.data.workspaceRequestTail = (ws.data.workspaceRequestTail ?? Promise.resolve())
      .then(() => admitWorkspaceMessage(ws, session, text))
      .catch(() => {
        ws.data.workspaceClosed = true;
        ws.close(1011, 'Workspace request failed');
      });
    return;
  }
  session.handleMessage(text).catch((error) => {
    console.error('[weft] /jsonrpc WS message error', error);
  });
}

export function openJsonRpcWebSocketSession(options: {
  ws: Pick<ServerWebSocket<WebSocketData>, 'data' | 'send' | 'close'>;
  registry: OperationRegistry;
  engine: unknown;
  feed: WorkflowEventFeed;
  fleetFeed?: FleetEventFeed;
  acquireWorkflowSubscription?: () => ConnectionLease;
  acquireFleetSubscription?: () => ConnectionLease;
  activeSessions: Set<JsonRpcWebSocketSession>;
}): void {
  try {
    const session = createJsonRpcWebSocketSession({
      registry: options.registry,
      engine: options.engine,
      principal: options.ws.data.principal ?? anonymousPrincipal(),
      emitter: workspaceEmitter(options.ws),
      feed: options.feed,
      ...(options.fleetFeed !== undefined ? { fleetFeed: options.fleetFeed } : {}),
      ...(options.acquireWorkflowSubscription !== undefined
        ? { acquireWorkflowSubscription: options.acquireWorkflowSubscription }
        : {}),
      ...(options.acquireFleetSubscription !== undefined
        ? { acquireFleetSubscription: options.acquireFleetSubscription }
        : {}),
      transport: 'jsonRpcWebSocket',
    });
    options.ws.data.jsonRpcSession = session;
    options.activeSessions.add(session);
  } catch (error) {
    console.error('[weft] /jsonrpc WS session construction failed', error);
    options.ws.close(1011, 'session construction failed');
  }
}

export function openGenericJsonRpcWebSocketSession(options: {
  ws: Pick<ServerWebSocket<WebSocketData>, 'data' | 'send' | 'close'>;
  registry: OperationRegistry;
  host: unknown;
  activeSessions: Set<JsonRpcWebSocketSession>;
  discoverDocument?: () => Record<string, unknown>;
}): void {
  try {
    const session = createJsonRpcWebSocketSession({
      registry: options.registry,
      engine: options.host,
      principal: options.ws.data.principal ?? anonymousPrincipal(),
      emitter: workspaceEmitter(options.ws),
      transport: 'jsonRpcWebSocket',
      ...(options.discoverDocument === undefined
        ? {}
        : { discoverDocument: options.discoverDocument }),
    });
    options.ws.data.jsonRpcSession = session;
    options.activeSessions.add(session);
  } catch (error) {
    console.error('[weft] generic JSON-RPC WS session construction failed', error);
    options.ws.close(1011, 'session construction failed');
  }
}

export function closeJsonRpcWebSocketSession(options: {
  session: JsonRpcWebSocketSession | undefined;
  activeSessions: Set<JsonRpcWebSocketSession>;
}): void {
  const { session, activeSessions } = options;
  if (!session) return;

  activeSessions.delete(session);
  void session.close().catch((error) => {
    console.error('[weft] /jsonrpc WS session close error', error);
  });
}

export async function closeJsonRpcSessionsForShutdown(
  activeSessions: Set<JsonRpcWebSocketSession>,
): Promise<void> {
  const closes: Array<Promise<void>> = [];
  for (const session of activeSessions) {
    closes.push(
      session.close().catch((error) => {
        console.error('[weft] /jsonrpc WS session close error during shutdown', error);
      }),
    );
  }
  activeSessions.clear();
  await Promise.allSettled(closes);
}
