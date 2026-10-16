import type {
  Capabilities,
  CleanupOutcome,
  FailureCode,
  FailureReason,
  OutputChannel,
  RequestedMode,
} from '@lostgradient/ventriloquist';

/**
 * The part of the interaction states the transport decides, as `documentation/terminal/experience.md`
 * names them. `empty` is a client that has not connected; the rest follow the wire:
 *
 * - `connecting`: the socket is opening or the handshake is in flight. Input is disabled.
 * - `writable` and `read-only`: the host issued capabilities, and the server's grant decides which.
 * - `backpressured`: the host refused input as `fifo-full`. Input and resize are refused locally
 *   until an acknowledgement frees the window.
 * - `exited`: the process ended. This is not a failure and not a connection loss.
 * - `disconnected`: the transport ended without a host report. Delivery of anything unresolved is
 *   unknown, the process may or may not have outlived it, and nothing reconnects.
 * - `denied`: the host refused the attachment before issuing capabilities.
 * - `failed`: a startup failure, a submitted operation that failed, or a broken protocol.
 * - `cleanup-incomplete`: cleanup finished `incomplete` or `unknown`, so the slot is quarantined.
 */
export type TerminalTransportState =
  | 'empty'
  | 'connecting'
  | 'writable'
  | 'read-only'
  | 'backpressured'
  | 'exited'
  | 'disconnected'
  | 'denied'
  | 'failed'
  | 'cleanup-incomplete';

/** How an input or resize ended. Nothing here is retried, and `unknown` is never read as success. */
export type OperationResult =
  /** The host accepted it into its operation FIFO. That is not backend consumption. */
  | { readonly status: 'accepted'; readonly sequence: number }
  /** Refused before anything was sent: the frame was never built, so the host never saw it. */
  | { readonly status: 'refused'; readonly code: FailureCode; readonly reason: FailureReason }
  /** The host refused it, or it failed after submission. */
  | { readonly status: 'failed'; readonly sequence: number; readonly code: FailureCode }
  /** The connection ended before the host answered, so the host may or may not have it. */
  | { readonly status: 'unknown'; readonly sequence: number };

export type InputResult = OperationResult;
export type ResizeResult = OperationResult;

/** How a stop ended. `local` means the client concluded it without a report from the host. */
export type CleanupResult = {
  readonly outcome: CleanupOutcome;
  readonly source: 'host' | 'local';
};

/**
 * Receives one chunk of output bytes. Call `parsed` exactly once, when the bytes were parsed.
 * `channel` says which stream the host read the chunk from: `pty` for a terminal's one combined
 * stream, `stdout` or `stderr` for a pipe, which keeps the two apart. Order holds within a channel
 * and never across channels, and a listener that wants one channel must still report the other
 * channel's chunks parsed, because acknowledgement counts every byte in delivery order.
 */
export type OutputListener = (
  chunk: Uint8Array,
  parsed: () => void,
  channel: OutputChannel,
) => void;

export type TerminalTransportEvent =
  | {
      readonly type: 'state';
      readonly state: TerminalTransportState;
      readonly previous: TerminalTransportState;
    }
  | { readonly type: 'capabilities'; readonly capabilities: Capabilities }
  | { readonly type: 'operation-ack'; readonly sequence: number }
  | {
      readonly type: 'operation-failure';
      readonly sequence: number;
      readonly code: FailureCode;
      readonly message: string;
    }
  | {
      readonly type: 'process-exit';
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | { readonly type: 'attachment-error'; readonly code: FailureCode; readonly message: string }
  | { readonly type: 'cleanup-result'; readonly outcome: CleanupOutcome }
  | {
      readonly type: 'transport-error';
      readonly cause: 'closed' | 'error' | 'send-failed' | 'protocol' | 'callback-failed';
      readonly closeCode?: number;
      readonly failure?: FailureCode;
    }
  | { readonly type: 'delivery-unknown'; readonly sequences: readonly number[] };

/** The slice of a browser `WebSocket` the client drives, so a test can supply a fake and nothing else is assumed. */
export type BrowserSocket = {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'error', listener: (event: Event) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'close', listener: (event: CloseEvent) => void): void;
};

/** Arms a one-shot timer and returns the function that cancels it. */
export type Schedule = (callback: () => void, delayMilliseconds: number) => () => void;

export type TerminalWebSocketClientOptions = {
  /**
   * The `ws:` or `wss:` address, naming the profile as a query parameter. It carries no credential:
   * the browser sends the host's HttpOnly session cookie on its own, and a URL with userinfo or a
   * credential-looking parameter is refused.
   */
  readonly url: string;
  /** The identity of the session to attach to. The host decides whether it may. */
  readonly sessionId: string;
  readonly requestedMode?: RequestedMode;
  /**
   * The host's opaque attachment value, sent as the `hello` token. It is not the session cookie and
   * never appears in an event, an error or a result.
   */
  readonly ticket: string;
  /** Allow a plain `ws:` address, and only to a loopback host. For local development. */
  readonly allowInsecureLoopback?: boolean;
  /** Defaults to `new WebSocket(url)`. */
  readonly createSocket?: (url: string) => BrowserSocket;
  /** Defaults to the global `setTimeout`. */
  readonly schedule?: Schedule;
  /** How long the handshake may take before the attempt fails. Defaults to 15 seconds. */
  readonly connectTimeoutMilliseconds?: number;
  /** The first wait before a capacity probe while backpressured, doubling each refusal. Defaults to 250 ms. */
  readonly probeInitialMilliseconds?: number;
  /** The longest wait between capacity probes. Defaults to 8 seconds. */
  readonly probeMaximumMilliseconds?: number;
  /** How long `stop()` waits for the host's cleanup report before resolving `unknown`. Defaults to 10 seconds. */
  readonly stopTimeoutMilliseconds?: number;
  /** Output held while nothing is subscribed. Defaults to 1 MiB, the host's own output budget. */
  readonly maximumPendingOutputBytes?: number;
};

export type TerminalConnectFailure =
  | 'already-used'
  | 'socket-unavailable'
  | 'handshake-timeout'
  | 'denied'
  | 'closed'
  | 'startup-failed'
  | 'protocol';
