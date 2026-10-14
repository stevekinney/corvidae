import type { SentFrame } from '../protocol/endpoint-support.ts';
import { describeFailure } from '../protocol/failure-table.ts';
import { HostEndpoint, type HostEndpointOptions } from '../protocol/host-endpoint.ts';
import type { ClientMessage, HelloMessage } from '../protocol/messages.ts';
import { MAXIMUM_FRAME_PAYLOAD_BYTES } from '../protocol/protocol-constants.ts';
import type { ProtocolFailure, ProtocolResult } from '../protocol/protocol-failure.ts';
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

  constructor(options: SessionConnectionOptions) {
    this.#options = options;
    this.#host = new HostEndpoint(options.limits);
  }

  /** Feed one frame received from the client. */
  receive(frame: Uint8Array | string): void {
    this.#attachment?.heartbeat();
    const received = this.#host.receive(frame);
    if (!received.ok) {
      this.#reject(received.failure);
      return;
    }
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
    this.#sent(issued.ok ? { frame: issued.value, sequence: 0 } : undefined);
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
    this.#sent(
      receipt.disposition === 'accepted'
        ? this.#unwrap(this.#host.acknowledgeOperation(sequence))
        : this.#unwrap(
            this.#host.failOperation(sequence, failureCodeFor(receipt.reason), receipt.reason),
          ),
    );
  }

  #unwrap(result: ProtocolResult<SentFrame>): SentFrame | undefined {
    return result.ok ? result.value : undefined;
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

  #sent(sent: SentFrame | undefined): void {
    if (sent !== undefined) this.#transmit(sent.frame);
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
        this.#sent(this.#unwrap(this.#host.processExit(event.exitCode, event.signal)));
        break;
      case 'operationResult':
        this.#sent(
          this.#unwrap(
            this.#host.failOperation(
              event.sequence,
              event.disposition === 'unknown' ? 'transport-failed' : 'backend-failed',
              event.reason,
            ),
          ),
        );
        break;
      case 'sessionClosed':
        this.#sent(this.#unwrap(this.#host.cleanupResult(event.summary.cleanup)));
        this.#close(1000);
        break;
      case 'sourceComplete':
      case 'attachmentRevoked':
        // Neither has a wire message: end of file is invisible to the client except as the
        // absence of a process-exit, and revocation is announced by the cleanup result that follows.
        break;
    }
  }

  /** Send a chunk as however many frames the payload budget needs, preserving every byte and the order. */
  #sendOutput(event: Extract<SessionEvent, { type: 'output' }>): void {
    const limit = this.#host.terms?.maxFrameBytes ?? MAXIMUM_FRAME_PAYLOAD_BYTES;
    let offset = 0;
    do {
      const slice = event.bytes.subarray(offset, offset + limit);
      this.#sent(this.#unwrap(this.#host.output(event.channel, slice)));
      offset += limit;
    } while (offset < event.bytes.length);
  }
}
