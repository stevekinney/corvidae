import { ClientEndpoint } from '../../protocol/client-endpoint.ts';
import type { SentFrame } from '../../protocol/endpoint-support.ts';
import type { RequestedMode, ServerMessage } from '../../protocol/messages.ts';
import type { ProtocolFailure, ProtocolResult } from '../../protocol/protocol-failure.ts';
import { SessionConnection } from '../session-connection.ts';
import type { AttachmentGrant } from '../session-types.ts';
import type { Session } from '../session.ts';

export type FixtureTransportOptions = {
  readonly session: Session;
  readonly requestedMode?: RequestedMode;
  /** What the host's authorization grants. `false` models a refused authorization. */
  readonly grant?: AttachmentGrant | false;
  /** The session identifier the client addresses; defaults to the session's own. */
  readonly sessionId?: string;
  readonly maxFrameBytes?: number;
  /**
   * Called once for each frame the host puts on the wire, after it joined `outbox`. It is how a
   * test learns that a frame arrived without polling; delivery to the client still waits for `pump`.
   */
  readonly onFrame?: () => void;
};

export type WireEvent =
  | { readonly type: 'frame'; readonly frame: Uint8Array | string }
  | { readonly type: 'close'; readonly code: number };

export type FixtureTransport = {
  readonly client: ClientEndpoint;
  readonly connection: SessionConnection;
  /** Every frame the host sent that the client has not yet been given. */
  readonly outbox: (Uint8Array | string)[];
  /** What the client decoded from the host's frames, in order, and what it refused. */
  readonly received: ServerMessage[];
  readonly failures: ProtocolFailure[];
  readonly closeCodes: number[];
  /** Frames the host tried to send after it closed the transport. A real socket drops these. */
  readonly sentAfterClose: (Uint8Array | string)[];
  /** Everything the host did to the transport, in order: each frame it put on the wire and each close. */
  readonly wire: WireEvent[];
  /** The socket the connection writes to, for a test that wants to prove how it behaves. */
  readonly socket: { send(frame: Uint8Array | string): void; close(code: number): void };
  /** Make every later send throw while the socket stays open, as a socket that died underneath the host does. */
  breakSends(): void;
  /** Run the handshake: the client's hello to the host, the host's capabilities back to the client. */
  connect(): void;
  /** Hand a frame the client built to the host. A failed build is returned for the test to inspect. */
  send(frame: ProtocolResult<SentFrame>): void;
  /** Give the client every frame the host has sent so far. */
  pump(): ServerMessage[];
};

/**
 * An in-memory transport between a real `ClientEndpoint` and a session, through the same
 * `SessionConnection` a socket would use. It is synchronous and deterministic: frames move only
 * when `send` or `pump` is called, so a test controls every interleaving. Nothing here owns a
 * timer, process or socket.
 */
export function createFixtureTransport(options: FixtureTransportOptions): FixtureTransport {
  const outbox: (Uint8Array | string)[] = [];
  const received: ServerMessage[] = [];
  const failures: ProtocolFailure[] = [];
  const closeCodes: number[] = [];
  const sentAfterClose: (Uint8Array | string)[] = [];
  const wire: WireEvent[] = [];
  let closed = false;
  let broken = false;
  // Behaves like a real WebSocket: once closed, a send fails, and the frame never reaches the peer.
  const socket = {
    send: (frame: Uint8Array | string): void => {
      if (closed) {
        sentAfterClose.push(frame);
        throw new Error('the socket is closed');
      }
      if (broken) throw new Error('the socket is broken');
      wire.push({ type: 'frame', frame });
      outbox.push(frame);
      options.onFrame?.();
    },
    close: (code: number): void => {
      closed = true;
      wire.push({ type: 'close', code });
      closeCodes.push(code);
    },
  };
  const grant = options.grant ?? 'interactive';
  const client = new ClientEndpoint({
    sessionId: options.sessionId ?? options.session.sessionId,
    requestedMode: options.requestedMode ?? 'interactive',
    token: 'fixture-token',
  });
  const connection = new SessionConnection({
    session: options.session,
    authorize: () => (grant === false ? { allowed: false } : { allowed: true, grant }),
    send: (frame) => socket.send(frame),
    close: (code) => socket.close(code),
    ...(options.maxFrameBytes === undefined
      ? {}
      : { limits: { maxFrameBytes: options.maxFrameBytes } }),
  });
  const pump = (): ServerMessage[] => {
    const delivered: ServerMessage[] = [];
    for (const frame of outbox.splice(0)) {
      const result = client.receive(frame);
      if (result.ok) delivered.push(result.value);
      else failures.push(result.failure);
    }
    received.push(...delivered);
    return delivered;
  };
  return {
    client,
    connection,
    outbox,
    received,
    failures,
    closeCodes,
    sentAfterClose,
    wire,
    socket,
    breakSends: () => {
      broken = true;
    },
    connect: () => {
      const hello = client.hello();
      if (hello.ok) connection.receive(hello.value);
      pump();
    },
    send: (frame) => {
      if (frame.ok) connection.receive(frame.value.frame);
    },
    pump,
  };
}
