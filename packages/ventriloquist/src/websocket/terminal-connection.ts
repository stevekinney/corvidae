import type { HostedProcess } from '../bun/process-types.ts';
import {
  snapshotDimensions,
  snapshotProfile,
  validateDimensions,
  validateProcessProfile,
} from '../bun/process-validation.ts';
import { describeFailure } from '../protocol/failure-table.ts';
import { HostEndpoint } from '../protocol/host-endpoint.ts';
import type { HelloMessage } from '../protocol/messages.ts';
import type { CancelTimer, SessionClock } from '../session/session-clock.ts';
import { SessionConnection } from '../session/session-connection.ts';
import type { SessionSlot, SlotRefusal } from '../session/session-slot.ts';
import type { Session } from '../session/session.ts';
import type { ResolvedWebSocketLimits } from './websocket-limits.ts';
import type {
  CreateProcess,
  DenialReason,
  LaunchSnapshot,
  SocketData,
  TerminalHostCallbacks,
} from './websocket-types.ts';

/** The part of Bun's `ServerWebSocket` a connection drives, so the surface it relies on is explicit. */
export type TerminalSocket = {
  readonly data: SocketData;
  readonly readyState: number;
  send(frame: string | Uint8Array): number;
  ping(): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
};

/** What every connection of one server shares. */
export type ConnectionSettings = {
  readonly host: TerminalHostCallbacks;
  readonly createProcess: CreateProcess;
  readonly clock: SessionClock;
  readonly limits: ResolvedWebSocketLimits;
  readonly slotFor: (subject: string) => SessionSlot;
};

const OPEN = 1;
/**
 * The longest delay a single timer is asked for. `setTimeout` keeps its delay in a signed 32-bit
 * integer and treats anything above this (about 24.8 days) as 1 millisecond, which would revoke an
 * attachment the moment it opened. A longer lifetime is waited out in steps of at most this much.
 */
export const MAXIMUM_TIMER_MILLISECONDS = 2_147_483_647;
const MALFORMED_FRAME = 1002;
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;
const TRY_AGAIN_LATER = 1013;

/** The close code for a denial: a refusal is a policy violation, an undecided host is a retry. */
export function closeCodeForDenial(denial: DenialReason): number {
  return denial === 'unavailable' ? TRY_AGAIN_LATER : POLICY_VIOLATION;
}

/** An occupied slot is worth retrying; a quarantined or reused identity is not. */
function closeCodeForSlotRefusal(reason: SlotRefusal): number {
  return reason === 'occupied' ? TRY_AGAIN_LATER : POLICY_VIOLATION;
}

/** A deep-frozen copy of the host's launch decision, validated before anything starts from it. */
function freezeLaunch(launch: LaunchSnapshot): LaunchSnapshot {
  const profile = snapshotProfile(launch.profile);
  const dimensions = snapshotDimensions(launch.dimensions);
  validateProcessProfile(profile);
  validateDimensions(dimensions);
  return Object.freeze({
    mode: launch.mode,
    profile: Object.freeze({
      ...profile,
      argumentList: Object.freeze([...profile.argumentList]),
      environment: Object.freeze({ ...profile.environment }),
    }),
    dimensions: Object.freeze(dimensions),
    ...(launch.acceptsInput === undefined ? {} : { acceptsInput: launch.acceptsInput }),
  });
}

/** Release a process that never started. Its cleanup failing changes nothing the caller can still do. */
async function releaseUnstarted(hosted: HostedProcess): Promise<void> {
  try {
    await hosted.backend.cleanup();
  } catch {
    // The refusal that led here stands; there is no session to quarantine.
  }
}

type Phase = 'awaiting-hello' | 'attached' | 'closed';

/**
 * One WebSocket's whole lifetime on the host. Until a `hello` is authorized nothing exists but the
 * socket: no session, no process. Authorization decides the immutable launch, the process is made
 * from that copy, and only then does a `SessionConnection` join the socket to the session. Frames are
 * handled strictly in arrival order, because the first one awaits the host.
 *
 * Every path that ends the connection ends the session too, and the reverse: a socket that closes
 * detaches the session so its process is cleaned up, and a session that closes closes the socket.
 */
export class TerminalConnection {
  readonly subject: string;
  readonly #socket: TerminalSocket;
  readonly #settings: ConnectionSettings;
  readonly #onFinished: (connection: TerminalConnection) => void;
  #phase: Phase = 'awaiting-hello';
  #session: Session | undefined;
  #connection: SessionConnection | undefined;
  #queue: Promise<void> = Promise.resolve();
  #received = 0;
  #cancelHandshake: CancelTimer | undefined;
  #cancelExpiry: CancelTimer | undefined;
  #cancelPing: CancelTimer | undefined;

  constructor(
    socket: TerminalSocket,
    settings: ConnectionSettings,
    onFinished: (connection: TerminalConnection) => void,
  ) {
    this.#socket = socket;
    this.#settings = settings;
    this.#onFinished = onFinished;
    this.subject = socket.data.subject;
  }

  /** The session this connection hosts, once its `hello` was authorized. */
  get sessionId(): string | undefined {
    return this.#session?.sessionId;
  }

  /** Start the two deadlines that bound an unauthenticated or expiring socket. */
  open(): void {
    const { clock, limits } = this.#settings;
    this.#cancelHandshake = clock.schedule(() => {
      if (this.#phase === 'awaiting-hello') this.#terminate(POLICY_VIOLATION);
    }, limits.handshakeDeadlineMilliseconds);
    this.#armExpiry(this.#socket.data.expiresInMilliseconds);
  }

  /** Wait out the principal's lifetime, in steps no timer can mis-handle, then revoke. */
  #armExpiry(remainingMilliseconds: number): void {
    const step = Math.min(remainingMilliseconds, MAXIMUM_TIMER_MILLISECONDS);
    this.#cancelExpiry = this.#settings.clock.schedule(() => {
      if (remainingMilliseconds > step) this.#armExpiry(remainingMilliseconds - step);
      else void this.revoke();
    }, step);
  }

  /** Handle one frame from the client, after every earlier one has been handled. */
  receive(frame: Uint8Array | string): Promise<void> {
    // Nothing may follow the hello until the attachment exists: the client must wait for the
    // capabilities. A queue of frames behind a slow host decision would be unbounded, so a second
    // frame before then is a protocol violation and the connection closes.
    this.#received += 1;
    if (this.#connection === undefined && this.#received > 1) {
      this.#terminate(MALFORMED_FRAME);
      return Promise.resolve();
    }
    this.#queue = this.#queue.then(() => this.#handle(frame)).catch(() => this.#fail());
    return this.#queue;
  }

  /** A pong arrived: the transport proved the peer alive without an application frame. */
  noteTransportAlive(): void {
    this.#connection?.noteTransportAlive();
  }

  /** The socket closed or errored underneath the connection. */
  async transportClosed(): Promise<void> {
    this.#phase = 'closed';
    this.#stopTimers();
    // The connection leaves the registry whether or not the release succeeded.
    await this.#release().then(
      () => undefined,
      () => undefined,
    );
    this.#onFinished(this);
  }

  /**
   * The host withdrew this principal's authority, or its lifetime ended: freeze input and clean up.
   * Before an attachment exists there is no process, so the socket just closes.
   */
  async revoke(): Promise<void> {
    if (this.#phase === 'closed') return;
    const session = this.#session;
    if (session === undefined || this.#connection === undefined) {
      this.#terminate(POLICY_VIOLATION);
      return;
    }
    await session.revokeAuthorization();
  }

  async #handle(frame: Uint8Array | string): Promise<void> {
    if (this.#phase === 'closed') return;
    if (this.#connection !== undefined) {
      this.#connection.receive(frame);
      return;
    }
    // The first frame must be a hello. A throwaway endpoint judges it with the same rules the
    // session's endpoint will apply, so a malformed or unsupported one is refused identically.
    const probe = new HostEndpoint(this.#settings.limits.endpoint).receive(frame);
    if (!probe.ok) {
      // Before a hello there is no attachment to answer on, so a refusal is only the close code.
      this.#terminate(describeFailure(probe.failure.code).closeCode);
      return;
    }
    // An endpoint that has seen no hello accepts only a hello.
    await this.#admit(probe.value as HelloMessage, frame);
  }

  async #admit(hello: HelloMessage, frame: Uint8Array | string): Promise<void> {
    const { host } = this.#settings;
    let authorization;
    try {
      authorization = await host.authorize({
        subject: this.subject,
        profileId: this.#socket.data.profileId,
        sessionId: hello.sessionId,
        requestedMode: hello.requestedMode,
        operation: 'attach',
        ticket: hello.token,
      });
    } catch {
      this.#terminate(TRY_AGAIN_LATER);
      return;
    }
    // The client may have left, or the lifetime may have ended, while the host decided.
    if (this.#phase === 'closed') return;
    if (!authorization.allowed) {
      this.#terminate(closeCodeForDenial(authorization.denial));
      return;
    }
    await this.#attach(hello, frame, authorization.grant, authorization.launch);
  }

  async #attach(
    hello: HelloMessage,
    frame: Uint8Array | string,
    grant: 'read-only' | 'interactive',
    requested: LaunchSnapshot,
  ): Promise<void> {
    const { createProcess, clock, limits, slotFor } = this.#settings;
    let launch: LaunchSnapshot;
    let hosted: ReturnType<CreateProcess>;
    try {
      launch = freezeLaunch(requested);
      hosted = createProcess(launch);
    } catch {
      this.#terminate(INTERNAL_ERROR);
      return;
    }
    let admission;
    try {
      admission = slotFor(this.subject).create({
        sessionId: hello.sessionId,
        profile: { profileId: this.#socket.data.profileId },
        dimensions: launch.dimensions,
        clock,
        sources: hosted.sources,
        backend: hosted.backend,
        budgets: limits.budgets,
      });
    } catch {
      await releaseUnstarted(hosted);
      this.#terminate(INTERNAL_ERROR);
      return;
    }
    if (!admission.accepted) {
      await releaseUnstarted(hosted);
      this.#terminate(closeCodeForSlotRefusal(admission.reason));
      return;
    }
    const { session } = admission;
    this.#session = session;
    let connection: SessionConnection;
    try {
      connection = new SessionConnection({
        session,
        authorize: () => ({ allowed: true, grant }),
        send: (output) => this.#send(output),
        close: (code) => this.#closeFromConnection(code),
        limits: limits.endpoint,
      });
    } catch {
      this.#terminate(INTERNAL_ERROR);
      return;
    }
    // A client that left while the process was being made has nothing to attach to.
    if (this.#phase === 'closed') {
      await session.dispose();
      return;
    }
    this.#connection = connection;
    this.#phase = 'attached';
    this.#cancelHandshake?.();
    this.#cancelHandshake = undefined;
    connection.receive(frame);
    if (session.snapshot.connection.kind !== 'attached') {
      // The session refused the attachment, and the connection has closed the socket.
      await session.dispose();
      return;
    }
    this.#schedulePing();
    void hosted.reportExitTo(session).catch(() => undefined);
    void session.closed.then(() => this.#finish());
  }

  /** Put a frame on the socket, failing loudly when the socket cannot take it so the session fails closed. */
  #send(frame: Uint8Array | string): void {
    const socket = this.#socket;
    if (socket.readyState !== OPEN) throw new Error('the socket is not open');
    // A zero status means Bun dropped the frame; a negative one means it queued it under
    // backpressure, which is not a failure and is never read as an acknowledgement.
    if (socket.send(frame) === 0) throw new Error('the socket dropped the frame');
    if (socket.getBufferedAmount() > this.#settings.limits.maximumBufferedBytes) {
      throw new Error('the socket buffer exceeded its bound');
    }
  }

  /** The session core asked for the close, after the cleanup result went out. */
  #closeFromConnection(code: number): void {
    this.#phase = 'closed';
    this.#closeSocket(code);
    const session = this.#session;
    if (session !== undefined && !session.snapshot.closed) void session.dispose();
  }

  #closeSocket(code: number): void {
    try {
      this.#socket.close(code);
    } catch {
      // The socket is already gone; there is nothing left to close.
    }
  }

  /** End the connection from outside the session core: close the socket and release what exists. */
  #terminate(code: number): void {
    const wasClosed = this.#phase === 'closed';
    this.#phase = 'closed';
    if (!wasClosed) this.#closeSocket(code);
    void this.#release()
      .catch(() => undefined)
      .then(() => this.#finish());
  }

  /** A failure inside the handler is never left half-open. */
  #fail(): void {
    this.#terminate(INTERNAL_ERROR);
  }

  async #release(): Promise<void> {
    if (this.#connection !== undefined) {
      await this.#connection.transportClosed();
    } else if (this.#session !== undefined) {
      await this.#session.dispose();
    }
  }

  #schedulePing(): void {
    const { clock, limits } = this.#settings;
    this.#cancelPing = clock.schedule(() => {
      if (this.#phase !== 'attached') return;
      try {
        this.#socket.ping();
      } catch {
        // A socket that cannot be pinged is closing; its close event ends the session.
      }
      this.#schedulePing();
    }, limits.pingIntervalMilliseconds);
  }

  #stopTimers(): void {
    this.#cancelHandshake?.();
    this.#cancelExpiry?.();
    this.#cancelPing?.();
  }

  #finish(): void {
    this.#phase = 'closed';
    this.#stopTimers();
    this.#onFinished(this);
  }
}
