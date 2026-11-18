import type {
  TerminalInputController,
  TerminalOutputListener,
  TerminalRendererController,
  TerminalRendererFailure,
} from '@lostgradient/terminal';

/**
 * A deterministic in-page session for the terminal browser proof. It stands in for the transport
 * the component borrows a controller from: a test writes exact bytes into it and reads back the
 * exact bytes the component sent, with no process, socket, timer or randomness involved.
 *
 * It implements `TerminalRendererController` and nothing else. In particular it never starts a
 * process, opens a socket or loads host code, which is what the SSR and hydration proof counts.
 */

export type InputMode = 'accept' | 'fifo-full' | 'read-only' | 'transport-failed' | 'throw';

export type ScriptedSessionOptions = {
  maxFrameBytes?: number;
  maxQueuedOperations?: number;
};

export type ScriptedSession = TerminalRendererController & {
  readonly input: TerminalInputController;
  /** Every chunk offered to `input`, in order, as exact byte values. */
  readonly sent: number[][];
  /** Every chunk delivered to a subscriber, in order, as exact byte values. */
  readonly delivered: number[][];
  readonly failures: TerminalRendererFailure[];
  /** How many times a renderer subscribed, and how many of those are still live. */
  readonly subscriptions: { total: number; live: number };
  /** Calls to `input`, whether or not they were accepted. */
  inputCalls: number;
  inputMode: InputMode;
  /** Write bytes (a string is encoded as UTF-8) as one chunk. */
  write(data: string | Uint8Array | readonly number[]): void;
  /** Write each piece as its own chunk, in order. */
  writeChunks(pieces: ReadonlyArray<string | Uint8Array | readonly number[]>): void;
  /** Resolves when every delivered chunk has been parsed by the engine. */
  settled(): Promise<void>;
  /** Revoke the controller's authority, as the host does. */
  revoke(): void;
  /** Forget what was sent, so a test can assert on one step. */
  resetSent(): void;
};

const encoder = new TextEncoder();

function toBytes(data: string | Uint8Array | readonly number[]): Uint8Array {
  if (typeof data === 'string') return encoder.encode(data);
  return data instanceof Uint8Array ? data.slice() : Uint8Array.from(data);
}

export function createScriptedSession(options: ScriptedSessionOptions = {}): ScriptedSession {
  const listeners = new Set<TerminalOutputListener>();
  const history: Uint8Array[] = [];
  let pending = 0;
  let waiters: Array<() => void> = [];
  const subscriptions = { total: 0, live: 0 };

  const release = (): void => {
    pending -= 1;
    if (pending > 0) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  };

  const deliver = (listener: TerminalOutputListener, chunk: Uint8Array): void => {
    pending += 1;
    let acknowledged = false;
    listener(chunk.slice(), () => {
      if (acknowledged) return;
      acknowledged = true;
      release();
    });
  };

  const session: ScriptedSession = {
    sent: [],
    delivered: [],
    failures: [],
    subscriptions,
    inputCalls: 0,
    inputMode: 'accept',
    input: {
      authorityRevoked: false,
      terms: {
        maxFrameBytes: options.maxFrameBytes ?? 65_536,
        maxQueuedOperations: options.maxQueuedOperations ?? 256,
      },
      input(data) {
        session.inputCalls += 1;
        switch (session.inputMode) {
          case 'throw':
            throw new Error('scripted transport failure');
          case 'accept':
            session.sent.push([...data]);
            return { ok: true, value: undefined };
          default:
            return { ok: false, failure: { code: session.inputMode, reason: 'scripted' } } as never;
        }
      },
    },
    subscribeOutput(listener) {
      listeners.add(listener);
      subscriptions.total += 1;
      subscriptions.live += 1;
      // The controller delivers everything produced since the attachment started, in order.
      for (const chunk of history) deliver(listener, chunk);
      return () => {
        if (listeners.delete(listener)) subscriptions.live -= 1;
      };
    },
    rendererFailed(failure) {
      session.failures.push(failure);
    },
    write(data) {
      const chunk = toBytes(data);
      history.push(chunk);
      session.delivered.push([...chunk]);
      for (const listener of listeners) deliver(listener, chunk);
    },
    writeChunks(pieces) {
      for (const piece of pieces) session.write(piece);
    },
    settled() {
      if (pending <= 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    revoke() {
      (session.input as { authorityRevoked: boolean }).authorityRevoked = true;
    },
    resetSent() {
      session.sent.length = 0;
    },
  };
  return session;
}
