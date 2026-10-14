import type { SentFrame } from '../protocol/endpoint-support.ts';
import { describeFailure } from '../protocol/failure-table.ts';
import { HostEndpoint, type HostEndpointOptions } from '../protocol/host-endpoint.ts';
import type { ClientMessage, HelloMessage } from '../protocol/messages.ts';
import { MAXIMUM_FRAME_PAYLOAD_BYTES } from '../protocol/protocol-constants.ts';
import { accept, type ProtocolFailure, type ProtocolResult } from '../protocol/protocol-failure.ts';
import type {
  AttachmentGrant,
  InputFailureReason,
  InputReceipt,
  SessionAttachment,
  SessionClosedSummary,
  SessionEvent,
} from './session-types.ts';
import type { Session } from './session.ts';

/** What the host's authorization decided about a `hello`. It runs before any generation is issued. */
export type Admission =
  { readonly allowed: true; readonly grant: AttachmentGrant } | { readonly allowed: false };

export type SessionConnectionOptions = {
  readonly session: Session;
  /** Authenticate and authorize the hello's token and requested mode. Token handling is the host's alone. */
  readonly authorize: (hello: HelloMessage) => Admission;
  /** Put one frame on the transport. */
  readonly send: (frame: Uint8Array | string) => void;
  /** Close the transport with a WebSocket-style close code. */
  readonly close: (code: number) => void;
  readonly limits?: HostEndpointOptions;
};

/** The `failed` reason a session records when its backend's `start()` rejected. */
const START_REJECTED_REASON = 'start-rejected';
const SPAWN_FAILED_MESSAGE = 'the backend failed to start';

const TRANSPORT_FAILURE_CLOSE_CODE = describeFailure('transport-failed').closeCode;

/** The wire code an operation refused before queueing is reported under. */
function failureCodeFor(reason: InputFailureReason): 'fifo-full' | 'read-only' {
  return reason === 'fifo-full' || reason === 'input-overflow' ? 'fifo-full' : 'read-only';
}

/**
 * Joins one transport to a session: decoded frames from `HostEndpoint` become calls on the
 * attachment, and the session's events become the frames the endpoint builds. The session never
 * sees an undecoded, stale or unauthorized frame, so a stale session or generation cannot reach the
 * process, the view or cleanup. Authentication runs before a generation exists, and a refusal
 * closes the transport without revealing whether the session exists.
 */
export class SessionConnection {
  readonly #options: SessionConnectionOptions;
  readonly #host: HostEndpoint;
  #attachment: SessionAttachment | undefined;
  #closeCode: number | undefined;
  /**
   * The failure table's close code for a fatal failure of an attached connection. The close waits
   * for the cleanup result, because a closed WebSocket drops anything sent afterwards.
   */
  #closeCodeAfterCleanup: number | undefined;
  /** How many of the session's sources have reported completion on this attachment. */
  #sourcesCompleted = 0;
  /** Session events that arrived before the capabilities were issued, delivered in order once they are. */
  #admissionBuffer: SessionEvent[] | undefined;
  /**
   * Cancellations that arrived while the exit was held. On the wire a cancellation is a
   * `backend-failed` for a submitted operation, which the client reads as the terminal status and
   * answers a later `process-exit` with a refusal, so they follow the exit instead of preceding it.
   */
  /** A failure of a submitted operation was sent: it is the terminal status, so a held exit is not reported. */
  #submittedFailureSent = false;
  #heldCancellations: Extract<SessionEvent, { type: 'operationResult' }>[] = [];
  /** A process exit held back until output has ended, so no trailing byte follows it. */
  #pendingExit: { readonly exitCode: number | null; readonly signal: string | null } | undefined;

  constructor(options: SessionConnectionOptions) {
    this.#options = options;
    // One depth for both halves: the endpoint's failable window is this depth plus the active
    // operation, which is all the session's FIFO of the same depth plus one in flight can hold.
    const depth = options.limits?.maxQueuedOperations ?? options.session.operationQueueLimit;
    if (options.session.operationQueueLimit > depth) {
      throw new RangeError(
        `the session's operation FIFO (${options.session.operationQueueLimit}) is deeper than the endpoint's window (${depth})`,
      );
    }
    this.#host = new HostEndpoint({ ...options.limits, maxQueuedOperations: depth });
  }

  /** Feed one frame received from the client. */
  receive(frame: Uint8Array | string): void {
    const received = this.#host.receive(frame);
    if (!received.ok) {
      this.#reject(received.failure);
      return;
    }
    // Liveness is earned only by a frame the endpoint accepted for this session and generation: a
    // stale, foreign or malformed frame proves nothing about the peer and must not keep a process alive.
    this.#attachment?.heartbeat();
    this.#dispatch(received.value);
  }

  /**
   * The transport itself proved the peer alive, as a WebSocket pong does, with no application frame.
   * A read-only or output-only attachment may have nothing to send for as long as the session is
   * quiet, so without this a healthy idle viewer would expire at the liveness deadline. The contract
   * defines no heartbeat message ("Message kinds are `hello` ... `terminate` ..."), and "liveness
   * probes do not grant authority", so the probe belongs to the transport, and a report never
   * touches capabilities, sequences or any queue. A transport that never reports still expires.
   * Returns whether an attached, unrevoked attachment's deadline was extended.
   */
  noteTransportAlive(): boolean {
    return this.#attachment?.heartbeat() ?? false;
  }

  /** The transport closed or errored underneath the session. Idempotent; returns the one result. */
  async transportClosed(): Promise<SessionClosedSummary | undefined> {
    return this.#attachment?.detach();
  }

  #dispatch(message: ClientMessage): void {
    if (message.kind === 'hello') {
      this.#admit(message);
      return;
    }
    // Only an attached endpoint decodes anything else, so an attachment exists.
    const attachment = this.#attachment as SessionAttachment;
    switch (message.kind) {
      case 'input':
        this.#resolve(
          message.sequence,
          attachment.write(message.payload, { sequence: message.sequence }),
        );
        break;
      case 'resize':
        this.#resolve(
          message.sequence,
          attachment.resize(message.columns, message.rows, { sequence: message.sequence }),
        );
        break;
      case 'output-consumed':
        attachment.outputParsedThrough(message.consumedBytes);
        break;
      case 'terminate':
        // Only an attachment that advertises `kill` can stop the session. A terminate from one that
        // does not is the client ending its attachment, so it is answered as a detach: the client
        // gets the cleanup result and a normal close rather than silence.
        if (!attachment.stop().accepted) void attachment.detach();
        break;
    }
  }

  #admit(hello: HelloMessage): void {
    const { session } = this.#options;
    const admission = this.#authorize(hello);
    if (admission === undefined) {
      this.#close(TRANSPORT_FAILURE_CLOSE_CODE);
      return;
    }
    if (!admission.allowed || hello.sessionId !== session.sessionId) {
      this.#close(1008);
      return;
    }
    // A session that failed to start before this client arrived can no longer be attached to. The
    // client is authorized, so it is told why: a startup failure is never just a refused upgrade.
    const { process } = session.snapshot;
    if (process.kind === 'failed' && process.reason === START_REJECTED_REASON) {
      this.#deliver(this.#host.attachmentError('spawn-failed', SPAWN_FAILED_MESSAGE));
      this.#failClosed(describeFailure('spawn-failed').closeCode);
      return;
    }
    // Attaching can start sources, and a source may emit before `attach` returns. Nothing can be
    // sent until the capabilities exist, so those events wait for them.
    this.#admissionBuffer = [];
    const result = session.attach({
      requestedMode: hello.requestedMode,
      grant: admission.grant,
      listener: (event) => this.#onEvent(event),
    });
    if (!result.accepted) {
      this.#admissionBuffer = undefined;
      this.#close(1008);
      return;
    }
    this.#attachment = result.attachment;
    const issued = this.#host.issueCapabilities({
      generation: result.authority.generation,
      capabilities: result.authority.capabilities,
    });
    const delivered = this.#deliver(
      issued.ok ? accept({ frame: issued.value, sequence: 0 }) : issued,
    );
    this.#releaseAdmissionBuffer(delivered);
  }

  /** Deliver, in order, what arrived during admission. Events that arrive meanwhile queue behind them. */
  #releaseAdmissionBuffer(delivered: boolean): void {
    const buffer = this.#admissionBuffer;
    if (buffer === undefined) return;
    // Capabilities that could not be sent already failed the attachment closed; nothing follows them.
    if (!delivered) buffer.length = 0;
    while (buffer.length > 0) this.#handleEvent(buffer.shift() as SessionEvent);
    this.#admissionBuffer = undefined;
  }

  /** A host callback that throws is a refusal, never an escape: no generation is issued and the transport closes. */
  #authorize(hello: HelloMessage): Admission | undefined {
    try {
      return this.#options.authorize(hello);
    } catch {
      return undefined;
    }
  }

  #resolve(sequence: number, receipt: InputReceipt): void {
    this.#deliver(
      receipt.disposition === 'accepted'
        ? this.#host.acknowledgeOperation(sequence)
        : this.#host.failOperation(sequence, failureCodeFor(receipt.reason), receipt.reason),
    );
  }

  /**
   * Put what the endpoint built on the transport, and return whether it was sent. A frame the
   * endpoint refused to build was never delivered, so the client's view has diverged from the
   * session's: that fails the attachment closed, revoking the generation and closing the transport
   * with the failure's code. The one exception is a refusal because the attachment has already
   * ended, which an earlier failure or the cleanup result has already reported.
   */
  #deliver(result: ProtocolResult<SentFrame>): boolean {
    if (result.ok) return this.#transmit(result.value.frame);
    const { failure } = result;
    if (failure.reason !== 'attachment-revoked') {
      void this.#attachment?.protocolViolation();
      this.#failClosed(describeFailure(failure.code).closeCode);
    }
    return false;
  }

  /**
   * End the connection fatally with the failure table's close code. Once attached, the cleanup
   * result is still owed to the client, so the close is recorded and made after it is sent; with no
   * attachment there is no cleanup to report and the transport closes now. The first code stands.
   */
  #failClosed(code: number): void {
    if (this.#attachment === undefined) {
      this.#close(code);
      return;
    }
    this.#closeCodeAfterCleanup ??= code;
  }

  /** Close the transport once. The first reason stands, so a fatal failure's code is not replaced by the cleanup's. */
  #close(code: number): void {
    if (this.#closeCode !== undefined) return;
    this.#closeCode = code;
    try {
      this.#options.close(code);
    } catch {
      // The code is recorded and the transport is already unusable; a close that throws has nothing left to do.
    }
  }

  /**
   * Put a frame on the transport and report whether it went. A transport that throws is failed
   * rather than left half-open: the attachment is revoked as a violation and the transport is closed
   * with the transport-failure code. The caller must stop sending what it was in the middle of.
   */
  #transmit(frame: Uint8Array | string): boolean {
    try {
      this.#options.send(frame);
      return true;
    } catch {
      void this.#attachment?.protocolViolation();
      this.#failClosed(TRANSPORT_FAILURE_CLOSE_CODE);
      return false;
    }
  }

  /** Answer a frame the endpoint refused: send its reply, and end the attachment if the failure is fatal. */
  #reject(failure: ProtocolFailure): void {
    if (failure.reply !== undefined) this.#transmit(failure.reply);
    if (
      !describeFailure(failure.code).revokesGeneration &&
      failure.code !== 'protocol-version-unsupported'
    ) {
      return;
    }
    void this.#attachment?.protocolViolation();
    this.#failClosed(describeFailure(failure.code).closeCode);
  }

  #onEvent(event: SessionEvent): void {
    if (this.#admissionBuffer !== undefined) {
      this.#admissionBuffer.push(event);
      return;
    }
    this.#handleEvent(event);
  }

  #handleEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'output':
        this.#sendOutput(event);
        break;
      case 'processExit':
        // The backend can report its exit before its streams reach end of file. The contract orders
        // "PTY EOF or source completion, then the distinct process-exit result", and the endpoint
        // refuses output after the exit, so the exit waits for the end of output.
        this.#pendingExit = { exitCode: event.exitCode, signal: event.signal };
        this.#flushExitWhenOutputEnded();
        break;
      case 'sourceComplete':
        this.#sourcesCompleted += 1;
        this.#flushExitWhenOutputEnded();
        break;
      case 'operationResult':
        // A cancellation caused by the exit is reported after the exit it must not suppress.
        if (event.disposition === 'canceled' && this.#pendingExit !== undefined) {
          this.#heldCancellations.push(event);
        } else this.#reportOperationResult(event);
        break;
      case 'attachmentRevoked':
        // No further output is accepted once the generation is revoked, so a held exit is final.
        this.#flushExit();
        if (event.cause === 'start-failed') {
          // The backend never started: report the failure, never a process exit, and close with its code.
          this.#deliver(this.#host.attachmentError('spawn-failed', SPAWN_FAILED_MESSAGE));
          this.#failClosed(describeFailure('spawn-failed').closeCode);
        }
        // Otherwise revocation has no wire message of its own: the cleanup result that follows announces it.
        break;
      case 'sessionClosed':
        this.#flushExit();
        this.#deliver(this.#host.cleanupResult(event.summary.cleanup));
        this.#close(this.#closeCodeAfterCleanup ?? 1000);
        break;
    }
  }

  /**
   * Tell the client how an operation ended. A failed or unknown submitted operation is the failure
   * table's `backend-failed` or `transport-failed`, which close with its code; a canceled one was
   * never submitted, so the close stays whatever ended the session.
   */
  #reportOperationResult(event: Extract<SessionEvent, { type: 'operationResult' }>): void {
    const code = event.disposition === 'unknown' ? 'transport-failed' : 'backend-failed';
    const sent = this.#deliver(this.#host.failOperation(event.sequence, code, event.reason));
    if (event.disposition === 'canceled') return;
    // "A failed connection is not a successful process exit": the failure is the terminal status, and
    // the endpoint refuses an exit after it, so a held exit is dropped rather than sent to be refused.
    this.#submittedFailureSent ||= sent;
    this.#failClosed(describeFailure(code).closeCode);
  }

  /** Send the held process exit once every source has completed, or at once when there are none to wait for. */
  #flushExitWhenOutputEnded(): void {
    if (this.#sourcesCompleted >= this.#options.session.snapshot.ownership.sources.length) {
      this.#flushExit();
    }
  }

  #flushExit(): void {
    const exit = this.#pendingExit;
    if (exit === undefined) return;
    this.#pendingExit = undefined;
    if (!this.#submittedFailureSent)
      this.#deliver(this.#host.processExit(exit.exitCode, exit.signal));
    for (const held of this.#heldCancellations.splice(0)) this.#reportOperationResult(held);
  }

  /** Send a chunk as however many frames the payload budget needs, preserving every byte and the order. */
  #sendOutput(event: Extract<SessionEvent, { type: 'output' }>): void {
    const limit = this.#host.terms?.maxFrameBytes ?? MAXIMUM_FRAME_PAYLOAD_BYTES;
    let offset = 0;
    do {
      const slice = event.bytes.subarray(offset, offset + limit);
      if (!this.#deliver(this.#host.output(event.channel, slice))) return;
      offset += limit;
    } while (offset < event.bytes.length);
  }
}
