import { isIP } from 'node:net';
import { systemClock } from '../session/session-clock.ts';
import { createOriginPolicy } from './origin-policy.ts';
import { TerminalConnection, type TerminalSocket } from './terminal-connection.ts';
import { decideTransport, isLoopbackListener, normalizeAddress } from './transport-policy.ts';
import { resolveWebSocketLimits } from './websocket-limits.ts';
import type {
  Authentication,
  DenialReason,
  SocketData,
  TerminalWebSocketServerOptions,
} from './websocket-types.ts';

/** The slice of `Bun.Server` the upgrade uses, so the gate can be driven without a listener. */
export type UpgradeServer = {
  upgrade(request: Request, options: { readonly data: SocketData }): boolean;
  requestIP(request: Request): { readonly address: string } | null;
};

/** A WebSocket as Bun hands it to a handler: the surface a connection drives, plus its binary mode. */
export type ServerSocket = TerminalSocket & { binaryType?: string };

/**
 * The handlers `Bun.serve` takes as `websocket`, spread with the limits the server derived. They are
 * the frozen callback shapes from the contract: `handleOpen`, `handleMessage` and `handleClose`.
 */
export type TerminalWebSocketHandlers = {
  readonly maxPayloadLength: number;
  readonly backpressureLimit: number;
  readonly closeOnBackpressureLimit: true;
  readonly sendPings: false;
  readonly perMessageDeflate: false;
  open(socket: Bun.ServerWebSocket<SocketData>): Promise<void>;
  message(socket: Bun.ServerWebSocket<SocketData>, frame: string | Uint8Array): Promise<void>;
  close(socket: Bun.ServerWebSocket<SocketData>, code: number, reason: string): Promise<void>;
  pong(socket: Bun.ServerWebSocket<SocketData>): void;
};

export type TerminalWebSocketServer = {
  /** Gate and upgrade one request: every check runs before `server.upgrade` is called. */
  handleUpgrade(request: Request, server: UpgradeServer): Promise<Response | undefined>;
  /** The `websocket` option for `Bun.serve`: the three handlers below plus the limits the server derived. */
  readonly websocket: TerminalWebSocketHandlers;
  /**
   * The frozen contract callbacks. Bun's `open` carries no request, so the upgrade request is
   * consumed by `handleUpgrade` and its trusted result rides on `socket.data`.
   */
  handleOpen(socket: ServerSocket): Promise<void>;
  handleMessage(socket: ServerSocket, frame: Uint8Array | string): Promise<void>;
  handleClose(socket: ServerSocket, code: number, reason: string): Promise<void>;
  /** Revoke every attachment of `subject`: input freezes and cleanup starts. Returns how many. */
  revokeSubject(subject: string): Promise<number>;
  /**
   * Revoke the attachment of one subject's session. A session identity is chosen by the client and
   * only unique within a subject's slot, so both must match. Returns whether one was live.
   */
  revokeSession(subject: string, sessionId: string): Promise<boolean>;
  /** Sockets that are open and not yet finished. */
  readonly connectionCount: number;
  /** Revoke everything and wait for each connection to finish. The listener is the caller's to stop. */
  close(): Promise<void>;
};

const DENIAL_STATUS: Readonly<Record<DenialReason, number>> = {
  unauthenticated: 401,
  expired: 401,
  forbidden: 403,
  unavailable: 503,
};

/** The only query parameter the upgrade URL may carry. Anything else is refused, never read. */
const ALLOWED_PARAMETERS: ReadonlySet<string> = new Set(['profile']);

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function refuse(status: number, error: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

/**
 * The profile identifier the upgrade URL names, or why the URL cannot be used. The URL may carry
 * exactly one parameter, `profile`; any other key is refused rather than read, because credentials
 * travel in the host's HttpOnly cookie and a denylist of credential names would always be one short.
 */
function readProfile(request: Request): { profileId: string } | { error: string } {
  const { searchParams } = new URL(request.url);
  for (const name of searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(name)) return { error: 'unexpected-parameter' };
  }
  const profiles = searchParams.getAll('profile');
  const profileId = profiles[0];
  if (profiles.length !== 1 || profileId === undefined || !PROFILE_PATTERN.test(profileId)) {
    return { error: 'invalid-profile' };
  }
  return { profileId };
}

function validAuthentication(
  result: Authentication,
): result is Extract<Authentication, { ok: true }> {
  return (
    result.ok &&
    typeof result.subject === 'string' &&
    result.subject.length > 0 &&
    Number.isFinite(result.expiresInMilliseconds) &&
    result.expiresInMilliseconds > 0
  );
}

/**
 * Build the authorized terminal WebSocket server for `Bun.serve`.
 *
 * An upgrade is admitted only after, in order: the transport is secure (or a loopback development
 * switch applies to a genuinely loopback listener), the `Origin` is on the allowlist, the URL
 * carries no credential and names a profile, and the host's `authenticate` callback accepted the
 * request and returned a trusted subject with a lifetime. The host's `authorize` callback then
 * decides the immutable launch when the client's `hello` names a session, before any process exists.
 * Nothing is read from a client but the profile name, the session identity, the requested mode and
 * the host's own ticket.
 */
export function createTerminalWebSocketServer(
  options: TerminalWebSocketServerOptions,
): TerminalWebSocketServer {
  const originAllowed = createOriginPolicy(options.allowedOrigins);
  const limits = resolveWebSocketLimits(options.limits, options.budgets);
  const clock = options.clock ?? systemClock;
  if (typeof options.slotFor !== 'function') {
    throw new TypeError('slotFor is required: the host decides which SessionSlot holds a subject');
  }
  if (options.allowInsecureLoopback === true && !isLoopbackListener(options.boundHostname)) {
    throw new RangeError(
      'allowInsecureLoopback requires boundHostname to be the loopback hostname given to Bun.serve (127.0.0.1, ::1 or localhost)',
    );
  }
  const trustedProxies = new Set<string>();
  for (const entry of options.trustedProxies ?? []) {
    if (isIP(entry) === 0) {
      throw new RangeError(`trustedProxies entry ${JSON.stringify(entry)} is not an IP address`);
    }
    trustedProxies.add(normalizeAddress(entry));
  }
  const { slotFor } = options;
  const settings = {
    host: options.host,
    createProcess: options.createProcess,
    clock,
    limits,
    slotFor,
  };
  const connections = new Set<TerminalConnection>();
  const byTransport = new WeakMap<object, TerminalConnection>();
  let upgrading = 0;

  async function authenticate(request: Request): Promise<Authentication> {
    const unavailable: Authentication = { ok: false, denial: 'unavailable' };
    let cancelDeadline = (): void => undefined;
    // A host that never answers must not hold the upgrade, or its slot in the connection cap, forever.
    const deadline = new Promise<Authentication>((resolve) => {
      cancelDeadline = clock.schedule(
        () => resolve(unavailable),
        limits.authenticateDeadlineMilliseconds,
      );
    });
    try {
      const result = await Promise.race([
        Promise.resolve(options.host.authenticate(request)),
        deadline,
      ]);
      if (result.ok) return validAuthentication(result) ? result : unavailable;
      return result;
    } catch {
      return unavailable;
    } finally {
      cancelDeadline();
    }
  }

  async function handleUpgrade(
    request: Request,
    server: UpgradeServer,
  ): Promise<Response | undefined> {
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return refuse(426, 'upgrade-required', { upgrade: 'websocket' });
    }
    const transport = decideTransport({
      protocol: new URL(request.url).protocol,
      listenerHostname: options.boundHostname,
      peerAddress: server.requestIP(request)?.address,
      allowInsecureLoopback: options.allowInsecureLoopback === true,
      trustedProxies,
      forwardedProto: request.headers.get('x-forwarded-proto'),
    });
    if (!transport.allowed) return refuse(403, 'forbidden');
    if (!originAllowed(request.headers.get('origin'))) return refuse(403, 'forbidden');
    const profile = readProfile(request);
    if ('error' in profile) return refuse(400, profile.error);
    if (connections.size + upgrading >= limits.maximumConnections) {
      return refuse(503, 'unavailable', { 'retry-after': '5' });
    }
    upgrading += 1;
    try {
      const authentication = await authenticate(request);
      if (!authentication.ok) {
        return refuse(DENIAL_STATUS[authentication.denial], authentication.denial);
      }
      const data: SocketData = {
        subject: authentication.subject,
        expiresInMilliseconds: authentication.expiresInMilliseconds,
        profileId: profile.profileId,
      };
      return server.upgrade(request, { data }) ? undefined : refuse(400, 'upgrade-failed');
    } finally {
      upgrading -= 1;
    }
  }

  async function handleOpen(socket: ServerSocket): Promise<void> {
    // Binary frames must arrive as bytes the codec can read; the default would be a Buffer.
    socket.binaryType = 'uint8array';
    const connection = new TerminalConnection(socket, settings, (finished) => {
      connections.delete(finished);
    });
    connections.add(connection);
    byTransport.set(socket, connection);
    connection.open();
  }

  async function handleMessage(socket: ServerSocket, frame: Uint8Array | string): Promise<void> {
    await byTransport.get(socket)?.receive(frame);
  }

  async function handleClose(socket: ServerSocket): Promise<void> {
    await byTransport.get(socket)?.transportClosed();
    byTransport.delete(socket);
  }

  const websocket: TerminalWebSocketHandlers = {
    maxPayloadLength: limits.maxPayloadLength,
    backpressureLimit: limits.maximumBufferedBytes,
    closeOnBackpressureLimit: true,
    // The host pings on its own clock so that liveness is deterministic and a pong is the only
    // transport proof that extends it. Bun's automatic pings would be a second, unobserved timer.
    sendPings: false,
    perMessageDeflate: false,
    open: handleOpen,
    message: handleMessage,
    close: handleClose,
    pong(socket) {
      byTransport.get(socket)?.noteTransportAlive();
    },
  };

  return {
    handleUpgrade,
    handleOpen,
    handleMessage,
    handleClose,
    websocket,
    async revokeSubject(subject) {
      const affected = [...connections].filter((connection) => connection.subject === subject);
      await Promise.all(affected.map((connection) => connection.revoke()));
      return affected.length;
    },
    async revokeSession(subject, sessionId) {
      const found = [...connections].find(
        (connection) => connection.subject === subject && connection.sessionId === sessionId,
      );
      if (found === undefined) return false;
      await found.revoke();
      return true;
    },
    get connectionCount() {
      return connections.size;
    },
    async close() {
      await Promise.all([...connections].map((connection) => connection.revoke()));
    },
  };
}
