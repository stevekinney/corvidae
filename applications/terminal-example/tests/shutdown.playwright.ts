import { ClientEndpoint } from '@lostgradient/ventriloquist';
import { expect, test } from '@playwright/test';

import { OWN_SERVER_PORT, START_TOKEN } from './origin.ts';
import { enrollWithoutBrowser, isAlive } from './support.ts';

const PORT = OWN_SERVER_PORT;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** The identifiers of a process's children, which `pgrep -P` reads the same way on macOS and Linux. */
async function childrenOf(pid: number): Promise<number[]> {
  const listing = Bun.spawn(['pgrep', '-P', String(pid)], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 10_000,
  });
  const text = await new Response(listing.stdout).text();
  await listing.exited;
  return text.split('\n').flatMap((line) => (line.trim() === '' ? [] : [Number(line)]));
}

test('stopping the server with a session open ends the session and its process', async () => {
  const server = Bun.spawn(
    ['bun', 'src/server/main.ts', '--port', String(PORT), '--start-token', START_TOKEN],
    {
      cwd: import.meta.dirname.replace(/\/tests$/, ''),
      env: { ...process.env, SHELL: '/bin/sh' },
      stdout: 'pipe',
      stderr: 'inherit',
      timeout: 60_000,
    },
  );
  try {
    const reader = server.stdout.getReader();
    let banner = '';
    while (!banner.includes('listening')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('the server ended before it listened');
      banner += new TextDecoder().decode(value);
    }
    const cookie = await enrollWithoutBrowser(ORIGIN, START_TOKEN);
    const issued = await fetch(`${ORIGIN}/session`, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'shell', readOnly: false }),
    });
    const grant = (await issued.json()) as { sessionId: string; ticket: string };
    const endpoint = new ClientEndpoint({
      sessionId: grant.sessionId,
      requestedMode: 'interactive',
      token: grant.ticket,
    });
    const hello = endpoint.hello();
    if (!hello.ok) throw new Error('the client could not build its hello');
    const frame = hello.value;
    const closed = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${PORT}/terminal?profile=shell`, {
        headers: { Origin: ORIGIN, Cookie: cookie },
      } as never);
      socket.addEventListener('open', () => socket.send(frame));
      socket.addEventListener('message', () => {
        // Attached: the shell is running. The socket stays open until the server stops.
        resolve();
      });
      socket.addEventListener('error', () => reject(new Error('the socket failed')));
    });
    await closed;
    await expect.poll(() => childrenOf(server.pid), { timeout: 10_000 }).not.toEqual([]);
    const children = await childrenOf(server.pid);
    expect(children.every((child) => isAlive(child))).toBe(true);
    // A graceful stop, as Ctrl+C is: the server revokes the session and ends the shell first.
    server.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    for (const child of children) expect(isAlive(child), `child ${child}`).toBe(false);
  } finally {
    // The server is this test's own child; end it if the checks above did not.
    server.kill('SIGKILL');
  }
});
