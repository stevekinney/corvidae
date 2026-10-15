import { readdirSync } from 'node:fs';

import { trackHostedProcess } from '../bun/bun-process.test-support.ts';
import type { HostedProcess, ProcessExitReceiver, ProcessProfile } from '../bun/process-types.ts';
import { ClientEndpoint } from '../protocol/client-endpoint.ts';
import type { SentFrame } from '../protocol/endpoint-support.ts';
import type { CapabilitiesMessage, RequestedMode, ServerMessage } from '../protocol/messages.ts';
import type { ProtocolResult } from '../protocol/protocol-failure.ts';
import { createDeferred } from '../session/fixtures/deferred.ts';
import { createFixtureTransport } from '../session/fixtures/fixture-transport.ts';
import { ManualClock } from '../session/fixtures/manual-clock.ts';
import type { AttachmentGrant, OutputSource, SessionBudgets } from '../session/session-types.ts';
import { Session } from '../session/session.ts';
import {
  SESSION_IDENTIFIER,
  TestClient,
  connect,
  startHarness,
  type ClientFrame,
  type Harness,
} from '../websocket/websocket.test-support.ts';

/** The path a client's bytes take to the session core. */
export type TransportPath = 'direct' | 'websocket';
export type ProcessMode = 'pipe' | 'pty';

/**
 * What a cell is labelled with. `scripted` is a cell whose backend is a script, not a process: its
 * ordering races are settled by barriers and a fake clock. It says nothing about pipes or PTYs,
 * and the real-process requirement is met by the `pipe` and `pty` cells, never by these.
 */
export type CellMode = ProcessMode | 'scripted';

export const TRANSPORT_PATHS: readonly TransportPath[] = ['direct', 'websocket'];
export const PROCESS_MODES: readonly ProcessMode[] = ['pipe', 'pty'];

/** The WebSocket host's default ping interval, which is also how often the in-memory path proves the peer alive. */
const PING_INTERVAL_MILLISECONDS = 10_000;

/** The approved host cell this run belongs to, named the way `process.platform` and `process.arch` name it. */
export const HOST_CELL = `${process.platform}-${process.arch}`;

export type Check = { readonly label: string; readonly ok: boolean };
export const check = (label: string, ok: boolean): Check => ({ label, ok });

/**
 * What a client does, whichever way its frames reach the session. `TestClient` is the real-socket
 * implementation; `DirectClient` below is the in-memory one. A case written against this surface
 * runs unchanged on both.
 */
export type ConformanceClient = Pick<
  TestClient,
  | 'endpoint'
  | 'frames'
  | 'messages'
  | 'kinds'
  | 'outputText'
  | 'waitFor'
  | 'waitForKind'
  | 'waitForOutput'
  | 'waitForFrames'
  | 'sendResult'
  | 'send'
  | 'handshake'
>;

/** The client half of the in-memory path: a real `ClientEndpoint` joined to a session by `SessionConnection`. */
class DirectClient implements ConformanceClient {
  readonly messages: ServerMessage[] = [];
  readonly frames: ClientFrame[] = [];
  readonly #transport: ReturnType<typeof createFixtureTransport>;
  readonly #afterDelivery: () => void;
  readonly #afterHello: () => void;
  #listeners: (() => void)[] = [];

  constructor(
    transport: ReturnType<typeof createFixtureTransport>,
    hooks: { readonly afterDelivery: () => void; readonly afterHello: () => void },
  ) {
    this.#transport = transport;
    this.#afterDelivery = hooks.afterDelivery;
    this.#afterHello = hooks.afterHello;
  }

  get endpoint(): ClientEndpoint {
    return this.#transport.client;
  }

  /** Move what the host has put on the wire to the client, as a socket's message event would. */
  deliver(): void {
    const arrived = this.#transport.outbox.splice(0);
    if (arrived.length === 0) return;
    for (const raw of arrived) {
      const result = this.endpoint.receive(raw);
      this.frames.push(result.ok ? { raw, message: result.value } : { raw });
      if (result.ok) this.messages.push(result.value);
    }
    this.#afterDelivery();
    for (const listener of this.#listeners.splice(0)) listener();
  }

  sendResult(result: ProtocolResult<string | SentFrame>): void {
    if (!result.ok)
      throw new Error(`the endpoint refused to build the frame: ${result.failure.reason}`);
    this.send(typeof result.value === 'string' ? result.value : result.value.frame);
  }

  send(raw: string | Uint8Array): void {
    this.#transport.connection.receive(raw);
  }

  async handshake(): Promise<CapabilitiesMessage> {
    this.sendResult(this.endpoint.hello());
    this.#afterHello();
    return this.waitForKind('capabilities');
  }

  kinds(): string[] {
    return this.messages.map((message) => message.kind);
  }

  outputText(): string {
    const decoder = new TextDecoder();
    return this.messages
      .flatMap((message) => (message.kind === 'output' ? [decoder.decode(message.payload)] : []))
      .join('');
  }

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

  async waitForFrames(count: number): Promise<void> {
    while (this.frames.length < count) {
      await new Promise<void>((resolve) => {
        this.#listeners.push(resolve);
      });
    }
  }

  async waitForOutput(needle: string | RegExp): Promise<string> {
    for (;;) {
      const text = this.outputText();
      if (typeof needle === 'string' ? text.includes(needle) : needle.test(text)) return text;
      await this.waitForFrames(this.frames.length + 1);
    }
  }
}

/** A hosted process whose backend start and exit report the rig can observe without polling. */
export type ObservedProcess = {
  readonly hosted: HostedProcess;
  /** Resolves when the exit was recorded by the session. */
  readonly exitRecorded: Promise<void>;
  /** Resolves when the session asked the backend to start. */
  readonly started: Promise<void>;
  /** Resolves once every stream the process owns has reached end of file. */
  readonly streamsEnded: Promise<void>;
};

/** Wrap `hosted` so the moment the session records its exit or starts it can be awaited. */
export function observeProcess(hosted: HostedProcess): ObservedProcess {
  const exitRecorded = createDeferred<void>();
  const started = createDeferred<void>();
  const streamsEnded = createDeferred<void>();
  let streamsRemaining = hosted.sources.filter((source) => source.kind === 'stream').length;
  if (streamsRemaining === 0) streamsEnded.resolve();
  const sources = hosted.sources.map((source): OutputSource => {
    if (source.kind !== 'stream') return source;
    return {
      ...source,
      stream: {
        getReader: () => {
          const reader = source.stream.getReader();
          return {
            read: async () => {
              const result = await reader.read();
              if (result.done) {
                streamsRemaining -= 1;
                if (streamsRemaining === 0) streamsEnded.resolve();
              }
              return result;
            },
            releaseLock: () => reader.releaseLock(),
            ...(reader.cancel === undefined
              ? {}
              : {
                  cancel: (reason?: unknown) =>
                    (reader.cancel as (reason?: unknown) => Promise<void>)(reason),
                }),
          };
        },
      },
    };
  });
  const backend: HostedProcess['backend'] = {
    mode: hosted.backend.mode,
    ...(hosted.backend.acceptsInput === undefined
      ? {}
      : { acceptsInput: hosted.backend.acceptsInput }),
    start: () => {
      started.resolve();
      return hosted.backend.start();
    },
    write: (bytes) => hosted.backend.write(bytes),
    cleanup: () => hosted.backend.cleanup(),
    ...(hosted.backend.resize === undefined
      ? {}
      : {
          resize: (columns: number, rows: number) =>
            hosted.backend.resize?.(columns, rows) as Promise<void>,
        }),
  };
  const wrapped: HostedProcess = {
    ...hosted,
    backend,
    sources,
    reportExitTo: (receiver: ProcessExitReceiver) =>
      hosted.reportExitTo({
        start: () => receiver.start(),
        reportProcessExit: (exitCode, signal) => {
          const recorded = receiver.reportProcessExit(exitCode, signal);
          exitRecorded.resolve();
          return recorded;
        },
      }),
  };
  return {
    hosted: wrapped,
    exitRecorded: exitRecorded.promise,
    started: started.promise,
    streamsEnded: streamsEnded.promise,
  };
}

export type RigOptions = {
  readonly profile: ProcessProfile;
  readonly mode: ProcessMode;
  readonly hosted: HostedProcess;
  readonly grant?: AttachmentGrant;
  readonly requestedMode?: RequestedMode;
  readonly budgets?: Partial<SessionBudgets>;
  readonly acceptsInput?: boolean;
  /** The principal's lifetime, WebSocket path only; the direct path has no principal. */
  readonly lifetimeMilliseconds?: number;
  /** Start the process before the client says hello. Direct path only: a socket's process exists only after the hello. */
  readonly startBeforeAttach?: boolean;
};

/** What stayed behind after a rig was stopped. Every count must be zero. */
export type Leaks = {
  readonly timers: number;
  readonly connections: number;
  readonly openSockets: number;
};

/** One session's whole path, from a client's frames to the process, built the same way for both transports. */
export type Rig = {
  readonly path: TransportPath;
  readonly mode: ProcessMode;
  readonly client: ConformanceClient;
  readonly clock: ManualClock;
  readonly observed: ObservedProcess;
  /** The session, once the client has attached (direct: always). */
  session(): Session;
  /** Stop reporting output as parsed. The default is a consumer that reports each chunk at once. */
  pauseConsuming(): void;
  resumeConsuming(): void;
  /**
   * Let `steps` ping intervals pass with the peer answering each, as a live browser does, so the
   * liveness deadline is extended every time.
   */
  keepAlive(steps: number): Promise<void>;
  /** The host withdraws the principal's authority: the lifetime ends, or the session is revoked. */
  expireAuthority(): Promise<void>;
  /** The server shuts down while the client is attached. */
  shutdown(): Promise<void>;
  /** The client vanishes without a close frame, as a killed browser does. */
  drop(): void;
  /** The code the transport was closed with, once it closed; `undefined` when it never closed. */
  closeCode(): Promise<number | undefined>;
  /** Stop everything the rig started, then report what it left behind. */
  stop(): Promise<Leaks>;
};

function consumeAll(client: ConformanceClient): void {
  const { received, consumed } = client.endpoint.outputBytes;
  if (received > consumed && !client.endpoint.authorityRevoked) {
    client.sendResult(client.endpoint.consumeOutput(received - consumed));
  }
}

function createDirectRig(options: RigOptions, observed: ObservedProcess): Rig {
  const clock = new ManualClock();
  const session = new Session({
    sessionId: SESSION_IDENTIFIER,
    profile: { profileId: 'conformance' },
    dimensions: { columns: 80, rows: 24 },
    clock,
    sources: observed.hosted.sources,
    backend: observed.hosted.backend,
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
  });
  let consuming = true;
  const hooks: { onFrame?: () => void } = {};
  const transport = createFixtureTransport({
    session,
    requestedMode: options.requestedMode ?? 'interactive',
    grant: options.grant ?? 'interactive',
    // The host's frames reach the client on the next microtask, the way a socket's event does.
    onFrame: () => queueMicrotask(() => hooks.onFrame?.()),
  });
  const client = new DirectClient(transport, {
    afterDelivery: () => {
      if (consuming) consumeAll(client);
    },
    // The process starts after the hello is admitted, as the WebSocket host starts it.
    afterHello: () => {
      if (options.startBeforeAttach !== true) void observed.hosted.reportExitTo(session);
    },
  });
  hooks.onFrame = () => client.deliver();
  if (options.startBeforeAttach === true) void observed.hosted.reportExitTo(session);
  let sessionDisposal: Promise<unknown> = Promise.resolve();
  return {
    path: 'direct',
    mode: options.mode,
    client,
    clock,
    observed,
    session: () => session,
    pauseConsuming: () => {
      consuming = false;
    },
    resumeConsuming: () => {
      consuming = true;
      consumeAll(client);
    },
    keepAlive: async (steps) => {
      for (let step = 0; step < steps; step += 1) {
        clock.advance(PING_INTERVAL_MILLISECONDS);
        transport.connection.noteTransportAlive();
      }
    },
    expireAuthority: async () => {
      await session.revokeAuthorization();
    },
    shutdown: async () => {
      await session.dispose();
    },
    drop: () => {
      sessionDisposal = transport.connection.transportClosed();
    },
    closeCode: async () => {
      await session.closed;
      await sessionDisposal;
      // The connection closes the transport after it sends the cleanup result; let that step run.
      await Bun.sleep(0);
      return transport.closeCodes[0];
    },
    stop: async () => {
      await session.dispose();
      // The session already cleaned up; this is the safety net, and its failure changes nothing.
      await Promise.allSettled([observed.hosted.backend.cleanup()]);
      return {
        timers: clock.pendingTimers,
        connections: 0,
        openSockets: 0,
      };
    },
  };
}

function createWebSocketRig(options: RigOptions, observed: ObservedProcess): Rig {
  const harness: Harness = startHarness({
    createProcess: () => observed.hosted,
    authentication: (request) =>
      request.headers.get('cookie') === 'sid=valid'
        ? {
            ok: true,
            subject: 'user-1',
            expiresInMilliseconds: options.lifetimeMilliseconds ?? 3_600_000,
          }
        : { ok: false, denial: 'unauthenticated' },
    authorization: {
      allowed: true,
      grant: options.grant ?? 'interactive',
      launch: {
        mode: options.mode,
        profile: options.profile,
        dimensions: { columns: 80, rows: 24 },
        ...(options.acceptsInput === undefined ? {} : { acceptsInput: options.acceptsInput }),
      },
    },
    ...(options.budgets === undefined ? {} : { server: { budgets: options.budgets } }),
  });
  // Every ping the host sends is answered by the socket, so each interval adds one pong to wait for.
  let pongsExpected = 0;
  const socketClient = connect(harness, { mode: options.requestedMode ?? 'interactive' });
  let consuming = true;
  socketClient.socket.addEventListener('message', () => {
    if (consuming) consumeAll(socketClient);
  });
  return {
    path: 'websocket',
    mode: options.mode,
    client: socketClient,
    clock: harness.clock,
    observed,
    session: () => harness.session(),
    pauseConsuming: () => {
      consuming = false;
    },
    resumeConsuming: () => {
      consuming = true;
      consumeAll(socketClient);
    },
    keepAlive: async (steps) => {
      for (let step = 0; step < steps; step += 1) {
        harness.clock.advance(PING_INTERVAL_MILLISECONDS);
        pongsExpected += 1;
        await harness.pongsReceived(pongsExpected);
      }
    },
    expireAuthority: async () => {
      harness.clock.advance(options.lifetimeMilliseconds ?? 3_600_000);
      await harness.session().closed;
    },
    shutdown: async () => {
      await harness.terminal.close();
    },
    drop: () => {
      (socketClient.socket as unknown as { terminate(): void }).terminate();
    },
    closeCode: async () => {
      const closed = await socketClient.closed;
      return closed.code;
    },
    stop: async () => {
      await harness.stop();
      // The client's own socket has seen the close, and the runtime then releases the descriptor
      // behind it on its next turn; counting descriptors before that would count one still closing.
      await socketClient.closed;
      await Bun.sleep(0);
      // The session already cleaned up; this is the safety net, and its failure changes nothing.
      await Promise.allSettled([observed.hosted.backend.cleanup()]);
      return {
        timers: harness.clock.pendingTimers,
        connections: harness.terminal.connectionCount,
        openSockets: harness.server.pendingWebSockets,
      };
    },
  };
}

/** Build the rig for `path`. The hosted process is tracked, so a scenario that throws still ends it. */
export function createRig(path: TransportPath, options: RigOptions): Rig {
  const observed = observeProcess(trackHostedProcess(options.hosted));
  return path === 'direct'
    ? createDirectRig(options, observed)
    : createWebSocketRig(options, observed);
}

/** How many descriptors this process holds. The directory read adds one, the same one every time. */
export function openDescriptorCount(): number {
  return readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length;
}
