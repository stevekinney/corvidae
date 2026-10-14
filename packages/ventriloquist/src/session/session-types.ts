import type {
  Capabilities,
  CleanupOutcome,
  OutputChannel,
  RequestedMode,
} from '../protocol/messages.ts';
import type { SessionClock } from './session-clock.ts';

/**
 * Process lifecycle, kept separate from connection and cleanup state. `exited` and `failed` are
 * terminal; an end-of-file on output is a separate event and never implies either.
 */
export type ProcessState =
  | { readonly kind: 'starting' }
  | { readonly kind: 'running' }
  | { readonly kind: 'exited'; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly kind: 'failed'; readonly reason: string };

/** Whether an attachment currently holds the session's single active slot. */
export type ConnectionState =
  | { readonly kind: 'detached' }
  | { readonly kind: 'attached'; readonly generation: number }
  | { readonly kind: 'revoked'; readonly generation: number };

/**
 * Cleanup lifecycle. `incomplete` and `unknown` quarantine the slot: a replacement attachment is
 * blocked until a host-authorized clearance replaces the session identity.
 */
export type CleanupState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'finished'; readonly outcome: CleanupOutcome };

/** Who is responsible for releasing an output source when the session ends. */
export type SourceOwnership = 'owned' | 'borrowed';

/**
 * Who owns what, stated explicitly. The session owns its backend process (if it has one) and
 * every `owned` source; a `borrowed` source is only unsubscribed. The view is the attachment,
 * which belongs to its connection and is never reused.
 */
export type SessionOwnership = {
  readonly process: 'owned' | 'none';
  readonly sources: readonly SourceOwnership[];
  readonly view: 'bound' | 'unbound';
};

/** The independent state axes a session exposes, so no one of them can imply another. */
export type SessionSnapshot = {
  readonly sessionIdentity: string;
  readonly process: ProcessState;
  readonly connection: ConnectionState;
  readonly cleanup: CleanupState;
  readonly quarantined: boolean;
  readonly closed: boolean;
  readonly ownership: SessionOwnership;
};

/** Server-derived authority for one attachment generation; a read-only grant carries no write path. */
export type AttachmentAuthority = {
  readonly generation: number;
  readonly capabilities: Capabilities;
  readonly canWrite: boolean;
};

/** What the host's own authorization allows this principal, independent of what the client asked for. */
export type AttachmentGrant = 'read-only' | 'interactive';

/** Why an attachment request was refused immediately instead of queued. */
export type AttachmentRejection =
  'concurrent-attachment' | 'stale-generation' | 'stale-session' | 'quarantined' | 'session-closed';

/** Why input, a resize or a terminal reply was refused before it entered the host FIFO. */
export type InputFailureReason =
  | 'stale-generation'
  | 'read-only'
  | 'unsupported'
  | 'input-disabled'
  | 'invalid-dimensions'
  | 'input-overflow'
  | 'fifo-full';

/** Outcome reported at the host-FIFO boundary; an expired acknowledgement is `unknown`, never success. */
export type InputDisposition = 'accepted' | 'failed' | 'canceled' | 'unknown';

/** The synchronous answer to a submitted operation: it entered the host FIFO, or it did not. */
export type InputReceipt =
  | { readonly disposition: 'accepted'; readonly sequence: number }
  | {
      readonly disposition: 'failed';
      readonly sequence: number;
      readonly reason: InputFailureReason;
    };

/** Why an accepted operation later ended without success. */
export type OperationResultReason =
  | 'backend-failed'
  | 'acknowledgement-deadline'
  | 'closed-before-acknowledgement'
  | 'revoked'
  | 'process-exited';

/** The failure codes a backend's `start()` may reject with, as the failure table's startup rows name them. */
export type StartFailureCode = 'unsupported-runtime' | 'spawn-failed';

export type OperationKind = 'input' | 'resize';

/** What started the session's close. The first cause wins; later ones never overwrite it. */
export type CloseCause =
  | 'attachment-stop'
  | 'host-stop'
  | 'host-dispose'
  | 'disconnect'
  | 'protocol-failure'
  | 'liveness-expired'
  | 'authorization-revoked'
  | 'callback-failed'
  | 'backend-failed'
  | 'delivery-unknown'
  | 'output-overflow'
  | 'source-failed'
  | 'start-failed'
  | 'process-exit'
  | 'source-complete';

/** Whether every accepted output byte reached a parse completion before the session closed. */
export type DrainResult = {
  readonly state: 'drained' | 'truncated';
  /** Output the consumer was never given, or was given but never reported parsed. */
  readonly unavailableBytes: number;
};

/** The one final report of a session: emitted after drain and cleanup are known, with nothing after it. */
export type SessionClosedSummary = {
  readonly sessionIdentity: string;
  readonly cause: CloseCause;
  readonly process: ProcessState;
  readonly cleanup: CleanupOutcome;
  readonly drain: DrainResult;
  readonly quarantined: boolean;
};

/** Everything an attachment's listener can be told. */
export type SessionEvent =
  | {
      readonly type: 'output';
      readonly generation: number;
      readonly chunkId: number;
      readonly channel: OutputChannel;
      readonly bytes: Uint8Array;
    }
  | { readonly type: 'sourceComplete'; readonly channel: OutputChannel }
  | {
      readonly type: 'processExit';
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | {
      readonly type: 'operationResult';
      readonly sequence: number;
      readonly kind: OperationKind;
      readonly disposition: 'failed' | 'canceled' | 'unknown';
      readonly reason: OperationResultReason;
    }
  | {
      readonly type: 'attachmentRevoked';
      readonly generation: number;
      readonly cause: CloseCause;
    }
  | { readonly type: 'sessionClosed'; readonly summary: SessionClosedSummary };

/** Receives an attachment's events. A throw or a rejection revokes the attachment and starts cleanup. */
export type AttachmentListener = (event: SessionEvent) => void | Promise<void>;

export type AttachRequest = {
  /** What the client asked for. The grant can only narrow it. */
  readonly requestedMode: RequestedMode;
  /** What the host's authorization allows. A read-only grant is never widened by the request. */
  readonly grant: AttachmentGrant;
  readonly listener: AttachmentListener;
  /** A generation the caller believes it holds. v1 has no resume, so presenting one is always refused. */
  readonly resumeGeneration?: number;
};

/** A stop request is answered the same way every time: the one close, or a refusal because the grant is read-only. */
export type StopReceipt =
  | { readonly accepted: true; readonly closed: Promise<SessionClosedSummary> }
  | { readonly accepted: false; readonly reason: 'read-only' };

/** The handle one attachment generation uses. Every method checks the generation is still live. */
export type SessionAttachment = {
  readonly generation: number;
  readonly authority: AttachmentAuthority;
  /** Submit input. Accepted means it entered the host FIFO, never that the process consumed it. */
  write(bytes: Uint8Array, options?: { readonly sequence?: number }): InputReceipt;
  /** Submit a terminal-generated query reply. It is input: it obeys exactly the same authority. */
  reply(bytes: Uint8Array, options?: { readonly sequence?: number }): InputReceipt;
  resize(columns: number, rows: number, options?: { readonly sequence?: number }): InputReceipt;
  /** The consumer finished parsing one chunk. This is the only way a chunk's capacity is returned. */
  outputParsed(chunkId: number): boolean;
  /** The consumer reports a cumulative accepted-byte count it has parsed; returns chunks released. */
  outputParsedThrough(cumulativeBytes: number): number;
  /** Reset the liveness deadline. It grants no authority and does nothing on a revoked attachment. */
  heartbeat(): boolean;
  stop(): StopReceipt;
  /** The connection ended. Authority is revoked and cleanup runs; the same result is returned every time. */
  detach(): Promise<SessionClosedSummary>;
  /** The peer broke the wire protocol: the generation is revoked and cleanup runs, as for a disconnect. */
  protocolViolation(): Promise<SessionClosedSummary>;
};

export type AttachResult =
  | {
      readonly accepted: true;
      readonly authority: AttachmentAuthority;
      readonly attachment: SessionAttachment;
    }
  | { readonly accepted: false; readonly reason: AttachmentRejection };

/**
 * Independent budgets, each enforced on its own. The operation limit counts user input and resize
 * operations; the reserved control capacity is excluded from it, so a full FIFO never blocks stop,
 * revoke or cleanup.
 *
 * - `inputQueueBytes`: bytes of accepted input not yet settled by the backend.
 * - `outputQueueBytes`: bytes delivered to the consumer and not yet reported parsed.
 * - `inputAcknowledgementDeadlineMilliseconds`: how long the backend has to settle one submitted
 *   operation. Acceptance into the FIFO is the synchronous receipt and needs no deadline; expiry here is
 *   `unknown` delivery, never success, and is never retried.
 * - `livenessDeadlineMilliseconds`: how long an attachment may go without a heartbeat.
 * - `cleanupDeadlineMilliseconds`: bounds each phase on its own. A natural close can wait up to this
 *   long for output to drain, then up to this long again for the owner's cleanup to finish.
 */
export type SessionBudgets = {
  readonly operationQueueLimit: number;
  readonly reservedControlCapacity: number;
  readonly inputQueueBytes: number;
  readonly outputQueueBytes: number;
  readonly inputAcknowledgementDeadlineMilliseconds: number;
  readonly livenessDeadlineMilliseconds: number;
  readonly cleanupDeadlineMilliseconds: number;
};

/** The conservative defaults from documentation/terminal/security-and-budgets.md. */
export const DEFAULT_SESSION_BUDGETS: SessionBudgets = {
  operationQueueLimit: 256,
  reservedControlCapacity: 8,
  inputQueueBytes: 64 * 1024,
  outputQueueBytes: 1024 * 1024,
  inputAcknowledgementDeadlineMilliseconds: 2_000,
  livenessDeadlineMilliseconds: 30_000,
  cleanupDeadlineMilliseconds: 5_000,
};

/** What `read()` on a stream reader yields, structurally compatible with a `ReadableStream` reader. */
export type ByteReadResult =
  | { readonly done: false; readonly value: Uint8Array }
  | { readonly done: true; readonly value?: Uint8Array | undefined };

/** The reader half of a byte stream. `cancel` is optional so a stream that cannot be canceled is representable. */
export type ByteReader = {
  read(): Promise<ByteReadResult>;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock(): void;
};

/** A structural stand-in for `ReadableStream<Uint8Array>`, which the platform-neutral program cannot name. */
export type ByteStream = { getReader(): ByteReader };

/**
 * An output channel's producer. A `stream` or `iterable` is owned: cleanup cancels the reader or
 * calls `return()` on the iterator. A `subscription` is borrowed: cleanup only unsubscribes, and
 * the producer behind it keeps running.
 */
export type OutputSource =
  | { readonly kind: 'stream'; readonly channel: OutputChannel; readonly stream: ByteStream }
  | {
      readonly kind: 'iterable';
      readonly channel: OutputChannel;
      readonly iterable: AsyncIterable<Uint8Array>;
    }
  | {
      readonly kind: 'subscription';
      readonly channel: OutputChannel;
      subscribe(deliver: (bytes: Uint8Array) => void, end: () => void): () => void | Promise<void>;
    };

/**
 * The host's process: launched by `start`, driven by `write` and `resize`, and released by
 * `cleanup`, which is the owner's cleanup policy and reports how far it got. A backend reports its
 * own exit through `Session.reportProcessExit`. Its callbacks may reject; the session treats that as
 * a backend failure.
 */
export type ProcessBackend = {
  readonly mode: 'pty' | 'pipe';
  /**
   * Whether the process has an input channel. Absent means it does: only a backend that is
   * known to have none (a pipe opened without stdin) sets `false`, and its attachments then
   * advertise no input.
   */
  readonly acceptsInput?: boolean;
  start(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  resize?(columns: number, rows: number): Promise<void>;
  cleanup(): Promise<CleanupOutcome>;
};

/** The immutable authorized profile a session was created from. The host resolves it before creation. */
export type SessionProfile = { readonly profileId: string };

export type TerminalDimensions = { readonly columns: number; readonly rows: number };

export type SessionOptions = {
  /** An opaque identity, never reused: a replacement session needs a new one. */
  readonly sessionId: string;
  readonly profile: SessionProfile;
  /** The validated initial size. A session never starts from an empty or unvalidated geometry. */
  readonly dimensions: TerminalDimensions;
  readonly clock: SessionClock;
  readonly sources: readonly OutputSource[];
  /** Absent for an output-only session, which advertises no input, resize or kill. */
  readonly backend?: ProcessBackend;
  readonly budgets?: Partial<SessionBudgets>;
  /** Issues the attachment generation. A slot supplies one that never repeats across sessions. */
  readonly issueGeneration?: () => number;
};
