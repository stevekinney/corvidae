/**
 * A stand-in for the **Anthropic Messages API** — not for `/api/chat`.
 *
 * ROADMAP HS-1 needs `+page.svelte`'s `fetch('/api/chat')` → `getReader()` →
 * per-line `pushToken` loop to see a body arrive in more than one piece, and
 * HS-2 needs a genuinely HMAC-signed `approvalToken` minted by the running
 * server's own toolbox. Both fall out of the same fixture, because both are
 * downstream of what the model returns.
 *
 * WHY THE UPSTREAM AND NOT THE ROUTE. Playwright's `Route` has no incremental
 * write handle: `fulfill` takes a complete `body`, and `route.fetch()` returns
 * an already-buffered `APIResponse`. Any test that mocks `/api/chat` therefore
 * delivers exactly one chunk, no matter how it is written — which is why the
 * four original tests in `page.svelte.e2e.ts` cannot cover progressive
 * rendering even in principle. Standing in one layer further out leaves the
 * entire production path unmocked: the real SvelteKit endpoint, the real
 * Operative provider stream, the real per-`text`-event ndjson re-encode, the
 * real `toolbox.execute` (so the real approval signature), and the real
 * browser `ReadableStream` read.
 *
 * HOW THE APP REACHES THIS FILE, AND WHY THAT IS NOW LOAD-BEARING APP CODE.
 * `/api/chat` forwards `env.ANTHROPIC_BASE_URL` into
 * `createAnthropicProviderStream({ baseURL })` explicitly, and that forwarding
 * is the only thing that points the preview server here. It used to be
 * implicit: the raw `new Anthropic({ apiKey })` resolved `baseURL` from
 * `readEnv('ANTHROPIC_BASE_URL')` itself, so this file was reachable with no
 * application support at all. Operative's provider does not read the
 * environment, so that option is now ordinary application code and must stay.
 * Delete it and every spec here silently retargets the real Anthropic API —
 * the `expectFixtureHandled` assertions fail, and they fail only *after*
 * making live billed calls.
 *
 * WHY GATES, NOT DELAYS. A fixture that spaces chunks by `setTimeout(200)` and
 * a test that waits 100ms are the same guess wearing different hats, and this
 * repo treats that guess as a defect. Instead the second chunk does not exist
 * until the test asks for it: the fixture writes chunk one, then blocks on a
 * gate until `POST /__fixture/release?marker=…` arrives. "The partial text is
 * on screen while the response is still open" stops being a timing claim and
 * becomes a causal one.
 *
 * The fixture runs as a Playwright `webServer` entry keyed by generated markers.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import { FIXTURE_ORIGIN, FIXTURE_PORT } from './streaming-fixture-data';
import { earlyReleases, heldGates, requestCounts } from './streaming-fixture-gates';
import { respondToMessages } from './streaming-fixture-response';

export * from './streaming-fixture-data';

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function respondToFixtureControl(url: URL, res: ServerResponse, marker: string): boolean {
  if (url.pathname === '/__fixture/release') {
    const resume = heldGates.get(marker);
    if (resume) {
      heldGates.delete(marker);
      resume();
      jsonResponse(res, 200, { released: true });
      return true;
    }
    earlyReleases.add(marker);
    jsonResponse(res, 200, { released: false });
    return true;
  }

  if (url.pathname === '/__fixture/requests') {
    jsonResponse(res, 200, { count: requestCounts.get(marker) ?? 0 });
    return true;
  }

  if (url.pathname === '/__fixture/held') {
    jsonResponse(res, 200, { held: heldGates.has(marker) });
    return true;
  }

  return false;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', FIXTURE_ORIGIN);
  const marker = url.searchParams.get('marker') ?? '';

  if (url.pathname === '/__fixture/health' || url.pathname === '/') {
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (respondToFixtureControl(url, res, marker)) return;

  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await respondToMessages(res, await readBody(req));
    return;
  }

  jsonResponse(res, 404, { error: `Unhandled ${req.method} ${url.pathname}` });
}

export function createStreamingFixture(): Server {
  return createServer((req, res) => {
    void handle(req, res).catch((cause: unknown) => {
      // A throw here would otherwise be an unhandled rejection, and an
      // unhandled rejection takes the process down under Node's default
      // policy — turning one bad request into a suite-wide outage.
      if (!res.headersSent) jsonResponse(res, 500, { error: String(cause) });
      else if (!res.writableEnded) res.end();
    });
  });
}

/** Bind only when invoked as the fixture process, never when imported by specs. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createStreamingFixture().listen(FIXTURE_PORT, '127.0.0.1', () => {
    process.stdout.write(`streaming fixture listening on ${FIXTURE_ORIGIN}\n`);
  });
}
