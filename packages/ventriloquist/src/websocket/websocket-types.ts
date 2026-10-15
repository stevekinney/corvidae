import type { HostedProcess, ProcessProfile } from '../bun/process-types.ts';
import type { RequestedMode } from '../protocol/messages.ts';
import type { SessionClock } from '../session/session-clock.ts';
import type { SessionSlot } from '../session/session-slot.ts';
import type {
  AttachmentGrant,
  SessionBudgets,
  TerminalDimensions,
} from '../session/session-types.ts';

/**
 * Why the host refused. The reason is typed so a host cannot invent a status, and it is the only
 * thing a refusal carries to the peer: no message, no detail about which check failed.
 *
 * - `unauthenticated`: no credential, or one the host does not accept.
 * - `expired`: the credential was valid once and its lifetime has ended.
 * - `forbidden`: the principal is known and may not do this.
 * - `unavailable`: the host could not decide, so nothing is admitted.
 */
export type DenialReason = 'unauthenticated' | 'expired' | 'forbidden' | 'unavailable';

/**
 * The host's answer to "who is this upgrade request from". The host reads its own HttpOnly session
 * cookie from the request; the package never sees a credential it can log. `expiresInMilliseconds`
 * is the principal's remaining lifetime, relative so that nothing here reads a wall clock: when it
 * elapses the attachment's authority is revoked.
 */
export type Authentication =
  | {
      readonly ok: true;
      /** A stable identifier of the trusted principal. Never taken from the client. */
      readonly subject: string;
      readonly expiresInMilliseconds: number;
    }
  | { readonly ok: false; readonly denial: DenialReason };

/** What the host decides a principal may run: server-owned, immutable once decided. */
export type LaunchSnapshot = {
  readonly mode: 'pty' | 'pipe';
  readonly profile: ProcessProfile;
  readonly dimensions: TerminalDimensions;
  /** Pipe mode only: whether stdin is opened. Absent means the process has no input channel. */
  readonly acceptsInput?: boolean;
};

export type AuthorizationRequest = {
  /** The subject `authenticate` returned for this upgrade. */
  readonly subject: string;
  /** The profile identifier the client named in the upgrade URL: untrusted, the host maps it. */
  readonly profileId: string;
  /** The session identity the client asked to attach to: untrusted, a fresh identity is required. */
  readonly sessionId: string;
  readonly requestedMode: RequestedMode;
  /** The only operation an attachment performs; input, resize and stop follow from the grant. */
  readonly operation: 'attach';
  /**
   * The `token` field of the client's `hello`. It is the host's own opaque attachment value, never
   * the session cookie, and the package neither logs nor echoes it.
   */
  readonly ticket: string;
};

/**
 * The host's authorization. Allowed, it carries the whole immutable launch decision: the package
 * copies and freezes it before anything starts, so the host mutating its objects later changes
 * nothing. Denied, it carries only a typed reason.
 */
export type Authorization =
  | {
      readonly allowed: true;
      readonly grant: AttachmentGrant;
      readonly launch: LaunchSnapshot;
    }
  | { readonly allowed: false; readonly denial: DenialReason };

/** The callbacks a host must supply. Neither has a default: an unauthenticated server cannot be built. */
export type TerminalHostCallbacks = {
  authenticate(request: Request): Promise<Authentication> | Authentication;
  authorize(request: AuthorizationRequest): Promise<Authorization> | Authorization;
};

/** Turns an authorized launch into the process a session hosts. Nothing starts until the session does. */
export type CreateProcess = (launch: LaunchSnapshot) => HostedProcess;

/** What the upgrade stores on the socket: the trusted subject and lifetime, and the validated profile name. */
export type SocketData = {
  readonly subject: string;
  readonly expiresInMilliseconds: number;
  readonly profileId: string;
};

export type TerminalWebSocketServerOptions = {
  readonly host: TerminalHostCallbacks;
  readonly createProcess: CreateProcess;
  /** The origins allowed to open a terminal. Required and non-empty; a request with none is denied. */
  readonly allowedOrigins: readonly string[];
  /**
   * Admit plain `http:` upgrades for local development. It works only when the listener is bound
   * to loopback and the peer is loopback, and origin and authentication still apply.
   */
  readonly allowInsecureLoopback?: boolean;
  /** One slot per principal by default; supply it to share a slot between principals. */
  readonly slotFor?: (subject: string) => SessionSlot;
  readonly clock?: SessionClock;
  readonly budgets?: Partial<SessionBudgets>;
  readonly limits?: WebSocketLimits;
};

/** Bounds on the transport, each with its own permitted range. */
export type WebSocketLimits = {
  /** The payload budget advertised to the client. Defaults to 64 KiB. */
  readonly maxFrameBytes?: number;
  /** The operation FIFO depth advertised to the client. Defaults to the session's. */
  readonly maxQueuedOperations?: number;
  /** Bytes the socket may hold unsent before the connection is failed. Defaults to 1 MiB. */
  readonly maximumBufferedBytes?: number;
  /** How long a socket may stay open without a valid `hello`. Defaults to 10 s. */
  readonly handshakeDeadlineMilliseconds?: number;
  /** How often the host pings an attached client. Defaults to 10 s, a third of the liveness deadline. */
  readonly pingIntervalMilliseconds?: number;
  /** Sockets that may be open or upgrading at once. Defaults to 64. */
  readonly maximumConnections?: number;
};
