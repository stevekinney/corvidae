import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { ClientEndpoint } from '@lostgradient/ventriloquist';

import { EXAMPLE_ORIGIN, EXAMPLE_PORT } from './origin.ts';

const SOCKET_ADDRESS = `ws://127.0.0.1:${EXAMPLE_PORT}/terminal?profile=shell`;

type SocketOutcome = 'opened' | 'refused';

/** Open a socket the way a page of `origin` would, with the session cookie, and say what happened. */
function openSocket(origin: string, cookie: string): Promise<SocketOutcome> {
  return new Promise((resolve) => {
    const socket = new WebSocket(SOCKET_ADDRESS, {
      headers: { Origin: origin, Cookie: cookie },
    } as never);
    socket.addEventListener('open', () => {
      socket.close();
      resolve('opened');
    });
    socket.addEventListener('error', () => resolve('refused'));
    socket.addEventListener('close', () => resolve('refused'));
  });
}

/** The cookie the server issues with the page, exactly as a browser would send it back. */
async function sessionCookie(): Promise<string> {
  const response = await fetch(`${EXAMPLE_ORIGIN}/`);
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}

test('a cross-origin upgrade is denied, and the served origin is admitted', async () => {
  const cookie = await sessionCookie();
  expect(cookie).toMatch(/^terminal-example-session=/);
  // The control: the same cookie from the served origin is admitted, so the refusals below are the origin's doing.
  expect(await openSocket(EXAMPLE_ORIGIN, cookie)).toBe('opened');
  expect(await openSocket('http://evil.example', cookie)).toBe('refused');
  expect(await openSocket(`http://localhost:${EXAMPLE_PORT}`, cookie)).toBe('refused');
  expect(await openSocket('null', cookie)).toBe('refused');
  // And with no cookie at all, from the right origin.
  expect(await openSocket(EXAMPLE_ORIGIN, '')).toBe('refused');
});

/** Send one hello with `token` for `sessionId` and return everything the server said before it closed. */
async function helloOutcome(cookie: string, sessionId: string, token: string): Promise<string> {
  const endpoint = new ClientEndpoint({ sessionId, requestedMode: 'interactive', token });
  const hello = endpoint.hello();
  if (!hello.ok) throw new Error('the client could not build its hello');
  const frame = hello.value;
  return new Promise<string>((resolve) => {
    const seen: string[] = [];
    const socket = new WebSocket(SOCKET_ADDRESS, {
      headers: { Origin: EXAMPLE_ORIGIN, Cookie: cookie },
    } as never);
    socket.addEventListener('open', () => socket.send(frame));
    socket.addEventListener('message', (event) => {
      seen.push(String(event.data));
      // Admitted: that is all this check needs, and closing ends the session it started.
      socket.close();
    });
    socket.addEventListener('close', () => resolve(seen.join('')));
  });
}

test('a hello needs a ticket this server issued to this browser for this session', async () => {
  const cookie = await sessionCookie();
  const issued = await fetch(`${EXAMPLE_ORIGIN}/session`, {
    method: 'POST',
    headers: { cookie, origin: EXAMPLE_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'readonly-output', readOnly: true }),
  });
  const grant = (await issued.json()) as { sessionId: string; ticket: string };
  // The control: the issued ticket for its own session is admitted.
  expect(await helloOutcome(cookie, grant.sessionId, grant.ticket)).toContain('capabilities');
  // The same ticket is spent, another session's ticket is wrong, and an invented one was never issued.
  expect(await helloOutcome(cookie, grant.sessionId, grant.ticket)).not.toContain('capabilities');
  const reissued = await fetch(`${EXAMPLE_ORIGIN}/session`, {
    method: 'POST',
    headers: { cookie, origin: EXAMPLE_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'readonly-output', readOnly: true }),
  });
  const second = (await reissued.json()) as { sessionId: string; ticket: string };
  expect(await helloOutcome(cookie, crypto.randomUUID(), second.ticket)).not.toContain(
    'capabilities',
  );
  expect(await helloOutcome(cookie, second.sessionId, 'invented')).not.toContain('capabilities');
});

test('a page on another origin cannot open the terminal from the browser either', async ({
  page,
}) => {
  // The browser's own cookie jar is the point: the cookie is valid for this host, and only the
  // origin of the page that opens the socket differs.
  await page.goto('/');
  const other = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>other</title>');
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  try {
    const otherPort = (other.address() as AddressInfo).port;
    await page.goto(`http://127.0.0.1:${otherPort}/`);
    const outcome = await page.evaluate(
      (address) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(address);
          socket.addEventListener('open', () => resolve('opened'));
          socket.addEventListener('close', () => resolve('refused'));
        }),
      SOCKET_ADDRESS,
    );
    expect(outcome).toBe('refused');
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});

test('the page is served with the COR-483 policy and an HttpOnly cookie', async ({ page }) => {
  const response = await page.goto('/');
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("script-src 'self'");
  expect(policy).not.toContain('wasm-unsafe-eval');
  expect(policy).toContain("connect-src 'self'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("frame-ancestors 'none'");
  const cookies = await page.context().cookies();
  const cookie = cookies.find((candidate) => candidate.name === 'terminal-example-session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  // No script on the page can read the credential.
  expect(await page.evaluate(() => document.cookie)).toBe('');
});

test('the server refuses another origin for a session request', async ({ page }) => {
  await page.goto('/');
  const response = await page.request.post(`${EXAMPLE_ORIGIN}/session`, {
    headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
    data: { profile: 'shell', readOnly: false },
    failOnStatusCode: false,
  });
  expect(response.status()).toBe(403);
});

test('asked to bind a non-loopback address, the server exits nonzero and says why', async () => {
  const child = Bun.spawn(
    ['bun', 'src/server/main.ts', '--hostname', '0.0.0.0', '--port', '54249'],
    {
      cwd: import.meta.dirname.replace(/\/tests$/, ''),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    },
  );
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('Refusing to bind "0.0.0.0"');
  expect(stderr).toContain('loopback');
});
