import { describe, expect, test } from 'bun:test';

import { serveTerminalWebSocket } from './serve-terminal.ts';
import type { TerminalHostCallbacks } from './websocket-types.ts';
import {
  LAUNCH,
  ORIGIN,
  SESSION_COOKIE,
  SESSION_IDENTIFIER,
  TICKET,
  TestClient,
  scriptedProcess,
} from './websocket.test-support.ts';

const host: TerminalHostCallbacks = {
  authenticate: (request) =>
    request.headers.get('cookie') === SESSION_COOKIE
      ? { ok: true, subject: 'user-1', expiresInMilliseconds: 3_600_000 }
      : { ok: false, denial: 'unauthenticated' },
  authorize: () => ({ allowed: true, grant: 'interactive', launch: LAUNCH }),
};

describe('serveTerminalWebSocket', () => {
  // spawn-free: the process factory is a scripted stand-in, so no process is ever created
  test('upgrades only the terminal path and answers every other path with 404', async () => {
    const process = scriptedProcess();
    const served = serveTerminalWebSocket({
      host,
      createProcess: () => process.hosted,
      allowedOrigins: [ORIGIN],
      allowInsecureLoopback: true,
      hostname: '127.0.0.1',
    });
    try {
      const base = `127.0.0.1:${served.server.port}`;
      const awaited63 = await fetch(`http://${base}/elsewhere`);
      expect(awaited63.status).toBe(404);
      const awaited64 = await fetch(`http://${base}/terminal?profile=shell`);
      expect(awaited64.status).toBe(426);
      const client = new TestClient(`ws://${base}/terminal?profile=shell`);
      const awaited65 = await client.handshake();
      expect(awaited65.sessionId).toBe(SESSION_IDENTIFIER);
      expect(served.terminal.connectionCount).toBe(1);
      expect(client.endpoint.terms?.generation).toBeGreaterThanOrEqual(1);
      client.sendResult(client.endpoint.input('ok'));
      await process.writes(1);
    } finally {
      await served.terminal.close();
      await served.server.stop(true);
    }
  });

  // spawn-free: the default Bun process factory is built but never called, since no hello arrives
  test('serves a custom path, and defaults the process factory to the Bun helpers without starting one', async () => {
    const served = serveTerminalWebSocket({
      host,
      allowedOrigins: [ORIGIN],
      path: '/pty',
      hostname: '127.0.0.1',
    });
    try {
      const base = `127.0.0.1:${served.server.port}`;
      const awaited66 = await fetch(`http://${base}/terminal?profile=shell`);
      expect(awaited66.status).toBe(404);
      // Plain http, with no development switch: refused before authentication.
      const client = new TestClient(`ws://${base}/pty?profile=shell`, { cookie: SESSION_COOKIE });
      expect(await client.refused()).toBe(true);
      expect(TICKET).toBeString();
    } finally {
      await served.server.stop(true);
    }
  });
});
