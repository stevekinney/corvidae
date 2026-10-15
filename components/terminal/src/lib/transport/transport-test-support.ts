import { requiredValue } from '@lostgradient/testing';
import {
  HostEndpoint,
  ManualClock,
  type Capabilities,
  type ClientMessage,
  type HostEndpointOptions,
  type ProtocolResult,
  type SentFrame,
} from '@lostgradient/ventriloquist';

import type { BrowserSocket, TerminalWebSocketClientOptions } from './transport-types.ts';
import { TerminalWebSocketClient } from './websocket-client.ts';

export const SESSION_IDENTIFIER = '0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10';
export const TICKET = 'host-ticket';
export const URL_WITH_PROFILE = 'wss://terminal.example/terminal?profile=shell';

export const WRITABLE: Capabilities = {
  mode: 'pty',
  input: true,
  resize: true,
  kill: true,
  readOnly: false,
};
export const READ_ONLY: Capabilities = {
  mode: 'pty',
  input: false,
  resize: false,
  kill: true,
  readOnly: true,
};
export const PIPE: Capabilities = {
  mode: 'pipe',
  input: true,
  resize: false,
  kill: true,
  readOnly: false,
};

export function unwrap<Value>(
  result: { ok: true; value: Value } | { ok: false; failure: unknown },
): Value {
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.failure)}`);
  return result.value;
}

/** A browser socket the test drives by hand: what the client sent, and what the network does to it. */
export class FakeSocket implements BrowserSocket {
  binaryType = 'blob';
  readyState = 0;
  readonly sent: (string | Uint8Array)[] = [];
  readonly closes: number[] = [];
  sendThrows = false;
  closeThrows = false;
  readonly #listeners = {
    open: [] as ((event: Event) => void)[],
    error: [] as ((event: Event) => void)[],
    message: [] as ((event: MessageEvent) => void)[],
    close: [] as ((event: CloseEvent) => void)[],
  };

  constructor(readonly url: string) {}

  addEventListener(type: 'open' | 'error', listener: (event: Event) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'close', listener: (event: CloseEvent) => void): void;
  addEventListener(
    type: 'open' | 'error' | 'message' | 'close',
    listener: ((event: Event) => void) &
      ((event: MessageEvent) => void) &
      ((event: CloseEvent) => void),
  ): void {
    this.#listeners[type].push(listener);
  }

  send(data: string | Uint8Array): void {
    if (this.sendThrows) throw new Error('the socket cannot send');
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.closeThrows) throw new Error('the socket cannot close');
    this.closes.push(code ?? 1005);
    this.readyState = 3;
  }

  /** The network finished the WebSocket handshake. */
  open(): void {
    this.readyState = 1;
    for (const listener of this.#listeners.open) listener(new Event('open'));
  }

  /** A frame arrives, as the browser delivers it: text as a string, binary as an `ArrayBuffer`. */
  deliver(data: unknown): void {
    for (const listener of this.#listeners.message) listener(new MessageEvent('message', { data }));
  }

  deliverFrame(frame: string | Uint8Array): void {
    this.deliver(typeof frame === 'string' ? frame : new Uint8Array(frame).buffer);
  }

  /** The peer or the network ended the connection. */
  drop(code = 1006): void {
    this.readyState = 3;
    for (const listener of this.#listeners.close) listener(new CloseEvent('close', { code }));
  }

  fail(): void {
    for (const listener of this.#listeners.error) listener(new Event('error'));
  }
}

export type Rig = {
  readonly client: TerminalWebSocketClient;
  readonly clock: ManualClock;
  readonly sockets: FakeSocket[];
  readonly host: HostEndpoint;
  /** The connection the client opened, once it has. */
  socket(): FakeSocket;
  /** Everything the client sent that the host decoded, in order. */
  fromClient(): ClientMessage[];
  /** Hand the host's frame to the client, as the network would. */
  serve(frame: ProtocolResult<SentFrame | string>): void;
  /** The whole handshake: open, hello, capabilities. Resolves once the client reports writable or read-only. */
  attach(capabilities?: Capabilities): Promise<void>;
};

/** A client over a fake socket, with a real `HostEndpoint` playing the host, so frames are the real thing. */
export function rig(
  options: Partial<TerminalWebSocketClientOptions> = {},
  host: HostEndpointOptions = {},
): Rig {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  const hostEndpoint = new HostEndpoint(host);
  const client = new TerminalWebSocketClient({
    url: URL_WITH_PROFILE,
    sessionId: SESSION_IDENTIFIER,
    ticket: TICKET,
    schedule: (callback, delay) => clock.schedule(callback, delay),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  let decoded = 0;
  const fromClient = (): ClientMessage[] => {
    const messages: ClientMessage[] = [];
    const socket = requiredValue(sockets[0]);
    for (const frame of socket.sent.slice(decoded)) {
      const result = hostEndpoint.receive(frame);
      if (result.ok) messages.push(result.value);
    }
    decoded = socket.sent.length;
    return messages;
  };
  const subject: Rig = {
    client,
    clock,
    sockets,
    host: hostEndpoint,
    socket: () => requiredValue(sockets[0]),
    fromClient,
    serve: (frame) => {
      const value = unwrap(frame);
      subject.socket().deliverFrame(typeof value === 'string' ? value : value.frame);
    },
    attach: async (capabilities = WRITABLE) => {
      const connected = client.connect();
      subject.socket().open();
      fromClient();
      subject.serve(hostEndpoint.issueCapabilities({ generation: 1, capabilities }));
      await connected;
    },
  };
  return subject;
}
