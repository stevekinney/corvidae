import type { ConnectionLease } from './connection-lease.ts';
import type { OperationRegistry } from './operation-catalog.ts';
import type { Principal } from './principal.ts';

export type JsonRpcWebSocketEmitter = {
  send(message: string): void;
};

export type JsonRpcWebSocketSessionOptions = {
  readonly registry: OperationRegistry;
  readonly engine: unknown;
  readonly principal: Principal;
  readonly emitter: JsonRpcWebSocketEmitter;
  /**
   * The host's workflow event feed, handed to `weft.workflows.subscribe` as `host.feed`. The
   * session only checks that it is present; the operation that reads it knows its type.
   */
  readonly feed?: unknown;
  /** The host's fleet event feed, handed to `weft.events.subscribe` as `host.fleetFeed`. */
  readonly fleetFeed?: unknown;
  readonly acquireWorkflowSubscription?: () => ConnectionLease;
  readonly acquireFleetSubscription?: () => ConnectionLease;
  readonly maxSubscriptions?: number;
  readonly maxFrameBytes?: number;
  readonly transport?: 'jsonRpcHttp' | 'jsonRpcWebSocket' | 'jsonRpcStdio';
  readonly discoverDocument?: () => Record<string, unknown>;
};

export type JsonRpcWebSocketSession = {
  handleMessage(frame: string): Promise<void>;
  close(): Promise<void>;
};
