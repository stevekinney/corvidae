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
  /** The close code to use once the cleanup result has been sent, when a failure fixed one earlier. */
  #closeCodeAfterCleanup: number | undefined;
  /** How many of the session's sources have reported completion on this attachment. */
  #sourcesCompleted = 0;
  /** A process exit held back until output has ended, so no trailing byte follows it. */
  #pendingExit: { readonly exitCode: number | null; readonly signal: string | null } | undefined;

  constructor(options: SessionConnectionOptions) {
    this.#options = options;
    this.#host = new HostEndpoint(options.limits);
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
        attachment.stop();
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
    const result = session.attach({
      requestedMode: hello.requestedMode,
      grant: admission.grant,
      listener: (event) => this.#onEvent(event),
    });
    if (!result.accepted) {
      this.#close(1008);
      return;
    }
    this.#attachment = result.attachment;
    const issued = this.#host.issueCapabilities({
      generation: result.authority.generation,
      capabilities: result.authority.capabilities,
    });
    this.#deliver(issued.ok ? accept({ frame: issued.value, sequence: 0 }) : issued);
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
    if (result.ok) {
      this.#transmit(result.value.frame);
      return true;
    }
    const { failure } = result;
    if (failure.reason !== 'attachment-revoked') {
      void this.#attachment?.protocolViolation();
      this.#close(describeFailure(failure.code).closeCode);
    }
    return false;
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
   * Put a frame on the transport. A transport that throws is failed rather than left half-open:
   * the attachment is revoked as a violation and the transport is closed with the transport-failure code.
   */
  #transmit(frame: Uint8Array | string): void {
    try {
      this.#options.send(frame);
    } catch {
      void this.#attachment?.protocolViolation();
      this.#close(TRANSPORT_FAILURE_CLOSE_CODE);
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
    this.#close(describeFailure(failure.code).closeCode);
  }

  #onEvent(event: SessionEvent): void {
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
        this.#deliver(
          this.#host.failOperation(
            event.sequence,
            event.disposition === 'unknown' ? 'transport-failed' : 'backend-failed',
            event.reason,
          ),
        );
        break;
      case 'attachmentRevoked':
        // No further output is accepted once the generation is revoked, so a held exit is final.
        this.#flushExit();
        if (event.cause === 'start-failed') {
          // The backend never started: report the failure, never a process exit, and close with its code.
          this.#deliver(this.#host.attachmentError('spawn-failed', 'the backend failed to start'));
          this.#closeCodeAfterCleanup ??= describeFailure('spawn-failed').closeCode;
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
    this.#deliver(this.#host.processExit(exit.exitCode, exit.signal));
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
