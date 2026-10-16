import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { ClientEndpoint } from '@lostgradient/ventriloquist';

import { EXAMPLE_ORIGIN, EXAMPLE_PORT, REFUSAL_PORT, START_TOKEN } from './origin.ts';
import { enroll, enrollWithoutBrowser } from './support.ts';

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

/** The cookie the server issues for the start token, exactly as a browser would send it back. */
function sessionCookie(): Promise<string> {
  return enrollWithoutBrowser(EXAMPLE_ORIGIN, START_TOKEN);
}

test('a cross-origin upgrade is denied, and the served origin is admitted', async () => {
  const cookie = await sessionCookie();
  expect(cookie.startsWith(`terminal-example-session-${EXAMPLE_PORT}=`)).toBe(true);
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
  await enroll(page);
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
  const response = await enroll(page);
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("script-src 'self'");
  expect(policy).not.toContain('wasm-unsafe-eval');
  expect(policy).toContain("connect-src 'self'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("frame-ancestors 'none'");
  const cookies = await page.context().cookies();
  const cookie = cookies.find(
    (candidate) => candidate.name === `terminal-example-session-${EXAMPLE_PORT}`,
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  // No script on the page can read the credential.
  expect(await page.evaluate(() => document.cookie)).toBe('');
});

test('the server refuses another origin for a session request', async ({ page }) => {
  await enroll(page);
  const response = await page.request.post(`${EXAMPLE_ORIGIN}/session`, {
    headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
    data: { profile: 'shell', readOnly: false },
    failOnStatusCode: false,
  });
  expect(response.status()).toBe(403);
});

test('asked to bind a non-loopback address, the server exits nonzero and says why', async () => {
  const child = Bun.spawn(
    ['bun', 'src/server/main.ts', '--hostname', '0.0.0.0', '--port', String(REFUSAL_PORT)],
    {
      cwd: import.meta.dirname.replace(/\/tests$/, ''),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    },
  );
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(exitCode).toBe(2);
  expect(stderr).toContain('Refusing to bind "0.0.0.0"');
  expect(stderr).toContain('loopback');
});

test('a visitor without the start token is enrolled nowhere and told how to get in', async ({
  page,
}) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(401);
  await expect(page.getByRole('heading', { name: 'Open the start URL' })).toBeVisible();
  expect(await page.context().cookies()).toEqual([]);
  // A wrong token fares no better.
  const wrong = await page.goto('/?token=not-the-start-token');
  expect(wrong?.status()).toBe(403);
  expect(await page.context().cookies()).toEqual([]);
  // Nor does the session route open to a browser that never enrolled.
  const session = await page.request.post('/session', {
    headers: { origin: EXAMPLE_ORIGIN },
    data: { profile: 'shell', readOnly: false },
    failOnStatusCode: false,
  });
  expect(session.status()).toBe(401);
});

test('a page on another origin cannot enroll the browser, even holding the token', async ({
  page,
}) => {
  const other = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>other</title>');
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  try {
    const otherPort = (other.address() as AddressInfo).port;
    await page.goto(`http://127.0.0.1:${otherPort}/`);
    const status = await page.evaluate(
      async ({ address }) => {
        // A no-cors request is all a web page may make of another origin.
        // The browser blocks the answer (the server's resource policy is same-origin), not the request.
        await fetch(address, { mode: 'no-cors' }).catch(() => undefined);
        return 'sent';
      },
      { address: `${EXAMPLE_ORIGIN}/?token=${START_TOKEN}` },
    );
    expect(status).toBe('sent');
    expect(await page.context().cookies()).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});

test('the session request body is bounded before it is read', async ({ page }) => {
  await enroll(page);
  const post = (data: string) =>
    page.request.post('/session', {
      headers: { origin: EXAMPLE_ORIGIN, 'content-type': 'application/json' },
      data,
      failOnStatusCode: false,
    });
  // Over the handler's limit, and far over the server's own cap.
  const handler = await post(
    JSON.stringify({ profile: 'shell', readOnly: false, pad: 'x'.repeat(2000) }),
  );
  expect(handler.status()).toBe(413);
  const server = await post('x'.repeat(100_000));
  expect(server.status()).toBe(413);
});
