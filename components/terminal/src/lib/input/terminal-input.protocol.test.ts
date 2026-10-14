import {
  BINARY_FRAME_HEADER_BYTES,
  ClientEndpoint,
  HostEndpoint,
  type Capabilities,
  type ClientMessage,
} from '@lostgradient/ventriloquist';
import { afterEach, describe, expect, test } from 'bun:test';

import { createFakeInputEngine, createInputSettings, pasteEvent } from './input-test-support.ts';
import type { InputRefusal, TerminalInputController } from './input-types.ts';
import { createTerminalInput } from './terminal-input.ts';

const SESSION = '0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10';
const WRITABLE: Capabilities = {
  mode: 'pty',
  input: true,
  resize: true,
  kill: true,
  readOnly: false,
};
const READ_ONLY: Capabilities = {
  mode: 'pty',
  input: false,
  resize: false,
  kill: true,
  readOnly: true,
};

function unwrap<Value>(
  result: { ok: true; value: Value } | { ok: false; failure: unknown },
): Value {
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.failure)}`);
  return result.value;
}

/** A real client and host, attached, with a controller that carries the client's frames to the host. */
function attach(
  options: {
    capabilities?: Capabilities;
    maxFrameBytes?: number;
    maxQueuedOperations?: number;
  } = {},
) {
  const host = new HostEndpoint({
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.maxQueuedOperations === undefined
      ? {}
      : { maxQueuedOperations: options.maxQueuedOperations }),
  });
  const client = new ClientEndpoint({
    sessionId: SESSION,
    requestedMode: 'interactive',
    token: 'token',
  });
  unwrap(host.receive(unwrap(client.hello())));
  unwrap(
    client.receive(
      unwrap(
        host.issueCapabilities({ generation: 1, capabilities: options.capabilities ?? WRITABLE }),
      ),
    ),
  );
  const received: ClientMessage[] = [];
  const frames: Array<Uint8Array | string> = [];
  const controller: TerminalInputController = {
    get authorityRevoked() {
      return client.authorityRevoked;
    },
    get terms() {
      return client.terms;
    },
    input(data) {
      const sent = client.input(data);
      if (!sent.ok) return sent;
      frames.push(sent.value.frame);
      received.push(unwrap(host.receive(sent.value.frame)));
      return sent;
    },
  };
  return { host, client, controller, received, frames };
}

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

function bind(controller: TerminalInputController, refusals: InputRefusal[] = []) {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  const engine = createFakeInputEngine();
  const input = createTerminalInput({
    engine,
    host,
    controller,
    readSettings: () => createInputSettings(),
    onCaptureChange: () => {},
    onReview: () => {},
    onRefused: (refusal) => refusals.push(refusal),
  });
  return { engine, input, host };
}

function payloads(received: ClientMessage[]): Uint8Array[] {
  return received.map((message) => {
    if (message.kind !== 'input') throw new Error(`unexpected ${message.kind}`);
    return message.payload;
  });
}

describe('against the real protocol endpoints', () => {
  test('the host receives exactly the bytes the engine reported, in order, as input frames', () => {
    const { controller, received } = attach();
    const { engine } = bind(controller);
    engine.report({ kind: 'text', data: 'ls' });
    engine.report({ kind: 'text', data: '\r' });
    engine.report({ kind: 'binary', data: '\u0080ÿ' });
    expect(payloads(received).map((payload) => [...payload])).toEqual([
      [0x6c, 0x73],
      [0x0d],
      [0x80, 0xff],
    ]);
    expect(received.map((message) => (message as { sequence: number }).sequence)).toEqual([
      1, 2, 3,
    ]);
  });

  test('a payload of exactly the advertised budget is one frame, and the header is extra', () => {
    const { controller, received, frames } = attach({ maxFrameBytes: 282 });
    const { engine } = bind(controller);
    engine.report({ kind: 'text', data: 'a'.repeat(282) });
    expect(received).toHaveLength(1);
    expect((frames[0] as Uint8Array).length).toBe(BINARY_FRAME_HEADER_BYTES + 282);
  });

  test('a large paste is split to the budget and reassembles to the exact bytes', () => {
    const { controller, received } = attach({ maxFrameBytes: 282 });
    const { engine } = bind(controller);
    const text = `\u001b[200~${'行 text \u001b[1mbold\u001b[0m\r'.repeat(40)}\u001b[201~`;
    engine.report({ kind: 'text', data: text });
    const chunks = payloads(received);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(282);
    expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])))).toBe(
      text,
    );
  });

  test('more operations than the host queue holds is refused whole, before anything is sent', () => {
    const refusals: InputRefusal[] = [];
    const { controller, received } = attach({ maxFrameBytes: 282, maxQueuedOperations: 2 });
    const { engine } = bind(controller, refusals);
    engine.report({ kind: 'text', data: 'x'.repeat(282 * 3) });
    expect(received).toEqual([]);
    expect(refusals).toEqual([{ reason: 'oversized' }]);
  });

  test('a full window pauses input with nothing lost mid-way, and a later input is tried afresh', () => {
    const refusals: InputRefusal[] = [];
    const { controller, received } = attach({ maxQueuedOperations: 2 });
    const { engine } = bind(controller, refusals);
    for (const data of ['a', 'b', 'c']) engine.report({ kind: 'text', data });
    expect(payloads(received).map((payload) => payload[0])).toEqual([0x61, 0x62]);
    expect(refusals).toEqual([{ reason: 'paused', acceptedOperations: 0, totalOperations: 1 }]);
    engine.report({ kind: 'text', data: 'd' });
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['paused', 'paused']);
  });

  test('a read-only attachment refuses typing and automatic replies locally', () => {
    const refusals: InputRefusal[] = [];
    const { controller, received } = attach({ capabilities: READ_ONLY });
    const { engine } = bind(controller, refusals);
    engine.report({ kind: 'text', data: 'typed' });
    engine.report({ kind: 'text', data: '\u001b[?62;c' });
    expect(received).toEqual([]);
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['read-only', 'read-only']);
  });

  test('after the client asks to stop, input is refused as revoked and not sent', () => {
    const refusals: InputRefusal[] = [];
    const { controller, client, received } = attach();
    const { engine } = bind(controller, refusals);
    unwrap(client.terminate());
    engine.report({ kind: 'text', data: 'late' });
    expect(received).toEqual([]);
    expect(refusals).toEqual([{ reason: 'read-only' }]);
  });

  test('a paste cancelled in review never reaches the host', () => {
    const { controller, received } = attach();
    const { engine, input, host } = bind(controller);
    const inner = document.createElement('textarea');
    host.append(inner);
    inner.dispatchEvent(pasteEvent('rm -rf /tmp/x\n'));
    input.cancelPaste();
    expect(engine.pastes).toEqual([]);
    expect(received).toEqual([]);
  });
});
