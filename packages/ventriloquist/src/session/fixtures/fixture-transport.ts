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
};

export type FixtureTransport = {
  readonly client: ClientEndpoint;
  readonly connection: SessionConnection;
  /** Every frame the host sent that the client has not yet been given. */
  readonly outbox: (Uint8Array | string)[];
  /** What the client decoded from the host's frames, in order, and what it refused. */
  readonly received: ServerMessage[];
  readonly failures: ProtocolFailure[];
  readonly closeCodes: number[];
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
  const grant = options.grant ?? 'interactive';
  const client = new ClientEndpoint({
    sessionId: options.sessionId ?? options.session.sessionId,
    requestedMode: options.requestedMode ?? 'interactive',
    token: 'fixture-token',
  });
  const connection = new SessionConnection({
    session: options.session,
    authorize: () => (grant === false ? { allowed: false } : { allowed: true, grant }),
    send: (frame) => {
      outbox.push(frame);
    },
    close: (code) => {
      closeCodes.push(code);
    },
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
