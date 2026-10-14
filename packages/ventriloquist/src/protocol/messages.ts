import type { ATTACHMENT_ERROR_CODES, OPERATION_FAILURE_CODES } from './failure-table.ts';
import type { MessageKind, PROTOCOL_VERSION } from './protocol-constants.ts';

/** The one wire version this package speaks. */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Whether a session accepts input or only observes output. */
export type RequestedMode = 'read-only' | 'interactive';

/** Which channel an output chunk came from; order is preserved per channel, never across channels. */
export type OutputChannel = 'pty' | 'stdout' | 'stderr';

/** The fields every frame carries: its kind, session, immutable attachment generation and sequence. */
export type FrameHeader<Kind extends MessageKind> = {
  readonly kind: Kind;
  readonly sessionId: string;
  readonly attachmentGeneration: number;
  readonly sequence: number;
};

/** Client to server: opens an attachment. The token is authorized before any generation is issued. */
export type HelloMessage = {
  readonly kind: 'hello';
  readonly version: ProtocolVersion;
  readonly sessionId: string;
  readonly requestedMode: RequestedMode;
  readonly token: string;
};

/** What the host offers for this attachment. Pipe mode reports no input-side process-terminal capability. */
export type Capabilities = {
  readonly mode: 'pty' | 'pipe' | 'output-only';
  readonly input: boolean;
  readonly resize: boolean;
  readonly kill: boolean;
  readonly readOnly: boolean;
};

/** Server to client: the handshake response, issuing the attachment generation. */
export type CapabilitiesMessage = {
  readonly kind: 'capabilities';
  readonly version: ProtocolVersion;
  readonly sessionId: string;
  readonly attachmentGeneration: number;
  readonly capabilities: Capabilities;
  readonly maxFrameBytes: number;
  readonly maxQueuedOperations: number;
};

/** Server to client: raw output bytes. Empty, NUL and invalid UTF-8 payloads are all legal data. */
export type OutputMessage = FrameHeader<'output'> & {
  readonly channel: OutputChannel;
  readonly payload: Uint8Array;
};

/** Client to server: raw input bytes, accepted into the bounded host FIFO in operation order. */
export type InputMessage = FrameHeader<'input'> & {
  readonly payload: Uint8Array;
};

/** Client to server: new terminal dimensions, sharing the input operation sequence and FIFO. */
export type ResizeMessage = FrameHeader<'resize'> & {
  readonly columns: number;
  readonly rows: number;
};

/** Server to client: an operation entered the host FIFO. This is acceptance, never execution. */
export type OperationAcknowledgementMessage = FrameHeader<'operation-ack'> & {
  readonly operationSequence: number;
};

/** Server to client: an operation was rejected or failed after submission. */
export type OperationFailureMessage = FrameHeader<'operation-failure'> & {
  readonly operationSequence: number;
  readonly code: (typeof OPERATION_FAILURE_CODES)[number];
  readonly message: string;
};

/** Client to server: cumulative count of output bytes the client has parsed, never more than was sent. */
export type OutputConsumedMessage = FrameHeader<'output-consumed'> & {
  readonly consumedBytes: number;
};

/** Server to client: the process ended, reported separately from PTY end of file or source completion. */
export type ProcessExitMessage = FrameHeader<'process-exit'> & {
  readonly exitCode: number | null;
  readonly signal: string | null;
};

/** Server to client: a startup or attachment failure. It is never a successful process exit. */
export type AttachmentErrorMessage = FrameHeader<'attachment-error'> & {
  readonly code: (typeof ATTACHMENT_ERROR_CODES)[number];
  readonly message: string;
};

/** Client to server: stop. Authority is revoked immediately and unsubmitted operations are cancelled. */
export type TerminateMessage = FrameHeader<'terminate'>;

/** How cleanup ended; incomplete and unknown quarantine the ownership slot. */
export type CleanupOutcome = 'complete' | 'incomplete' | 'unknown';

/** Server to client: the final cleanup report for an attachment. */
export type CleanupResultMessage = FrameHeader<'cleanup-result'> & {
  readonly outcome: CleanupOutcome;
};

/** Every message a client may send. */
export type ClientMessage =
  HelloMessage | InputMessage | ResizeMessage | OutputConsumedMessage | TerminateMessage;

/** Every message a server may send. */
export type ServerMessage =
  | CapabilitiesMessage
  | OutputMessage
  | OperationAcknowledgementMessage
  | OperationFailureMessage
  | ProcessExitMessage
  | AttachmentErrorMessage
  | CleanupResultMessage;

/** Any message in the version 1 wire schema. */
export type ProtocolMessage = ClientMessage | ServerMessage;
