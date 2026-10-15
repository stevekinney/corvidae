import { resolveLimits } from '../protocol/endpoint-support.ts';
import type { HostEndpointOptions } from '../protocol/host-endpoint.ts';
import { BINARY_FRAME_HEADER_BYTES } from '../protocol/protocol-constants.ts';
import { resolveSessionBudgets } from '../session/session-budgets.ts';
import type { SessionBudgets } from '../session/session-types.ts';
import type { WebSocketLimits } from './websocket-types.ts';

const MEBIBYTE = 1024 * 1024;

/** The permitted range of each transport limit. A value outside it is refused, never clamped. */
export const WEBSOCKET_LIMIT_RANGES = Object.freeze({
  maximumBufferedBytes: { default: MEBIBYTE, minimum: 64 * 1024, maximum: 16 * MEBIBYTE },
  handshakeDeadlineMilliseconds: { default: 10_000, minimum: 250, maximum: 60_000 },
  pingIntervalMilliseconds: { default: 10_000, minimum: 100, maximum: 120_000 },
  authenticateDeadlineMilliseconds: { default: 5_000, minimum: 250, maximum: 60_000 },
  maximumConnections: { default: 64, minimum: 1, maximum: 4_096 },
} as const);

export type ResolvedWebSocketLimits = {
  readonly endpoint: HostEndpointOptions;
  /** The largest message the socket accepts: a binary frame's header plus its payload budget. */
  readonly maxPayloadLength: number;
  readonly maximumBufferedBytes: number;
  readonly handshakeDeadlineMilliseconds: number;
  readonly pingIntervalMilliseconds: number;
  readonly authenticateDeadlineMilliseconds: number;
  readonly maximumConnections: number;
  readonly budgets: SessionBudgets;
};

function within(name: keyof typeof WEBSOCKET_LIMIT_RANGES, value: number | undefined): number {
  const range = WEBSOCKET_LIMIT_RANGES[name];
  const resolved = value ?? range.default;
  if (!Number.isInteger(resolved) || resolved < range.minimum || resolved > range.maximum) {
    throw new RangeError(
      `${name} must be an integer from ${range.minimum} to ${range.maximum}, got ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Validate the transport limits against the same ranges the protocol and session use, so a
 * mistake fails when the server is built and not on the first client. The payload ceiling the
 * socket enforces is derived from the frame budget the client is told, so the two cannot drift.
 */
export function resolveWebSocketLimits(
  limits: WebSocketLimits = {},
  overrides: Partial<SessionBudgets> = {},
): ResolvedWebSocketLimits {
  const budgets = resolveSessionBudgets(overrides);
  const advertised = resolveLimits({
    ...(limits.maxFrameBytes === undefined ? {} : { maxFrameBytes: limits.maxFrameBytes }),
    maxQueuedOperations: limits.maxQueuedOperations ?? budgets.operationQueueLimit,
  });
  if (advertised.maxQueuedOperations < budgets.operationQueueLimit) {
    throw new RangeError(
      `maxQueuedOperations (${advertised.maxQueuedOperations}) must cover the session's operation FIFO (${budgets.operationQueueLimit})`,
    );
  }
  return {
    endpoint: advertised,
    maxPayloadLength: BINARY_FRAME_HEADER_BYTES + advertised.maxFrameBytes,
    maximumBufferedBytes: within('maximumBufferedBytes', limits.maximumBufferedBytes),
    handshakeDeadlineMilliseconds: within(
      'handshakeDeadlineMilliseconds',
      limits.handshakeDeadlineMilliseconds,
    ),
    pingIntervalMilliseconds: within('pingIntervalMilliseconds', limits.pingIntervalMilliseconds),
    authenticateDeadlineMilliseconds: within(
      'authenticateDeadlineMilliseconds',
      limits.authenticateDeadlineMilliseconds,
    ),
    maximumConnections: within('maximumConnections', limits.maximumConnections),
    budgets,
  };
}
