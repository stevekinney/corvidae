import {
  ClientEndpoint,
  describeFailure,
  type AttachmentTerms,
  type Capabilities,
  type FailureCode,
  type FailureReason,
  type OutputChannel,
  type ProtocolResult,
  type SentFrame,
  type ServerMessage,
} from '@lostgradient/ventriloquist';

import { OutputReleaseQueue } from './output-release.ts';
import { validateSocketUrl } from './socket-url.ts';
import type {
  BrowserSocket,
  CleanupResult,
  InputResult,
  OperationResult,
  OutputListener,
  ResizeResult,
  Schedule,
  TerminalConnectFailure,
  TerminalTransportEvent,
  TerminalTransportState,
  TerminalWebSocketClientOptions,
} from './transport-types.ts';

const SOCKET_OPEN = 1;
const NORMAL_CLOSURE = 1000;
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;
const DEFAULT_CONNECT_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_PENDING_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_PROBE_INITIAL_MILLISECONDS = 250;
const DEFAULT_PROBE_MAXIMUM_MILLISECONDS = 8_000;
const DEFAULT_STOP_TIMEOUT_MILLISECONDS = 10_000;
/** The longest a probe wait may be set to: one minute. */
const MAXIMUM_PROBE_MILLISECONDS = 60_000;

/** Why `connect()` did not produce capabilities. The state names the same thing for a view. */
export class TerminalConnectError extends Error {
  readonly reason: TerminalConnectFailure;
  readonly code: FailureCode | undefined;

  constructor(reason: TerminalConnectFailure, code?: FailureCode) {
    super(`the terminal connection failed: ${reason}`);
    this.name = 'TerminalConnectError';
    this.reason = reason;
    this.code = code;
  }
}

/**
 * How final each end state is. A later, weaker end never replaces an earlier, stronger one: a
 * quarantined cleanup outranks a failure, a failure or a denial outranks an exit, and an exit
 * outranks the socket merely closing afterwards.
 */
const END_RANK: Readonly<Partial<Record<TerminalTransportState, number>>> = {
  disconnected: 1,
  exited: 2,
  denied: 3,
  failed: 3,
  'cleanup-incomplete': 4,
};

const defaultSchedule: Schedule = (callback, delayMilliseconds) => {
  const handle = setTimeout(callback, delayMilliseconds);
  return () => clearTimeout(handle);
};

const defaultCreateSocket = (url: string): BrowserSocket => new WebSocket(url);

function refusal(code: FailureCode, reason: FailureReason): ProtocolResult<SentFrame> {
  return { ok: false, failure: { code, reason } };
}

/** The shape the terminal's input path takes, so this client can be handed to it as it is. */
export type TerminalInputPath = {
  input(data: Uint8Array): ProtocolResult<SentFrame>;
  readonly authorityRevoked: boolean;
  readonly terms: AttachmentTerms | undefined;
};

type Settle = (result: OperationResult) => void;

/**
 * The browser side of one attachment: a WebSocket joined to the protocol's `ClientEndpoint`. It is
 * single-use. It connects once, reports what the host says, and when the transport ends it stays
 * ended: there is no reconnect, no replay of input and no resume, and a restart is a new client for
 * a new session. The browser's own `WebSocket` is the transport; the engine's attach addon is not
 * used and nothing here depends on the engine.
 *
 * - State follows the wire (see `TerminalTransportState`). `backpressured` is entered when input is
 *   refused as `fifo-full`, locally because the operation window is full or by the host, and is left
 *   only when a later operation is acknowledged.
 * - Output reaches subscribers with a `parsed` callback, and only that callback acknowledges bytes,
 *   in order, as a count of bytes. Receipt, the socket's buffer or a paint never does.
 * - An operation is acknowledged on acceptance into the host's FIFO. A connection that ends before
 *   the host answers leaves it `unknown`, and it is never retried.
 */
export class TerminalWebSocketClient {
  readonly #url: string;
  readonly #endpoint: ClientEndpoint;
  readonly #createSocket: (url: string) => BrowserSocket;
  readonly #schedule: Schedule;
  readonly #connectTimeout: number;
  readonly #maximumPendingOutputBytes: number;
  readonly #probeInitial: number;
  readonly #probeMaximum: number;
  readonly #stopTimeout: number;
  readonly #release: OutputReleaseQueue;
  readonly #stateListeners = new Set<(state: TerminalTransportState) => void>();
  readonly #eventListeners = new Set<(event: TerminalTransportEvent) => void>();
  readonly #outputListeners = new Set<OutputListener>();
  readonly #pendingOperations = new Map<number, Settle>();
  readonly #pendingOutput: { readonly bytes: Uint8Array; readonly channel: OutputChannel }[] = [];
  readonly #stopWaiters: ((result: CleanupResult) => void)[] = [];
  readonly #unknownSequences: number[] = [];
  readonly #inputPath: TerminalInputPath;
  #pendingOutputBytes = 0;
  #state: TerminalTransportState = 'empty';
  #socket: BrowserSocket | undefined;
  #started = false;
  #ended = false;
  #failing = false;
  #socketClosed = false;
  #capabilities: Capabilities | undefined;
  #cleanup: CleanupResult | undefined;
  #connecting: { resolve(value: Capabilities): void; reject(error: Error): void } | undefined;
  #cancelConnectTimer: (() => void) | undefined;
  #cancelProbe: (() => void) | undefined;
  #cancelStopTimer: (() => void) | undefined;
  #probeDelay: number;
  readonly #probeSequences = new Set<number>();

  constructor(options: TerminalWebSocketClientOptions) {
    this.#url = validateSocketUrl(options.url, options.allowInsecureLoopback === true);
    this.#endpoint = new ClientEndpoint({
      sessionId: options.sessionId,
      requestedMode: options.requestedMode ?? 'interactive',
      token: options.ticket,
    });
    this.#createSocket = options.createSocket ?? defaultCreateSocket;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#connectTimeout =
      options.connectTimeoutMilliseconds ?? DEFAULT_CONNECT_TIMEOUT_MILLISECONDS;
    this.#maximumPendingOutputBytes =
      options.maximumPendingOutputBytes ?? DEFAULT_PENDING_OUTPUT_BYTES;
    this.#probeInitial = options.probeInitialMilliseconds ?? DEFAULT_PROBE_INITIAL_MILLISECONDS;
    this.#probeMaximum = options.probeMaximumMilliseconds ?? DEFAULT_PROBE_MAXIMUM_MILLISECONDS;
    // A zero or non-finite wait would double to itself and probe in a hot loop, so both are refused.
    for (const [name, value] of [
      ['probeInitialMilliseconds', this.#probeInitial],
      ['probeMaximumMilliseconds', this.#probeMaximum],
    ] as const) {
      if (!Number.isInteger(value) || value < 1 || value > MAXIMUM_PROBE_MILLISECONDS) {
        throw new RangeError(
          `${name} must be an integer from 1 to ${MAXIMUM_PROBE_MILLISECONDS}, got ${value}`,
        );
      }
    }
    if (this.#probeMaximum < this.#probeInitial) {
      throw new RangeError('probeMaximumMilliseconds must be at least probeInitialMilliseconds');
    }
    this.#stopTimeout = options.stopTimeoutMilliseconds ?? DEFAULT_STOP_TIMEOUT_MILLISECONDS;
    this.#probeDelay = this.#probeInitial;
    this.#release = new OutputReleaseQueue((bytes) => this.#acknowledgeOutput(bytes));
    const authorityRevoked = (): boolean => this.authorityRevoked;
    const terms = (): AttachmentTerms | undefined => this.terms;
    this.#inputPath = {
      input: (data) => this.#submit(() => this.#endpoint.input(data)),
      get authorityRevoked() {
        return authorityRevoked();
      },
      get terms() {
        return terms();
      },
    };
  }

  get state(): TerminalTransportState {
    return this.#state;
  }

  /** What the host granted, once it has. */
  get capabilities(): Capabilities | undefined {
    return this.#capabilities;
  }

  /** The negotiated frame and operation budgets, once the host's capabilities were accepted. */
  get terms(): AttachmentTerms | undefined {
    return this.#endpoint.terms;
  }

  /** The client may no longer send input: it asked to stop, the host revoked it, or the transport ended. */
  get authorityRevoked(): boolean {
    return this.#ended || this.#endpoint.authorityRevoked;
  }

  /** Operations whose fate is unknown because the transport ended before the host answered. */
  get deliveryUnknown(): readonly number[] {
    return [...this.#unknownSequences];
  }

  /**
   * Where input goes, in the shape the terminal's input path and renderer take. Its `input` offers
   * one operation and returns the protocol's own typed result, so a refusal keeps its code. It
   * throws when the transport fails after the frame was built, because delivery is then unknown.
   */
  get input(): TerminalInputPath {
    return this.#inputPath;
  }

  /** Listen to state changes. The returned function stops listening. */
  subscribeState(listener: (state: TerminalTransportState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /** Listen to everything the host reports. The returned function stops listening. */
  subscribe(listener: (event: TerminalTransportEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /**
   * Receive output in order, with a `parsed` callback per chunk. Output that arrived while nothing
   * listened is delivered first. The returned function unsubscribes; bytes a listener never reported
   * parsed stay unacknowledged.
   */
  subscribeOutput(listener: OutputListener): () => void {
    this.#outputListeners.add(listener);
    const held = this.#pendingOutput.splice(0);
    this.#pendingOutputBytes = 0;
    for (const chunk of held) this.#dispatch(chunk.bytes, chunk.channel);
    return () => this.#outputListeners.delete(listener);
  }

  /** The renderer failed and disposed its engine: stop, so the host revokes input and cleans up. */
  rendererFailed(_failure: unknown): void {
    void this.stop();
  }

  /** Open the socket and complete the handshake. Single-use: a second call is refused. */
  connect(): Promise<Capabilities> {
    if (this.#started || this.#ended) {
      return Promise.reject(new TerminalConnectError('already-used'));
    }
    this.#started = true;
    return new Promise((resolve, reject) => {
      this.#connecting = { resolve, reject };
      this.#setState('connecting');
      // A listener that threw on that change already failed the client and rejected this attempt.
      if (this.#ended) return;
      let socket: BrowserSocket;
      try {
        socket = this.#createSocket(this.#url);
      } catch {
        this.#abandonConnect('socket-unavailable');
        return;
      }
      this.#socket = socket;
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => this.#onOpen());
      socket.addEventListener('message', (event) => this.#onMessage(event.data));
      socket.addEventListener('error', () => this.#endTransport('error'));
      socket.addEventListener('close', (event) => this.#endTransport('closed', event.code));
      this.#cancelConnectTimer = this.#schedule(
        () => this.#abandonConnect('handshake-timeout'),
        this.#connectTimeout,
      );
    });
  }

  /** Send input and resolve when the host answers it: accepted, failed, or unknown if the transport ends first. */
  sendInput(data: Uint8Array | string): Promise<InputResult> {
    return this.#operation(() => this.#endpoint.input(data));
  }

  /** Send new terminal dimensions, which share the input sequence and the host's FIFO. */
  sendResize(columns: number, rows: number): Promise<ResizeResult> {
    return this.#operation(() => this.#endpoint.resize(columns, rows));
  }

  /**
   * Ask the host to stop. Authority is revoked here at once; the result is the host's own cleanup
   * report, or `unknown` when the transport ended without one.
   */
  stop(): Promise<CleanupResult> {
    if (this.#cleanup !== undefined) return Promise.resolve(this.#cleanup);
    if (!this.#started) return Promise.resolve({ outcome: 'complete', source: 'local' });
    if (this.#ended) return Promise.resolve({ outcome: 'unknown', source: 'local' });
    const sent = this.#endpoint.terminate();
    if (!sent.ok) {
      // Stopping before the handshake finished: there is no attachment to ask, so leave.
      this.close();
      return Promise.resolve({ outcome: 'unknown', source: 'local' });
    }
    return new Promise((resolve) => {
      this.#stopWaiters.push(resolve);
      // A host that never answers must not leave the caller waiting: the deadline concludes it.
      this.#cancelStopTimer = this.#schedule(() => this.close(), this.#stopTimeout);
      this.#transmit(sent.value.frame);
    });
  }

  /** Close the socket from this side. The host sees a disconnect and cleans up; nothing reconnects. */
  close(): void {
    this.#closeSocket(NORMAL_CLOSURE);
    this.#endTransport('local');
  }

  #operation(build: () => ProtocolResult<SentFrame>): Promise<OperationResult> {
    return new Promise((resolve) => {
      try {
        const result = this.#submit(build, resolve);
        if (!result.ok) {
          resolve({ status: 'refused', code: result.failure.code, reason: result.failure.reason });
        }
      } catch {
        // The transport failed after the frame was built; the pending operation is already `unknown`.
      }
    });
  }

  /**
   * Build and send one operation, or refuse it without sending. While backpressured nothing is
   * sent: the window was full, and a later keystroke could change what a refused one meant. A send
   * that throws leaves the operation's fate unknown and the transport ended, and rethrows.
   */
  #submit(build: () => ProtocolResult<SentFrame>, settle?: Settle): ProtocolResult<SentFrame> {
    if (!this.#canSubmit()) return refusal('stale-generation', 'attachment-revoked');
    if (this.#state === 'backpressured') return refusal('fifo-full', 'operation-window-full');
    const built = build();
    if (!built.ok) {
      if (built.failure.code === 'fifo-full') this.#setState('backpressured');
      return built;
    }
    this.#pendingOperations.set(built.value.sequence, settle ?? (() => undefined));
    if (!this.#transmit(built.value.frame)) {
      throw new Error('the transport failed after the frame was built, so delivery is unknown');
    }
    return built;
  }

  #canSubmit(): boolean {
    return (
      !this.#ended &&
      this.#socket?.readyState === SOCKET_OPEN &&
      this.#endpoint.phase === 'attached'
    );
  }

  #transmit(frame: string | Uint8Array): boolean {
    try {
      // A binary frame is copied onto a buffer of its own, which is the type a socket takes.
      this.#socket?.send(typeof frame === 'string' ? frame : new Uint8Array(frame));
      return true;
    } catch {
      this.#endTransport('send-failed');
      return false;
    }
  }

  #onOpen(): void {
    const hello = this.#endpoint.hello();
    if (!hello.ok) {
      this.#failClosed(hello.failure.code);
      return;
    }
    this.#transmit(hello.value);
  }

  #onMessage(data: unknown): void {
    if (this.#ended) return;
    let frame: string | Uint8Array;
    if (typeof data === 'string') frame = data;
    else if (data instanceof ArrayBuffer) frame = new Uint8Array(data);
    else {
      this.#failClosed('malformed-frame');
      return;
    }
    const received = this.#endpoint.receive(frame);
    if (received.ok) {
      this.#handle(received.value);
      return;
    }
    // A frame for another session or generation proves nothing about this attachment and is ignored;
    // anything else the endpoint refused means the conversation can no longer be trusted.
    if (received.failure.code !== 'stale-generation') this.#failClosed(received.failure.code);
  }

  #handle(message: ServerMessage): void {
    switch (message.kind) {
      case 'capabilities':
        this.#onCapabilities(message.capabilities);
        break;
      case 'output':
        this.#onOutput(message.payload, message.channel);
        break;
      case 'operation-ack':
        this.#onAcknowledgement(message.operationSequence);
        break;
      case 'operation-failure':
        this.#onOperationFailure(message.operationSequence, message.code, message.message);
        break;
      case 'process-exit':
        this.#end('exited');
        this.#emit({ type: 'process-exit', exitCode: message.exitCode, signal: message.signal });
        break;
      case 'attachment-error':
        this.#onAttachmentError(message.code, message.message);
        break;
      case 'cleanup-result':
        this.#onCleanupResult(message.outcome);
        break;
    }
  }

  #onCapabilities(capabilities: Capabilities): void {
    this.#capabilities = capabilities;
    this.#cancelConnectTimer?.();
    this.#setState(capabilities.readOnly ? 'read-only' : 'writable');
    this.#emit({ type: 'capabilities', capabilities });
    const connecting = this.#connecting;
    this.#connecting = undefined;
    connecting?.resolve(capabilities);
  }

  #onAcknowledgement(sequence: number): void {
    const wasProbe = this.#probeSequences.has(sequence);
    this.#settle(sequence, { status: 'accepted', sequence });
    // The wait starts over only when something a user sent was accepted. A probe being accepted can
    // be followed at once by a refusal of real input, and that flapping must keep backing off.
    if (!wasProbe) this.#probeDelay = this.#probeInitial;
    // An acknowledgement is the only thing that frees the window, so it is the only way back.
    if (this.#state === 'backpressured') this.#setState('writable');
    // A probe carries no user bytes, so nothing a view shows is about it.
    if (!wasProbe) this.#emit({ type: 'operation-ack', sequence });
  }

  #onOperationFailure(sequence: number, code: FailureCode, message: string): void {
    const wasProbe = this.#probeSequences.has(sequence);
    this.#settle(sequence, { status: 'failed', sequence, code });
    if (code === 'fifo-full' && this.#state === 'writable') this.#setState('backpressured');
    // The host revoked the generation: the failure is the terminal status, never an exit.
    if (code === 'backend-failed' || code === 'transport-failed') this.#end('failed');
    if (!wasProbe) this.#emit({ type: 'operation-failure', sequence, code, message });
  }

  #onAttachmentError(code: FailureCode, message: string): void {
    this.#end('failed');
    this.#emit({ type: 'attachment-error', code, message });
    this.#rejectConnect(new TerminalConnectError('startup-failed', code));
  }

  #onCleanupResult(outcome: 'complete' | 'incomplete' | 'unknown'): void {
    this.#cleanup = { outcome, source: 'host' };
    this.#cancelStopTimer?.();
    // Incomplete and unknown cleanup quarantine the slot; a complete one just means the attachment ended.
    this.#end(outcome === 'complete' ? 'disconnected' : 'cleanup-incomplete');
    for (const waiter of this.#stopWaiters.splice(0)) waiter(this.#cleanup);
    this.#emit({ type: 'cleanup-result', outcome });
  }

  /**
   * Output is delivered in order. With nothing listening it is held, bounded by the host's own
   * output budget: past that the conversation has diverged from what the host believes was sent.
   */
  #onOutput(bytes: Uint8Array, channel: OutputChannel): void {
    // An empty chunk carries nothing to count or to parse.
    if (bytes.length === 0) return;
    if (this.#outputListeners.size > 0) {
      this.#dispatch(bytes, channel);
      return;
    }
    this.#pendingOutputBytes += bytes.length;
    if (this.#pendingOutputBytes > this.#maximumPendingOutputBytes) {
      this.#failClosed('transport-failed');
      return;
    }
    this.#pendingOutput.push({ bytes, channel });
  }

  #dispatch(bytes: Uint8Array, channel: OutputChannel): void {
    const listeners = [...this.#outputListeners];
    const parsedOnce = this.#release.register(bytes.length, listeners.length);
    for (const listener of listeners) {
      let reported = false;
      const parsed = (): void => {
        if (reported) return;
        reported = true;
        parsedOnce();
      };
      try {
        listener(bytes, parsed, channel);
      } catch {
        this.#fail('callback-failed');
        return;
      }
    }
  }

  /** Report `bytes` more output bytes parsed. Only a parse report reaches here. */
  #acknowledgeOutput(bytes: number): void {
    if (this.#ended || this.#endpoint.phase !== 'attached') return;
    const sent = this.#endpoint.consumeOutput(bytes);
    if (!sent.ok) {
      this.#failClosed(sent.failure.code);
      return;
    }
    this.#transmit(sent.value.frame);
  }

  /**
   * The host sends nothing when its queue drains, so after a refusal with nothing in flight no
   * acknowledgement would ever arrive to lift the pause. The client asks instead: an empty input is
   * a capacity probe, accepted into the host's FIFO exactly when there is room, and carrying no
   * byte for the process. It is sent on a backoff that doubles from the first delay to a cap, only
   * while paused and idle, and its acknowledgement returns the state to `writable`. A refusal keeps
   * the pause and waits longer. Nothing a user typed is ever sent by a probe.
   */
  #armProbe(): void {
    this.#cancelProbe = this.#schedule(() => this.#probe(), this.#probeDelay);
  }

  #stopProbing(): void {
    this.#cancelProbe?.();
    this.#cancelProbe = undefined;
  }

  #probe(): void {
    if (this.#ended || this.#state !== 'backpressured') return;
    // Operations in flight will be answered, and an acknowledgement is what ends the pause.
    if (this.#pendingOperations.size > 0) {
      this.#armProbe();
      return;
    }
    const built = this.#endpoint.input(new Uint8Array(0));
    if (!built.ok) {
      // Only a stopped client cannot send, and then there is nothing left to wait for.
      if (built.failure.code === 'fifo-full') this.#backOff();
      return;
    }
    this.#probeSequences.add(built.value.sequence);
    this.#pendingOperations.set(built.value.sequence, (result) => {
      this.#probeSequences.delete(built.value.sequence);
      if (result.status === 'failed') this.#backOff();
    });
    this.#transmit(built.value.frame);
  }

  #backOff(): void {
    if (this.#state !== 'backpressured') return;
    this.#probeDelay = Math.min(this.#probeDelay * 2, this.#probeMaximum);
    this.#armProbe();
  }

  #settle(sequence: number, result: OperationResult): void {
    const settle = this.#pendingOperations.get(sequence);
    this.#pendingOperations.delete(sequence);
    settle?.(result);
  }

  /** Move to an end state, unless a stronger one was already reached. */
  #end(next: TerminalTransportState): void {
    const current = END_RANK[this.#state] ?? 0;
    if (current < (END_RANK[next] ?? 0)) this.#setState(next);
  }

  #setState(next: TerminalTransportState): void {
    if (next === this.#state) return;
    const previous = this.#state;
    this.#state = next;
    if (next === 'backpressured') this.#armProbe();
    else if (previous === 'backpressured') this.#stopProbing();
    for (const listener of this.#stateListeners) this.#guard(() => listener(next));
    this.#emit({ type: 'state', state: next, previous });
  }

  #emit(event: TerminalTransportEvent): void {
    for (const listener of this.#eventListeners) this.#guard(() => listener(event));
  }

  /** A listener that throws revokes the attachment and ends the transport, as any callback does. */
  #guard(callback: () => void): void {
    try {
      callback();
    } catch {
      this.#fail('callback-failed');
    }
  }

  /** The transport ended. Idempotent; the first cause stands. */
  #endTransport(cause: 'closed' | 'error' | 'send-failed' | 'local', closeCode?: number): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#cancelProbe?.();
    this.#cancelStopTimer?.();
    // The peer closed it already: there is nothing to close from this side.
    if (cause === 'closed') this.#socketClosed = true;
    // A client that never connected has no attachment to end and nothing to report.
    if (!this.#started) return;
    this.#cancelConnectTimer?.();
    const wasConnecting = this.#connecting !== undefined;
    const alreadyEnded = END_RANK[this.#state] !== undefined;
    if (wasConnecting) {
      this.#end(closeCode === POLICY_VIOLATION ? 'denied' : 'failed');
    } else {
      this.#end('disconnected');
    }
    const pending = [...this.#pendingOperations.keys()];
    const unknown = pending.filter((sequence) => !this.#probeSequences.has(sequence));
    for (const sequence of pending) this.#settle(sequence, { status: 'unknown', sequence });
    this.#probeSequences.clear();
    this.#unknownSequences.push(...unknown);
    for (const waiter of this.#stopWaiters.splice(0))
      waiter({ outcome: 'unknown', source: 'local' });
    this.#closeSocket(NORMAL_CLOSURE);
    this.#rejectConnect(
      new TerminalConnectError(closeCode === POLICY_VIOLATION ? 'denied' : 'closed'),
    );
    // Losing the transport is worth reporting only when it changed what the view should say: after
    // an exit, a failure or a cleanup report the socket closing is the expected end.
    if (cause !== 'local' && !alreadyEnded) {
      this.#emit({
        type: 'transport-error',
        cause,
        ...(closeCode === undefined ? {} : { closeCode }),
      });
    }
    if (unknown.length > 0) this.#emit({ type: 'delivery-unknown', sequences: unknown });
  }

  /** The conversation broke: close with the failure's code and end in `failed`. */
  #failClosed(code: FailureCode): void {
    if (this.#failing || this.#ended) return;
    this.#failing = true;
    this.#end('failed');
    this.#closeSocket(describeFailure(code).closeCode);
    this.#rejectConnect(new TerminalConnectError('protocol', code));
    this.#endTransport('local');
    this.#emit({ type: 'transport-error', cause: 'protocol', failure: code });
  }

  /** A callback threw: revoke the attachment by closing, which makes the host clean up. */
  #fail(cause: 'callback-failed'): void {
    if (this.#failing || this.#ended) return;
    this.#failing = true;
    this.#end('failed');
    this.#closeSocket(INTERNAL_ERROR);
    this.#rejectConnect(new TerminalConnectError('protocol'));
    this.#endTransport('local');
    this.#emit({ type: 'transport-error', cause });
  }

  #abandonConnect(reason: TerminalConnectFailure): void {
    if (this.#connecting === undefined) return;
    this.#end('failed');
    this.#rejectConnect(new TerminalConnectError(reason));
    this.#endTransport('local');
  }

  #rejectConnect(error: Error): void {
    const connecting = this.#connecting;
    this.#connecting = undefined;
    connecting?.reject(error);
  }

  #closeSocket(code: number): void {
    // The first close wins, so a failure's own code is not replaced by the ordinary one after it.
    if (this.#socketClosed) return;
    this.#socketClosed = true;
    try {
      this.#socket?.close(code);
    } catch {
      // The socket is already gone; there is nothing left to close.
    }
  }
}
