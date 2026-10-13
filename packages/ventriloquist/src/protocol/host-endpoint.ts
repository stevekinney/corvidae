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
import type { FailureCode } from './failure-codes.ts';
import { decodeFrame, encodeFrame } from './frame-codec.ts';
import type {
  Capabilities,
  CleanupOutcome,
  ClientMessage,
  HelloMessage,
  OutputChannel,
  ProtocolMessage,
} from './messages.ts';
import { PROTOCOL_VERSION } from './protocol-constants.ts';
import { accept, reject, type ProtocolFailure, type ProtocolResult } from './protocol-failure.ts';
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
  #cleanupReported = false;
  readonly #inbound: SequenceCursor;
  readonly #outbound: SequenceCursor;
  readonly #operations = new OperationLedger();
  readonly #output = new OutputLedger();

  /** `cursors` positions each direction's sequence; a fresh attachment starts both at 0. */
  constructor(
    options: HostEndpointOptions = {},
    cursors: EndpointCursors = { inbound: new SequenceCursor(), outbound: new SequenceCursor() },
  ) {
    this.#limits = resolveLimits(options);
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

  /** The terms of the attachment, once capabilities have been issued. */
  get terms(): AttachmentTerms | undefined {
    return this.#terms;
  }

  /** Whether the client's authority is gone: it asked to stop, or an operation failed after acceptance. */
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
    const decoded = decodeFrame(frame, 'host', { maxFrameBytes: this.#limits.maxFrameBytes });
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
    if (endsAttachment(rejection.failure)) this.#inboundClosed = true;
    return rejection;
  }

  #receiveAttached(message: Exclude<ClientMessage, HelloMessage>): ProtocolResult<ClientMessage> {
    const terms = this.#terms!;
    if (message.sessionId !== this.#hello!.sessionId) {
      return reject('stale-generation', 'stale-session');
    }
    if (message.attachmentGeneration !== terms.generation) {
      return reject('stale-generation', 'stale-generation');
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
    return reject(code, reason, reply.ok ? (reply.value.frame as string) : undefined);
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
      { maxFrameBytes: this.#limits.maxFrameBytes },
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
    if (!next.ok) return next;
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
    code: FailureCode,
    message: string,
  ): ProtocolResult<SentFrame> {
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
      if (submitted) this.#authorityRevoked = true;
      else this.#operations.resolve();
    }
    return sent;
  }

  /** Report the process exit, once, separately from PTY end of file and from cleanup. */
  processExit(exitCode: number | null, signal: string | null): ProtocolResult<SentFrame> {
    if (this.#processExitReported) return reject('malformed-frame', 'already-reported');
    const sent = this.#sendAttached((terms, sequence) => ({
      kind: 'process-exit',
      sessionId: this.#hello!.sessionId,
      attachmentGeneration: terms.generation,
      sequence,
      exitCode,
      signal,
    }));
    if (sent.ok) this.#processExitReported = true;
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
        { maxFrameBytes: this.#limits.maxFrameBytes },
      );
      if (!encoded.ok) return encoded;
      this.#inboundClosed = true;
      return accept({ frame: encoded.value, sequence: 0 });
    }
    const sent = this.#sendAttached((terms, sequence) => ({
      kind: 'attachment-error',
      sessionId: hello.sessionId,
      attachmentGeneration: terms.generation,
      sequence,
      code,
      message,
    }));
    if (sent.ok) this.#authorityRevoked = true;
    return sent;
  }

  /** Send the final cleanup report. It is sent once; nothing can be sent after it. */
  cleanupResult(outcome: CleanupOutcome): ProtocolResult<SentFrame> {
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
    }
    return sent;
  }
}
