import { outcomeOf, rethrow } from '@lostgradient/testing';
import { SessionSlot } from '@lostgradient/ventriloquist';
import {
  createBunProcessFactory,
  createTerminalWebSocketServer,
  type SocketData,
} from '@lostgradient/ventriloquist/websocket';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalTransportState } from './transport-types.ts';
import { TerminalWebSocketClient } from './websocket-client.ts';

/**
 * The capacity probe against a real PTY whose child stops reading its input, so the host's own queue
 * fills and refuses with `fifo-full`, and later resumes. The host sends nothing when its queue drains;
 * only the client's empty-input probe, which the host accepts exactly when there is room, lifts the
 * pause. The body starts a real process, so it runs at module scope and the test rethrows what it
 * recorded.
 */
const ORIGIN = 'https://terminal.example';
const COOKIE = 'sid=valid';

/** Resolves when the client next reports `state`, or at once if it already does. */
function settled(client: TerminalWebSocketClient, state: TerminalTransportState): Promise<void> {
  if (client.state === state) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = client.subscribeState((next) => {
      if (next !== state) return;
      stop();
      resolve();
    });
  });
}

const scenario = await outcomeOf(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-probe-'));
  const release = join(directory, 'release');
  const terminal = createTerminalWebSocketServer({
    host: {
      authenticate: (request) =>
        request.headers.get('cookie') === COOKIE
          ? { ok: true, subject: 'user-1', expiresInMilliseconds: 3_600_000 }
          : { ok: false, denial: 'unauthenticated' },
      authorize: () => ({
        allowed: true,
        grant: 'interactive',
        launch: {
          mode: 'pty',
          profile: {
            executable: '/bin/sh',
            // Raw mode, so the line discipline buffers nothing for the child; then deaf until released.
            argumentList: [
              '-c',
              'stty raw -echo; echo ready; until [ -e "$RELEASE" ]; do sleep 0.05; done; exec cat >/dev/null',
            ],
            workingDirectory: '/',
            environment: { PATH: '/usr/bin:/bin', RELEASE: release },
          },
          dimensions: { columns: 80, rows: 24 },
        },
      }),
    },
    createProcess: createBunProcessFactory({ terminationGraceMilliseconds: 100 }),
    allowedOrigins: [ORIGIN],
    allowInsecureLoopback: true,
    boundHostname: '127.0.0.1',
    slotFor: () => new SessionSlot(),
  });
  const server = Bun.serve<SocketData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, listener) => terminal.handleUpgrade(request, listener),
    websocket: terminal.websocket,
  });
  try {
    const client = new TerminalWebSocketClient({
      url: `ws://127.0.0.1:${server.port}/terminal?profile=shell`,
      sessionId: '0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10',
      ticket: 'ticket',
      allowInsecureLoopback: true,
      probeInitialMilliseconds: 20,
      probeMaximumMilliseconds: 80,
      createSocket: (address) =>
        new WebSocket(address, {
          headers: { Origin: ORIGIN, Cookie: COOKIE },
        } as never),
    });
    await client.connect();
    // Wait until the child is in raw mode; in cooked mode a long line would never reach it.
    let heard = '';
    const ready = new Promise<void>((resolve) => {
      client.subscribeOutput((bytes, parsed) => {
        heard += new TextDecoder().decode(bytes);
        parsed();
        if (heard.includes('ready')) resolve();
      });
    });
    await ready;
    const states: TerminalTransportState[] = [];
    client.subscribeState((state) => states.push(state));
    const paused = new Promise<void>((resolve) => {
      client.subscribeState((state) => {
        if (state === 'backpressured') resolve();
      });
    });
    const resumed = new Promise<void>((resolve) => {
      client.subscribeState((state) => {
        if (state === 'writable' && states.includes('backpressured')) resolve();
      });
    });
    // Fill the host's input budget while the child is deaf, until it refuses.
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    let refused = false;
    for (let sent = 0; sent < 64 && !refused; sent += 1) {
      const result = await client.sendInput(chunk);
      refused = result.status === 'failed' && result.code === 'fifo-full';
    }
    expect(refused).toBe(true);
    await paused;
    expect(client.state).toBe('backpressured');
    // Nothing is sent while paused, and the host says nothing: the child resumes, and the probe notices.
    writeFileSync(release, '');
    await resumed;
    expect(client.state).toBe('writable');
    expect(states.slice(0, 2)).toEqual(['backpressured', 'writable']);
    // The probe is empty, so it proves a free operation slot, not free input bytes: while the child
    // is still draining its backlog a real keystroke may pause the client once more, and the probe
    // lifts that pause again. It is never a wedge, and a keystroke is accepted once the backlog clears.
    let accepted = false;
    for (let attempt = 0; attempt < 200 && !accepted; attempt += 1) {
      const result = await client.sendInput('z');
      accepted = result.status === 'accepted';
      if (!accepted) await settled(client, 'writable');
    }
    expect(accepted).toBe(true);
    const stopped = await client.stop();
    expect(stopped.outcome).toBe('complete');
  } finally {
    await terminal.close();
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an empty probe lifts the pause once a PTY child that stopped reading resumes', () => {
  rethrow(scenario);
});
