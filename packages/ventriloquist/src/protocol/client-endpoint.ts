import { OperationLedger, OutputLedger } from './acknowledgement-ledgers.ts';
import { validateCapabilities } from './capabilities.ts';
import {
  channelPermitted,
  endsAttachment,
  isSubmittedOperationFailure,
  toBytes,
  type AttachmentTerms,
  type EndpointCursors,
  type SentFrame,
} from './endpoint-support.ts';
import { decodeFrame, encodeFrame } from './frame-codec.ts';
import type {
  Capabilities,
  CapabilitiesMessage,
  ProtocolMessage,
  RequestedMode,
  ServerMessage,
} from './messages.ts';
import { MAXIMUM_FRAME_PAYLOAD_BYTES, PROTOCOL_VERSION } from './protocol-constants.ts';
import { accept, reject, type ProtocolFailure, type ProtocolResult } from './protocol-failure.ts';
import { SequenceCursor } from './sequence-cursor.ts';

export type ClientEndpointOptions = {
  /** The opaque UUID of the session to attach to. */
  readonly sessionId: string;
  readonly requestedMode: RequestedMode;
  /** Authorizes the attachment. It appears only in the `hello` frame and never in a failure. */
  readonly token: string;
};

type Rejection = { readonly ok: false; readonly failure: ProtocolFailure };
type ClientPhase = 'idle' | 'awaiting-capabilities' | 'attached' | 'closed';
type AttachedServerMessage = Exclude<ServerMessage, CapabilitiesMessage>;

/**
 * The client half of one attachment's wire conversation. It builds every frame the client sends,
 * refusing locally what the host would refuse, and validates every frame the host sends before the
 * controller sees it. Like the host half it owns no transport, process or timer.
 */
export class ClientEndpoint {
  readonly #options: ClientEndpointOptions;
  #phase: ClientPhase = 'idle';
  #terms: AttachmentTerms | undefined;
  #authorityRevoked = false;
  #processExitReceived = false;
  readonly #inbound: SequenceCursor;
  readonly #outbound: SequenceCursor;
  readonly #operations = new OperationLedger();
  readonly #output = new OutputLedger();

  /** `cursors` positions each direction's sequence; a fresh attachment starts both at 0. */
  constructor(
    options: ClientEndpointOptions,
    cursors: EndpointCursors = { inbound: new SequenceCursor(), outbound: new SequenceCursor() },
  ) {
    this.#options = options;
    this.#inbound = cursors.inbound;
    this.#outbound = cursors.outbound;
  }

  get phase(): ClientPhase {
    return this.#phase;
  }

  /** The terms of the attachment, once the host's capabilities have been accepted. */
  get terms(): AttachmentTerms | undefined {
    return this.#terms;
  }

  /** Whether this client may no longer send input or resize: it asked to stop, or the host revoked it. */
  get authorityRevoked(): boolean {
    return this.#authorityRevoked;
  }

  /** Output bytes received, and the cumulative count this client has reported parsing. */
  get outputBytes(): { readonly received: number; readonly consumed: number } {
    return { received: this.#output.produced, consumed: this.#output.consumed };
  }

  /** Build the handshake request. */
  hello(): ProtocolResult<string> {
    if (this.#phase !== 'idle') return reject('transport-failed', 'duplicate-handshake');
    const encoded = encodeFrame({
      kind: 'hello',
      version: PROTOCOL_VERSION,
      sessionId: this.#options.sessionId,
      requestedMode: this.#options.requestedMode,
      token: this.#options.token,
    });
    if (!encoded.ok) return encoded;
    this.#phase = 'awaiting-capabilities';
    return accept(encoded.value as string);
  }

  /** Decode and validate one frame from the host. */
  receive(frame: Uint8Array | string): ProtocolResult<ServerMessage> {
    if (this.#phase === 'closed') return reject('stale-generation', 'attachment-revoked');
    const decoded = decodeFrame(frame, 'client', {
      maxFrameBytes: this.#terms?.maxFrameBytes ?? MAXIMUM_FRAME_PAYLOAD_BYTES,
    });
    if (!decoded.ok) return this.#close(decoded);
    const message = decoded.value;
    if (this.#phase === 'attached') {
      if (message.kind === 'capabilities') {
        return this.#close(reject('malformed-frame', 'duplicate-handshake'));
      }
      return this.#receiveAttached(message);
    }
    if (this.#phase === 'idle')
      return this.#close(reject('malformed-frame', 'handshake-incomplete'));
    if (message.kind === 'capabilities') return this.#receiveCapabilities(message);
    if (message.kind === 'attachment-error' && message.attachmentGeneration === 0) {
      return this.#receiveStartupError(message);
    }
    return this.#close(reject('malformed-frame', 'handshake-incomplete'));
  }

  #close(rejection: Rejection): Rejection {
    if (endsAttachment(rejection.failure)) {
      this.#phase = 'closed';
      this.#authorityRevoked = true;
    }
    return rejection;
  }

  #receiveStartupError(message: AttachedServerMessage): ProtocolResult<ServerMessage> {
    if (message.sessionId !== this.#options.sessionId) {
      return reject('stale-generation', 'stale-session');
    }
    this.#phase = 'closed';
    this.#authorityRevoked = true;
    return accept(message);
  }

  #receiveCapabilities(message: CapabilitiesMessage): ProtocolResult<ServerMessage> {
    if (message.sessionId !== this.#options.sessionId) {
      return reject('stale-generation', 'stale-session');
    }
    const broken = validateCapabilities(message.capabilities, this.#options.requestedMode);
    if (broken !== undefined) return this.#close(reject('malformed-frame', broken));
    this.#terms = {
      generation: message.attachmentGeneration,
      capabilities: message.capabilities,
      maxFrameBytes: message.maxFrameBytes,
      maxQueuedOperations: message.maxQueuedOperations,
    };
    this.#phase = 'attached';
    return accept(message);
  }

  #receiveAttached(message: AttachedServerMessage): ProtocolResult<ServerMessage> {
    const terms = this.#terms!;
    if (message.sessionId !== this.#options.sessionId) {
      return reject('stale-generation', 'stale-session');
    }
    if (message.attachmentGeneration !== terms.generation) {
      return reject('stale-generation', 'stale-generation');
    }
    const verified = this.#inbound.verify(message.sequence);
    if (!verified.ok) return this.#close(verified);
    const rejection = this.#applyServerMessage(message, terms);
    if (rejection !== undefined) return this.#close(rejection);
    this.#inbound.commit(message.sequence);
    return accept(message);
  }

  /** Validate a server message against attachment state, then record it. Nothing is recorded on failure. */
  #applyServerMessage(
    message: AttachedServerMessage,
    terms: AttachmentTerms,
  ): Rejection | undefined {
    switch (message.kind) {
      case 'output':
        if (!channelPermitted(terms.capabilities.mode, message.channel)) {
          return reject('malformed-frame', 'channel-not-permitted');
        }
        this.#output.record(message.payload.length);
        return undefined;
      case 'operation-ack': {
        const verified = this.#operations.verifyResolution(message.operationSequence);
        if (!verified.ok) return verified;
        this.#operations.resolve();
        return undefined;
      }
      case 'operation-failure': {
        // The refused operation carried another generation's sequence, so no ledger entry matches it.
        if (message.code === 'stale-generation') return undefined;
        const submitted = isSubmittedOperationFailure(message.code);
        const verified = submitted
          ? this.#operations.verifySubmitted(message.operationSequence)
          : this.#operations.verifyResolution(message.operationSequence);
        if (!verified.ok) return verified;
        if (submitted) this.#authorityRevoked = true;
        else this.#operations.refuse();
        return undefined;
      }
      case 'process-exit':
        if (this.#processExitReceived) return reject('malformed-frame', 'already-reported');
        this.#processExitReceived = true;
        // The process is gone, so there is nothing left to receive input or a resize.
        this.#authorityRevoked = true;
        return undefined;
      case 'attachment-error':
        this.#authorityRevoked = true;
        return undefined;
      case 'cleanup-result':
        this.#authorityRevoked = true;
        this.#phase = 'closed';
        return undefined;
    }
  }

  #send(
    build: (terms: AttachmentTerms, sequence: number) => ProtocolMessage,
  ): ProtocolResult<SentFrame> {
    const terms = this.#terms;
    if (terms === undefined || this.#phase !== 'attached') {
      return reject('stale-generation', 'attachment-revoked');
    }
    const next = this.#outbound.peekNext();
    if (!next.ok) return next;
    const encoded = encodeFrame(build(terms, next.value), { maxFrameBytes: terms.maxFrameBytes });
    if (!encoded.ok) return encoded;
    this.#outbound.commit(next.value);
    return accept({ frame: encoded.value, sequence: next.value });
  }

  /** Send an input or resize, refusing locally whatever the host would refuse. */
  #sendOperation(
    permits: (capabilities: Capabilities) => boolean,
    build: (terms: AttachmentTerms, sequence: number) => ProtocolMessage,
  ): ProtocolResult<SentFrame> {
    const terms = this.#terms;
    if (terms === undefined || this.#phase !== 'attached') {
      return reject('stale-generation', 'attachment-revoked');
    }
    if (this.#authorityRevoked) return reject('read-only', 'authority-revoked');
    if (!permits(terms.capabilities)) return reject('read-only', 'operation-not-permitted');
    if (this.#operations.unresolvedCount >= terms.maxQueuedOperations) {
      return reject('fifo-full', 'operation-window-full');
    }
    const sent = this.#send(build);
    if (sent.ok) this.#operations.submit(sent.value.sequence);
    return sent;
  }

  /**
   * Send input bytes, copying them. A string is encoded as UTF-8, and its UTF-16 length is never
   * used as a byte count. The returned sequence identifies the operation in later acknowledgements.
   */
  input(data: Uint8Array | string): ProtocolResult<SentFrame> {
    const payload = toBytes(data);
    return this.#sendOperation(
      (capabilities) => capabilities.input,
      (terms, sequence) => ({
        kind: 'input',
        sessionId: this.#options.sessionId,
        attachmentGeneration: terms.generation,
        sequence,
        payload,
      }),
    );
  }

  /** Send new terminal dimensions, which share the input operation sequence. */
  resize(columns: number, rows: number): ProtocolResult<SentFrame> {
    return this.#sendOperation(
      (capabilities) => capabilities.resize,
      (terms, sequence) => ({
        kind: 'resize',
        sessionId: this.#options.sessionId,
        attachmentGeneration: terms.generation,
        sequence,
        columns,
        rows,
      }),
    );
  }

  /** Report that `byteCount` more output bytes have been parsed. The frame carries the cumulative total. */
  consumeOutput(byteCount: number): ProtocolResult<SentFrame> {
    if (!Number.isSafeInteger(byteCount) || byteCount < 1) {
      return reject('malformed-frame', 'invalid-count');
    }
    const total = this.#output.consumed + byteCount;
    const verified = this.#output.verifyConsumed(total);
    if (!verified.ok) return verified;
    const sent = this.#send((terms, sequence) => ({
      kind: 'output-consumed',
      sessionId: this.#options.sessionId,
      attachmentGeneration: terms.generation,
      sequence,
      consumedBytes: total,
    }));
    if (sent.ok) this.#output.commitConsumed(total);
    return sent;
  }

  /** Ask the host to stop. Authority is revoked here immediately; unsent operations are never sent. */
  terminate(): ProtocolResult<SentFrame> {
    const sent = this.#send((terms, sequence) => ({
      kind: 'terminate',
      sessionId: this.#options.sessionId,
      attachmentGeneration: terms.generation,
      sequence,
    }));
    if (sent.ok) this.#authorityRevoked = true;
    return sent;
  }
}
