/**
 * What `weft.workers.diagnostics` says about one worker's session lifecycle,
 * spelled out per transport (COR-160).
 *
 * Two things are easy to conflate and are kept apart here. _Registration_ is
 * the server's accepted record of the worker; it exists whenever diagnostics
 * answer at all. _Connection_ is the transport: a WebSocket worker has a
 * socket that can drop while its registration is held for a reconnect grace
 * window, and an HTTP long-poll worker has no persistent connection at all,
 * only a session lease that each poll or heartbeat renews.
 *
 * Lifecycle states come from fields the server reports:
 *
 * - `reconnecting`: a WebSocket worker with `reconnectGraceEndsAt`.
 * - `closing`: `health` is `draining`; finishing in-flight work, taking none new.
 * - `closed`: `health` is `drained`; nothing in flight, nothing accepted. A
 *   worker the server no longer lists is also closed (the caller says so).
 * - `connected`: none of the above.
 *
 * Nothing here is inferred from heartbeat age or any clock the dashboard keeps.
 *
 * @module
 */
import { formatDuration } from '../../lib/format/index.ts';
import { exactTimestamp } from './task-attempt-evidence.ts';
import type { WorkerManifestDiagnostics } from './worker-manifest-diagnostics.ts';

export type SessionInstance = WorkerManifestDiagnostics['instance'];
export type SessionLifecycleState = 'connected' | 'reconnecting' | 'closing' | 'closed';
export type SessionLifecycleVariant = 'success' | 'warning' | 'neutral';

export interface SessionLifecycle {
  readonly state: SessionLifecycleState;
  readonly label: string;
  readonly variant: SessionLifecycleVariant;
  /** The registration, which diagnostics prove by answering at all. */
  readonly registration: string;
  /** The transport connection, which is a different fact. */
  readonly connection: string;
  /** The session deadline, or a plain statement that this transport reports none. */
  readonly deadline: string;
}

/** `in 12 s` or `4 s ago`, against the caller's reference instant. */
function relative(target: number, now: number): string {
  return target >= now
    ? `in ${formatDuration(target - now)}`
    : `${formatDuration(now - target)} ago`;
}

function lifecycleState(instance: SessionInstance): SessionLifecycleState {
  if (instance.reconnectGraceEndsAt !== undefined) return 'reconnecting';
  if (instance.health === 'draining') return 'closing';
  if (instance.health === 'drained') return 'closed';
  return 'connected';
}

const STATE_PRESENTATION: Readonly<
  Record<SessionLifecycleState, { label: string; variant: SessionLifecycleVariant }>
> = {
  connected: { label: 'Connected', variant: 'success' },
  reconnecting: { label: 'Reconnecting', variant: 'warning' },
  closing: { label: 'Closing · draining', variant: 'warning' },
  closed: { label: 'Closed · drained', variant: 'neutral' },
};

function connectionText(instance: SessionInstance, state: SessionLifecycleState): string {
  if (instance.transport === 'long-poll') {
    return 'No persistent connection. An HTTP long-poll worker holds a session lease and polls for work.';
  }
  if (state === 'reconnecting') {
    return 'The socket is disconnected. The server is holding this registration and its leases for a same-id reconnect.';
  }
  return 'The WebSocket is connected.';
}

function deadlineText(instance: SessionInstance, now: number): string {
  if (instance.transport === 'long-poll') {
    if (instance.sessionLeaseExpiresAt === undefined) return 'Session lease expiry not reported';
    const at = exactTimestamp(instance.sessionLeaseExpiresAt);
    return instance.sessionLeaseExpiresAt >= now
      ? `Session lease expires ${at} (${relative(instance.sessionLeaseExpiresAt, now)}) unless a poll or heartbeat renews it`
      : `Session lease expired ${at} (${relative(instance.sessionLeaseExpiresAt, now)}); the server answers the next request 410`;
  }
  if (instance.reconnectGraceEndsAt === undefined) {
    return 'None. A WebSocket session has no lease deadline; a reconnect grace window opens only if its socket drops.';
  }
  const at = exactTimestamp(instance.reconnectGraceEndsAt);
  return instance.reconnectGraceEndsAt >= now
    ? `Reconnect grace window closes ${at} (${relative(instance.reconnectGraceEndsAt, now)}); a same-id reconnect before then resumes the session`
    : `Reconnect grace window closed ${at} (${relative(instance.reconnectGraceEndsAt, now)}); the server is requeueing this worker's in-flight work`;
}

/** Describes one worker's registration, connection, lifecycle state, and session deadline. */
export function describeSessionLifecycle(instance: SessionInstance, now: number): SessionLifecycle {
  const state = lifecycleState(instance);
  return {
    state,
    ...STATE_PRESENTATION[state],
    registration: `Registered with the server on queue ${instance.queue}, generation ${instance.sessionGeneration}`,
    connection: connectionText(instance, state),
    deadline: deadlineText(instance, now),
  };
}
