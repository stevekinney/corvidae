import { OperationLedger, OutputLedger } from './acknowledgement-ledgers.ts';
import { validateCapabilities } from './capabilities.ts';
import {
  channelPermitted,
  endsAttachment,
  isSubmittedOperationFailure,
  resolveLimits,
  toBytes,
  type AttachmentTerms,
  type EndpointCursors,
  type EndpointLimits,
  type SentFrame,
} from './endpoint-support.ts';
import { decodeFrame, encodeFrame } from './frame-codec.ts';
import type {
  Capabilities,
  CleanupOutcome,
  ClientMessage,
  HelloMessage,
  OperationFailureMessage,
  OutputChannel,
  ProtocolMessage,
} from './messages.ts';
import { MAXIMUM_FRAME_PAYLOAD_BYTES, PROTOCOL_VERSION } from './protocol-constants.ts';
import {
  accept,
  reject,
  type FailureReason,
  type ProtocolFailure,
  type ProtocolResult,
} from './protocol-failure.ts';
import { SequenceCursor } from './sequence-cursor.ts';

export type HostEndpointOptions = {
  /** The payload budget to advertise; defaults to 64 KiB. */
  readonly maxFrameBytes?: number;
  /** The operation FIFO depth to advertise; defaults to 256. */
  readonly maxQueuedOperations?: number;
};

type Rejection = { readonly ok: false; readonly failure: ProtocolFailure };
type HostPhase = 'awaiting-hello' | 'awaiting-capabilities' | 'attached';

/**
 * The host half of one attachment's wire conversation. It decodes and validates everything a
 * client sends before the session core sees it, and it builds every frame the host sends. It owns
 * no process, queue or timer: the session core feeds it received frames and asks it for frames to send.
 *
 * `receive` returns a failure for anything the failure table rejects. A hard failure (malformed,
 * oversized, wrong version, bad sequence or acknowledgement) closes the endpoint to further input.
 * A soft failure (stale generation, read-only, FIFO full) leaves the attachment live; for the
 * operation-level ones the failure carries the encoded `operation-failure` to send back.
 */
export class HostEndpoint {
  readonly #limits: EndpointLimits;
  #phase: HostPhase = 'awaiting-hello';
  #hello: HelloMessage | undefined;
  #terms: AttachmentTerms | undefined;
  #inboundClosed = false;
  #authorityRevoked = false;
  #processExitReported = false;
  #attachmentErrorReported = false;
  #cleanupReported = false;
  readonly #inbound: SequenceCursor;
  readonly #outbound: SequenceCursor;
  readonly #operations: OperationLedger;
  #hardClosed = false;
  readonly #output = new OutputLedger();

  /** `cursors` positions each direction's sequence; a fresh attachment starts both at 0. */
  constructor(
    options: HostEndpointOptions = {},
    cursors: EndpointCursors = { inbound: new SequenceCursor(), outbound: new SequenceCursor() },
  ) {
    this.#limits = resolveLimits(options);
    this.#operations = new OperationLedger(this.#limits.maxQueuedOperations);
    this.#inbound = cursors.inbound;
    this.#outbound = cursors.outbound;
  }

  get phase(): HostPhase {
    return this.#phase;
  }

  /** The accepted `hello`, once one has arrived. */
  get hello(): HelloMessage | undefined {
    return this.#hello;
  }

  /** How many operations a submitted-operation failure can still name: bounded by the FIFO window. */
  get trackedOperations(): number {
    return this.#operations.trackedCount;
  }

  /** The terms of the attachment, once capabilities have been issued. */
  get terms(): AttachmentTerms | undefined {
    return this.#terms;
  }

  /** Whether the client's authority is gone: it asked to stop, the process exited, or an operation failed after acceptance. */
  get authorityRevoked(): boolean {
    return this.#authorityRevoked;
  }

  /** Output bytes sent, and the cumulative count the client has reported parsing. */
  get outputBytes(): { readonly produced: number; readonly consumed: number } {
    return { produced: this.#output.produced, consumed: this.#output.consumed };
  }

  /** Decode and validate one frame from the client. */
  receive(frame: Uint8Array | string): ProtocolResult<ClientMessage> {
    if (this.#inboundClosed) return reject('stale-generation', 'attachment-revoked');
    // The advertised limit binds only once attachment terms exist: `hello` precedes it, and any
    // limit up to the protocol-wide maximum must still be able to complete a handshake.
    const decoded = decodeFrame(frame, 'host', {
      maxFrameBytes:
        this.#terms === undefined ? MAXIMUM_FRAME_PAYLOAD_BYTES : this.#limits.maxFrameBytes,
    });
    if (!decoded.ok) return this.#close(decoded);
    const message = decoded.value;
    if (message.kind === 'hello') {
      if (this.#phase !== 'awaiting-hello') {
        return this.#close(reject('malformed-frame', 'duplicate-handshake'));
      }
      this.#hello = message;
      this.#phase = 'awaiting-capabilities';
      return accept(message);
    }
    if (this.#phase !== 'attached') {
      return this.#close(reject('malformed-frame', 'handshake-incomplete'));
    }
    return this.#receiveAttached(message);
  }

  #close(rejection: Rejection): Rejection {
    if (endsAttachment(rejection.failure)) {
      this.#inboundClosed = true;
      this.#authorityRevoked = true;
      this.#hardClosed = true;
    }
    return rejection;
  }

  #receiveAttached(message: Exclude<ClientMessage, HelloMessage>): ProtocolResult<ClientMessage> {
    const terms = this.#terms!;
    if (message.sessionId !== this.#hello!.sessionId) {
      return this.#rejectStale(message, 'stale-session');
    }
    if (message.attachmentGeneration !== terms.generation) {
      return this.#rejectStale(message, 'stale-generation');
    }
    const verified = this.#inbound.verify(message.sequence);
    if (!verified.ok) return this.#close(verified);
    switch (message.kind) {
      case 'input':
        return this.#receiveOperation(message, terms.capabilities.input);
      case 'resize':
        return this.#receiveOperation(message, terms.capabilities.resize);
      case 'output-consumed': {
        const consumed = this.#output.verifyConsumed(message.consumedBytes);
        if (!consumed.ok) return this.#close(consumed);
        this.#output.commitConsumed(message.consumedBytes);
        break;
      }
      case 'terminate':
        this.#authorityRevoked = true;
        break;
    }
    this.#inbound.commit(message.sequence);
    return accept(message);
  }

  /**
   * Refuse a message addressed to another session or generation. An input or resize is told so with
   * an `operation-failure` on this attachment's own session and generation, because the sender's are
   * stale. The message is never queued, and its foreign sequence is neither committed nor resolved,
   * so authority, the ledgers and the live attachment are untouched.
   */
  #rejectStale(
    message: Exclude<ClientMessage, HelloMessage>,
    reason: 'stale-session' | 'stale-generation',
  ): Rejection {
    if (message.kind !== 'input' && message.kind !== 'resize') {
      return reject('stale-generation', reason);
    }
    const reply = this.#sendAttached((terms, sequence) => ({
      kind: 'operation-failure',
      sessionId: this.#hello!.sessionId,
      attachmentGeneration: terms.generation,
      sequence,
      operationSequence: message.sequence,
      code: 'stale-generation',
      message: reason,
    }));
    return this.#refusal(reply, 'stale-generation', reason);
  }

  #receiveOperation(
    message: Extract<ClientMessage, { kind: 'input' | 'resize' }>,
    permitted: boolean,
  ): ProtocolResult<ClientMessage> {
    if (this.#authorityRevoked) return this.#softReject(message, 'read-only', 'authority-revoked');
    if (!permitted) return this.#softReject(message, 'read-only', 'operation-not-permitted');
    if (this.#operations.unresolvedCount >= this.#limits.maxQueuedOperations) {
      return this.#softReject(message, 'fifo-full', 'operation-window-full');
    }
    this.#operations.submit(message.sequence);
    this.#inbound.commit(message.sequence);
    return accept(message);
  }

  /** Refuse an operation without queueing it. Its sequence is used up, and the client is told so. */
  #softReject(
    message: Extract<ClientMessage, { kind: 'input' | 'resize' }>,
    code: 'read-only' | 'fifo-full',
    reason: 'authority-revoked' | 'operation-not-permitted' | 'operation-window-full',
  ): Rejection {
    this.#inbound.commit(message.sequence);
    const reply = this.#send((sequence) => ({
      kind: 'operation-failure',
      sessionId: message.sessionId,
      attachmentGeneration: message.attachmentGeneration,
      sequence,
      operationSequence: message.sequence,
      code,
      message: reason,
    }));
    return this.#refusal(reply, code, reason);
  }

  /**
   * The soft rejection that carries `reply`. When the reply itself could not be encoded or numbered
   * (the sequence overflowed, so delivery is unknown) the soft rejection becomes the hard failure
   * that was hit: it is returned instead, and the generation and authority are revoked.
   */
  #refusal(
    reply: ProtocolResult<SentFrame>,
    code: 'read-only' | 'fifo-full' | 'stale-generation',
    reason: FailureReason,
  ): Rejection {
    if (reply.ok) return reject(code, reason, reply.value.frame as string);
    this.#authorityRevoked = true;
    return this.#close({ ok: false, failure: reply.failure });
  }

  /**
   * Answer an accepted `hello`: issue the attachment generation and advertise what this host
   * offers. Origin and token authorization belong to the caller and must come first.
   */
  issueCapabilities(options: {
    readonly generation: number;
    readonly capabilities: Capabilities;
  }): ProtocolResult<string> {
    if (this.#phase !== 'awaiting-capabilities' || this.#hello === undefined) {
      return reject('transport-failed', 'unexpected-message');
    }
    // A closed endpoint (a hard failure, or a startup error already sent) can never become attached.
    if (this.#inboundClosed) return reject('stale-generation', 'attachment-revoked');
    const broken = validateCapabilities(options.capabilities, this.#hello.requestedMode);
    if (broken !== undefined) return reject('malformed-frame', broken);
    const encoded = encodeFrame(
      {
        kind: 'capabilities',
        version: PROTOCOL_VERSION,
        sessionId: this.#hello.sessionId,
        attachmentGeneration: options.generation,
        capabilities: options.capabilities,
        maxFrameBytes: this.#limits.maxFrameBytes,
        maxQueuedOperations: this.#limits.maxQueuedOperations,
      },
      { maxFrameBytes: MAXIMUM_FRAME_PAYLOAD_BYTES },
    );
    if (!encoded.ok) return encoded;
    this.#terms = {
      generation: options.generation,
      capabilities: { ...options.capabilities },
      ...this.#limits,
    };
    this.#phase = 'attached';
    return accept(encoded.value as string);
  }

  #send(build: (sequence: number) => ProtocolMessage): ProtocolResult<SentFrame> {
    if (this.#cleanupReported) return reject('stale-generation', 'attachment-revoked');
    const next = this.#outbound.peekNext();
    // An outbound sequence that cannot advance leaves delivery unknown: apply the table's
    // `transport-failed` revocation here, so every send path does, not only the refusal path.
    if (!next.ok) return this.#close(next);
    const encoded = encodeFrame(build(next.value), { maxFrameBytes: this.#limits.maxFrameBytes });
    if (!encoded.ok) return encoded;
    this.#outbound.commit(next.value);
    return accept({ frame: encoded.value, sequence: next.value });
  }

  #sendAttached(
    build: (terms: AttachmentTerms, sequence: number) => ProtocolMessage,
  ): ProtocolResult<SentFrame> {
    const terms = this.#terms;
    if (terms === undefined) return reject('stale-generation', 'handshake-incomplete');
    return this.#send((sequence) => build(terms, sequence));
  }

  /** Send output bytes, copying them. A string is encoded as UTF-8; its length is never a byte count. */
  output(channel: OutputChannel, data: Uint8Array | string): ProtocolResult<SentFrame> {
    const terms = this.#terms;
    if (terms !== undefined && !channelPermitted(terms.capabilities.mode, channel)) {
      return reject('malformed-frame', 'channel-not-permitted');
    }
    // A hard close revoked the generation: only the explicit cancellations and cleanup remain.
    if (this.#hardClosed) return reject('stale-generation', 'attachment-revoked');
    // The process-exit result follows the end of output ("PTY EOF or source completion, then the
    // distinct process-exit result"), so no output follows it.
    if (this.#processExitReported) return reject('malformed-frame', 'unexpected-message');
    const payload = toBytes(data);
    const sent = this.#sendAttached((attached, sequence) => ({
      kind: 'output',
      sessionId: this.#hello!.sessionId,
      attachmentGeneration: attached.generation,
      sequence,
      channel,
      payload,
    }));
    if (sent.ok) this.#output.record(payload.length);
    return sent;
  }

  /** Report that operation `operationSequence` entered the host FIFO. This is acceptance, never execution. */
  acknowledgeOperation(operationSequence: number): ProtocolResult<SentFrame> {
    // Once authority is revoked, "stop ... cancels queued but unsubmitted operations with explicit
    // results": a pending operation is failed, never accepted into the FIFO.
    if (this.#hardClosed) return reject('stale-generation', 'attachment-revoked');
    if (this.#authorityRevoked) return reject('read-only', 'authority-revoked');
    const verified = this.#operations.verifyResolution(operationSequence);
    if (!verified.ok) return verified;
    const sent = this.#sendAttached((terms, sequence) => ({
      kind: 'operation-ack',
      sessionId: this.#hello!.sessionId,
      attachmentGeneration: terms.generation,
      sequence,
      operationSequence,
    }));
    if (sent.ok) this.#operations.resolve();
    return sent;
  }

  /**
   * Report that an operation did not complete. Before queueing (`read-only`, `fifo-full`) it names
   * the oldest unresolved operation. After acceptance (`backend-failed`, `transport-failed`) it
   * may name any submitted operation, and it revokes the client's authority.
   */
  failOperation(
    operationSequence: number,
    code: OperationFailureMessage['code'],
    message: string,
  ): ProtocolResult<SentFrame> {
    // A stale-generation failure answers a foreign message in `receive`; it never names a queued operation.
    if (code === 'stale-generation') return reject('malformed-frame', 'invalid-field');
    const submitted = isSubmittedOperationFailure(code);
    const verified = submitted
      ? this.#operations.verifySubmitted(operationSequence)
      : this.#operations.verifyResolution(operationSequence);
    if (!verified.ok) return verified;
    const sent = this.#sendAttached((terms, sequence) => ({
      kind: 'operation-failure',
      sessionId: this.#hello!.sessionId,
      attachmentGeneration: terms.generation,
      sequence,
      operationSequence,
      code,
      message,
    }));
    if (sent.ok) {
      if (submitted) {
        this.#authorityRevoked = true;
        this.#operations.retire(operationSequence);
      } else this.#operations.refuse();
    }
    return sent;
  }

  /** Report the process exit, once, separately from PTY end of file and from cleanup. */
  processExit(exitCode: number | null, signal: string | null): ProtocolResult<SentFrame> {
    if (this.#hardClosed) return reject('stale-generation', 'attachment-revoked');
    if (this.#processExitReported) return reject('malformed-frame', 'already-reported');
    // "A failed connection is not a successful process exit": nothing follows an attachment error.
    if (this.#attachmentErrorReported) return reject('malformed-frame', 'unexpected-message');
    // An output-only source reports source completion and never invents an exit code.
    if (this.#terms?.capabilities.mode === 'output-only') {
      return reject('malformed-frame', 'unexpected-message');
    }
    const sent = this.#sendAttached((terms, sequence) => ({
      kind: 'process-exit',
      sessionId: this.#hello!.sessionId,
      attachmentGeneration: terms.generation,
      sequence,
      exitCode,
      signal,
    }));
    if (sent.ok) {
      this.#processExitReported = true;
      // Process exit revokes the generation's input authority, ahead of cleanup.
      this.#authorityRevoked = true;
    }
    return sent;
  }

  /**
   * Report a startup or attachment failure, which is never a successful exit. Before capabilities
   * were issued there is no generation, so the message carries generation 0 and sequence 0.
   */
  attachmentError(
    code: 'unsupported-runtime' | 'spawn-failed' | 'backend-failed' | 'transport-failed',
    message: string,
  ): ProtocolResult<SentFrame> {
    const hello = this.#hello;
    if (hello === undefined) return reject('stale-generation', 'handshake-incomplete');
    if (this.#hardClosed) return reject('stale-generation', 'attachment-revoked');
    // An attachment error revokes the generation, and a reported process exit already ended it, so
    // only one terminal event is ever sent.
    if (this.#attachmentErrorReported || this.#processExitReported) {
      return reject('malformed-frame', 'unexpected-message');
    }
    if (this.#terms === undefined) {
      const encoded = encodeFrame(
        {
          kind: 'attachment-error',
          sessionId: hello.sessionId,
          attachmentGeneration: 0,
          sequence: 0,
          code,
          message,
        },
        { maxFrameBytes: MAXIMUM_FRAME_PAYLOAD_BYTES },
      );
      if (!encoded.ok) return encoded;
      this.#inboundClosed = true;
      this.#authorityRevoked = true;
      this.#attachmentErrorReported = true;
      return accept({ frame: encoded.value, sequence: 0 });
    }
    // `unsupported-runtime` is a startup failure with no attachment, so it has no generation to name.
    if (code === 'unsupported-runtime') return reject('malformed-frame', 'unexpected-message');
    const sent = this.#sendAttached((terms, sequence) => ({
      kind: 'attachment-error',
      sessionId: hello.sessionId,
      attachmentGeneration: terms.generation,
      sequence,
      code,
      message,
    }));
    if (sent.ok) {
      this.#authorityRevoked = true;
      this.#attachmentErrorReported = true;
    }
    return sent;
  }

  /** Send the final cleanup report. It is sent once; nothing can be sent after it. */
  cleanupResult(outcome: CleanupOutcome): ProtocolResult<SentFrame> {
    // Stop "cancels queued but unsubmitted operations with explicit results" before cleanup is
    // reported, so a received operation still unresolved must be failed first.
    if (this.#operations.unresolvedCount > 0) {
      return reject('malformed-frame', 'unexpected-message');
    }
    const sent = this.#sendAttached((terms, sequence) => ({
      kind: 'cleanup-result',
      sessionId: this.#hello!.sessionId,
      attachmentGeneration: terms.generation,
      sequence,
      outcome,
    }));
    if (sent.ok) {
      this.#cleanupReported = true;
      this.#inboundClosed = true;
      this.#authorityRevoked = true;
    }
    return sent;
  }
}
