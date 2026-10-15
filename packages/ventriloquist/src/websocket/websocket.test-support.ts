import type { HostedProcess } from '../bun/process-types.ts';
import { ClientEndpoint } from '../protocol/client-endpoint.ts';
import type { SentFrame } from '../protocol/endpoint-support.ts';
import { encodeFrame } from '../protocol/frame-codec.ts';
import type {
  CapabilitiesMessage,
  CleanupOutcome,
  ProtocolMessage,
  RequestedMode,
  ServerMessage,
} from '../protocol/messages.ts';
import type { ProtocolResult } from '../protocol/protocol-failure.ts';
import { createDeferred, type Deferred } from '../session/fixtures/deferred.ts';
import { ManualClock } from '../session/fixtures/manual-clock.ts';
import { createScriptedBackend } from '../session/fixtures/scripted-backend.ts';
import { createScriptedStream, type ScriptedStream } from '../session/fixtures/scripted-sources.ts';
import { SessionSlot } from '../session/session-slot.ts';
import type { ProcessBackend } from '../session/session-types.ts';
import type { Session } from '../session/session.ts';
import { createTerminalWebSocketServer, type TerminalWebSocketServer } from './websocket-server.ts';
import type {
  Authentication,
  Authorization,
  AuthorizationRequest,
  LaunchSnapshot,
  SocketData,
  TerminalWebSocketServerOptions,
} from './websocket-types.ts';

export const ORIGIN = 'https://terminal.example';
export const SESSION_COOKIE = 'sid=valid';
export const SESSION_IDENTIFIER = '0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10';
export const SECOND_SESSION_IDENTIFIER = '6d9d9a52-3a1e-4f67-8f7b-0c0f2f0c5e11';
export const TICKET = 'host-ticket';

export const LAUNCH: LaunchSnapshot = {
  mode: 'pty',
  profile: {
    executable: '/bin/sh',
    argumentList: [],
    workingDirectory: '/',
    environment: { PATH: '/usr/bin:/bin' },
  },
  dimensions: { columns: 80, rows: 24 },
};

/** A process a test scripts: its writes are recorded, its output is pushed, its exit is released by hand. */
export type ScriptedProcess = {
  readonly hosted: HostedProcess;
  readonly backend: ProcessBackend;
  readonly stream: ScriptedStream;
  readonly written: Uint8Array[];
  readonly resized: { columns: number; rows: number }[];
  readonly cleanups: number;
  /** Resolves once `count` writes have reached the backend. */
  writes(count: number): Promise<void>;
  /** Resolves once `count` resizes have reached the backend. */
  resizes(count: number): Promise<void>;
  /** Hold every later write and resize until `releaseWrites` is called. */
  stallWrites(): void;
  releaseWrites(): void;
  exit(code: number | null, signal?: string | null): void;
};

export type ScriptedProcessOptions = {
  readonly cleanup?: CleanupOutcome;
  /** Make `start` reject with this failure code, as a refused spawn does. */
  readonly startFailure?: 'spawn-failed' | 'unsupported-runtime';
  readonly mode?: 'pty' | 'pipe';
};

export function scriptedProcess(options: ScriptedProcessOptions = {}): ScriptedProcess {
  const written: Uint8Array[] = [];
  const resized: { columns: number; rows: number }[] = [];
  const stream = createScriptedStream(options.mode === 'pipe' ? 'stdout' : 'pty');
  const writeWaiters: { count: number; deferred: Deferred<void> }[] = [];
  const resizeWaiters: { count: number; deferred: Deferred<void> }[] = [];
  const exitSignal = createDeferred<{ code: number | null; signal: string | null }>();
  let cleanups = 0;
  let stalled: Deferred<void> | undefined;
  const settle = (waiters: typeof writeWaiters, length: number): void => {
    for (const waiter of waiters.splice(0)) {
      if (length >= waiter.count) waiter.deferred.resolve();
      else waiters.push(waiter);
    }
  };
  const backend = createScriptedBackend({
    mode: options.mode ?? 'pty',
    start: () =>
      options.startFailure === undefined
        ? Promise.resolve()
        : Promise.reject(Object.assign(new Error('start failed'), { code: options.startFailure })),
    write: async (bytes) => {
      written.push(bytes);
      settle(writeWaiters, written.length);
      await stalled?.promise;
    },
    resize: async (columns, rows) => {
      resized.push({ columns, rows });
      settle(resizeWaiters, resized.length);
      await stalled?.promise;
    },
    cleanup: () => {
      cleanups += 1;
      return Promise.resolve(options.cleanup ?? 'complete');
    },
  });
  const hosted: HostedProcess = {
    mode: options.mode ?? 'pty',
    backend,
    sources: [stream.source],
    startFailure: undefined,
    async reportExitTo(receiver) {
      await receiver.start();
      const exit = await exitSignal.promise;
      receiver.reportProcessExit(exit.code, exit.signal);
    },
  };
  const waitFor = (waiters: typeof writeWaiters, length: number, count: number): Promise<void> => {
    if (length >= count) return Promise.resolve();
    const deferred = createDeferred<void>();
    waiters.push({ count, deferred });
    return deferred.promise;
  };
  return {
    hosted,
    backend,
    stream,
    written,
    resized,
    get cleanups() {
      return cleanups;
    },
    writes: (count) => waitFor(writeWaiters, written.length, count),
    resizes: (count) => waitFor(resizeWaiters, resized.length, count),
    stallWrites: () => {
      stalled = createDeferred<void>();
    },
    releaseWrites: () => {
      stalled?.resolve();
      stalled = undefined;
    },
    exit: (code, signal = null) => exitSignal.resolve({ code, signal }),
  };
}

export type HarnessOptions = {
  readonly authentication?: (request: Request) => Authentication | Promise<Authentication>;
  readonly authorization?: Authorization | (() => Authorization | Promise<Authorization>);
  readonly process?: ScriptedProcess;
  readonly createProcess?: TerminalWebSocketServerOptions['createProcess'];
  readonly server?: Partial<TerminalWebSocketServerOptions>;
  readonly hostname?: string;
  readonly allowInsecureLoopback?: boolean;
};

export type Harness = {
  readonly terminal: TerminalWebSocketServer;
  readonly server: Bun.Server<SocketData>;
  readonly clock: ManualClock;
  readonly process: ScriptedProcess;
  readonly slot: SessionSlot;
  readonly url: string;
  readonly authorizations: AuthorizationRequest[];
  /** Resolves once `count` pongs have reached the server. */
  pongsReceived(count: number): Promise<void>;
  /** The close code the server's transport reported for each socket that closed, in order. */
  readonly closeCodes: number[];
  /** Resolves once the server has finished handling `count` socket closes. */
  closesHandled(count: number): Promise<void>;
  /** The session the harness's slot holds, once a client has attached. */
  session(): Session;
  stop(): Promise<void>;
};

export const DEFAULT_LIFETIME_MILLISECONDS = 3_600_000;

/**
 * A real `Bun.serve` loopback listener over a scripted process, with a cookie-checking host. The
 * listener is built here, not by `serveTerminalWebSocket`, so a test can watch the pongs the
 * transport receives and read the session out of the slot it shares.
 */
export function startHarness(options: HarnessOptions = {}): Harness {
  const clock = new ManualClock();
  const process = options.process ?? scriptedProcess();
  const slot = new SessionSlot();
  const authorizations: AuthorizationRequest[] = [];
  const pongWaiters: { count: number; deferred: Deferred<void> }[] = [];
  const closeWaiters: { count: number; deferred: Deferred<void> }[] = [];
  const closeCodes: number[] = [];
  let pongs = 0;
  let closes = 0;
  const terminal = createTerminalWebSocketServer({
    host: {
      authenticate:
        options.authentication ??
        ((request) =>
          request.headers.get('cookie') === SESSION_COOKIE
            ? { ok: true, subject: 'user-1', expiresInMilliseconds: DEFAULT_LIFETIME_MILLISECONDS }
            : { ok: false, denial: 'unauthenticated' }),
      authorize: (request) => {
        authorizations.push(request);
        const decided =
          options.authorization ??
          ({ allowed: true, grant: 'interactive', launch: LAUNCH } as const);
        return typeof decided === 'function' ? decided() : decided;
      },
    },
    createProcess: options.createProcess ?? (() => process.hosted),
    allowedOrigins: [ORIGIN],
    allowInsecureLoopback: options.allowInsecureLoopback ?? true,
    slotFor: () => slot,
    clock,
    ...options.server,
  });
  const server = Bun.serve<SocketData>({
    port: 0,
    hostname: options.hostname ?? '127.0.0.1',
    fetch: (request, listener) => terminal.handleUpgrade(request, listener),
    websocket: {
      ...terminal.websocket,
      close: async (socket, code, reason) => {
        await terminal.websocket.close(socket, code, reason);
        closeCodes.push(code);
        closes += 1;
        for (const waiter of closeWaiters.splice(0)) {
          if (closes >= waiter.count) waiter.deferred.resolve();
          else closeWaiters.push(waiter);
        }
      },
      pong: (socket) => {
        terminal.websocket.pong(socket);
        pongs += 1;
        for (const waiter of pongWaiters.splice(0)) {
          if (pongs >= waiter.count) waiter.deferred.resolve();
          else pongWaiters.push(waiter);
        }
      },
    },
  });
  return {
    terminal,
    server,
    clock,
    process,
    slot,
    authorizations,
    closeCodes,
    url: `ws://127.0.0.1:${server.port}/terminal?profile=shell`,
    pongsReceived: (count) => {
      if (pongs >= count) return Promise.resolve();
      const deferred = createDeferred<void>();
      pongWaiters.push({ count, deferred });
      return deferred.promise;
    },
    closesHandled: (count) => {
      if (closes >= count) return Promise.resolve();
      const deferred = createDeferred<void>();
      closeWaiters.push({ count, deferred });
      return deferred.promise;
    },
    session: () => slot.current as Session,
    async stop() {
      await terminal.close();
      await server.stop(true);
    },
  };
}

export type ClientFrame = { readonly raw: string | Uint8Array; readonly message?: ServerMessage };

export type ConnectOptions = {
  readonly origin?: string | null;
  readonly cookie?: string | null;
  readonly query?: string;
  readonly sessionId?: string;
  readonly mode?: RequestedMode;
  readonly url?: string;
  /** Extra request headers, for a test that plays a proxy. */
  readonly headers?: Record<string, string>;
};

/** A raw WebSocket client that decodes with the real `ClientEndpoint`, and can send anything. */
export class TestClient {
  readonly socket: WebSocket;
  readonly endpoint: ClientEndpoint;
  readonly frames: ClientFrame[] = [];
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; clean: boolean }>;
  readonly opened: Promise<void>;
  #listeners: (() => void)[] = [];

  constructor(harnessUrl: string, options: ConnectOptions = {}) {
    const headers: Record<string, string> = {};
    if (options.origin !== null) headers['Origin'] = options.origin ?? ORIGIN;
    if (options.cookie !== null) headers['Cookie'] = options.cookie ?? SESSION_COOKIE;
    Object.assign(headers, options.headers);
    const url = options.url ?? harnessUrl + (options.query ?? '');
    this.socket = new WebSocket(url, { headers } as never);
    this.socket.binaryType = 'arraybuffer';
    this.endpoint = new ClientEndpoint({
      sessionId: options.sessionId ?? SESSION_IDENTIFIER,
      requestedMode: options.mode ?? 'interactive',
      token: TICKET,
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve());
      this.socket.addEventListener('error', () => reject(new Error('the upgrade was refused')));
    });
    this.opened.catch(() => undefined);
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener('close', (event) =>
        resolve({ code: event.code, clean: event.wasClean }),
      );
    });
    this.socket.addEventListener('message', (event) => {
      const raw: string | Uint8Array =
        typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer);
      const result = this.endpoint.receive(raw);
      this.frames.push(result.ok ? { raw, message: result.value } : { raw });
      if (result.ok) this.messages.push(result.value);
      for (const listener of this.#listeners.splice(0)) listener();
    });
  }

  /** Whether the upgrade was refused: the socket errors and closes without ever opening. */
  refused(): Promise<boolean> {
    return this.opened.then(
      () => false,
      () => true,
    );
  }

  /** Move the endpoint to awaiting capabilities without sending, for a test that forges its own hello. */
  expectCapabilities(): void {
    this.endpoint.hello();
  }

  /** Send the hello the endpoint builds. */
  hello(): void {
    this.sendResult(this.endpoint.hello());
  }

  /** Send a frame built by the endpoint. */
  sendResult(result: ProtocolResult<string | SentFrame>): void {
    if (!result.ok)
      throw new Error(`the endpoint refused to build the frame: ${result.failure.reason}`);
    const value = result.value;
    this.send(typeof value === 'string' ? value : value.frame);
  }

  send(raw: string | Uint8Array): void {
    this.socket.send(typeof raw === 'string' ? raw : new Uint8Array(raw));
  }

  /** Resolves with the first message (past `from`) that satisfies the predicate. */
  async waitFor<Message extends ServerMessage = ServerMessage>(
    predicate: (message: ServerMessage) => boolean,
    from = 0,
  ): Promise<Message> {
    for (;;) {
      const found = this.messages.slice(from).find(predicate);
      if (found !== undefined) return found as Message;
      await new Promise<void>((resolve) => {
        this.#listeners.push(resolve);
      });
    }
  }

  async waitForKind<Kind extends ServerMessage['kind']>(
    kind: Kind,
    from = 0,
  ): Promise<Extract<ServerMessage, { kind: Kind }>> {
    return this.waitFor<Extract<ServerMessage, { kind: Kind }>>(
      (message) => message.kind === kind,
      from,
    );
  }

  /** Resolves once at least `count` frames, decoded or not, have arrived. */
  async waitForFrames(count: number): Promise<void> {
    while (this.frames.length < count) {
      await new Promise<void>((resolve) => {
        this.#listeners.push(resolve);
      });
    }
  }

  /** Open, send the hello and wait for the capabilities. */
  async handshake(): Promise<CapabilitiesMessage> {
    await this.opened;
    this.hello();
    return this.waitForKind('capabilities');
  }

  /** The text of every output frame received so far, decoded as UTF-8. */
  outputText(): string {
    const decoder = new TextDecoder();
    return this.messages
      .flatMap((message) => (message.kind === 'output' ? [decoder.decode(message.payload)] : []))
      .join('');
  }

  /** Resolves once the output received so far contains `needle`. */
  async waitForOutput(needle: string | RegExp): Promise<string> {
    for (;;) {
      const text = this.outputText();
      if (typeof needle === 'string' ? text.includes(needle) : needle.test(text)) return text;
      await this.waitForFrames(this.frames.length + 1);
    }
  }

  kinds(): string[] {
    return this.messages.map((message) => message.kind);
  }
}

/**
 * A control frame built by the real encoder and then altered, so the only difference from a valid
 * frame is the patch. A hand-written envelope would be refused for lacking `version` and
 * `direction`, which would let a test pass for the wrong reason. A patch value of `undefined`
 * removes the field.
 */
export function forgeText(message: ProtocolMessage, patch: Record<string, unknown> = {}): string {
  const encoded = encodeFrame(message);
  if (!encoded.ok || typeof encoded.value !== 'string') {
    throw new Error('the message does not encode as a control frame');
  }
  return JSON.stringify({ ...(JSON.parse(encoded.value) as object), ...patch });
}

/** An input frame with any generation, session and sequence. */
export function forgeInput(
  generation: number,
  sequence: number,
  text = 'x',
  sessionId = SESSION_IDENTIFIER,
): Uint8Array {
  const frame = encodeFrame({
    kind: 'input',
    sessionId,
    attachmentGeneration: generation,
    sequence,
    payload: new TextEncoder().encode(text),
  });
  if (!frame.ok || typeof frame.value === 'string') throw new Error('could not forge the frame');
  return frame.value;
}

export function connect(harness: Harness, options: ConnectOptions = {}): TestClient {
  return new TestClient(harness.url, options);
}
