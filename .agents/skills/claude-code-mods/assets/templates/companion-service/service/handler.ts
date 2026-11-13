import {
  PROTOCOL_VERSION,
  SERVICE_NAME,
  parseItem,
  parsePresence,
} from '../plugin/hooks/protocol.ts';
import type { Queue } from './queue.ts';

export type HandlerOptions = {
  queue: Queue;
  /** The bearer token every `/v1` request must carry. */
  token: string;
  /** The port this process listens on, for the Host header check. */
  port: number;
  now: () => number;
};

const MAXIMUM_BODY_CHARACTERS = 64 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Compares two secrets in time that depends only on their length. */
function isSameSecret(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < given.length; index += 1) {
    difference |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function bodyOf(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAXIMUM_BODY_CHARACTERS) throw new RangeError('body too large');
  const text = await request.text();
  if (text.length > MAXIMUM_BODY_CHARACTERS) throw new RangeError('body too large');
  return JSON.parse(text);
}

/**
 * The service's whole HTTP surface as one function from Request to Response,
 * so it can be tested without starting a server, and served by `Bun.serve` or
 * any other runtime that speaks the web Request and Response types.
 */
export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  const { queue, token, port, now } = options;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  return async (request) => {
    // Loopback only, by name as well as by socket: a browser page that rebinds
    // a hostname to 127.0.0.1 still sends its own Host header and an Origin.
    if (!allowedHosts.has(request.headers.get('host') ?? ''))
      return json(403, { error: 'host not allowed' });
    if (request.headers.has('origin'))
      return json(403, { error: 'browser requests are not accepted' });

    const { pathname } = new URL(request.url);
    if (pathname === '/health') {
      if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
      return json(200, { service: SERVICE_NAME, protocolVersion: PROTOCOL_VERSION });
    }

    if (!pathname.startsWith('/v1/')) return json(404, { error: 'not found' });
    const authorization = request.headers.get('authorization') ?? '';
    const given = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (!isSameSecret(given, token)) return json(401, { error: 'unauthorized' });

    try {
      if (pathname === '/v1/items') {
        if (request.method === 'GET') return json(200, { items: queue.list(), generatedAt: now() });
        if (request.method === 'POST') {
          const candidate = await bodyOf(request);
          const item = parseItem({ ...(candidate as object), acknowledgedAt: null });
          if (item === undefined) return json(400, { error: 'invalid item' });
          const outcome = queue.upsert(item);
          return json(outcome === 'created' ? 201 : 200, { status: outcome });
        }
        return json(405, { error: 'method not allowed' });
      }

      const acknowledgement = /^\/v1\/items\/([^/]+)\/acknowledge$/.exec(pathname);
      if (acknowledgement !== null) {
        if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
        const outcome = queue.acknowledge(decodeURIComponent(acknowledgement[1] ?? ''), now());
        return json(outcome === 'missing' ? 404 : 200, { status: outcome });
      }

      if (pathname === '/v1/presence' && request.method === 'GET') {
        return json(200, { sessions: queue.livePresence(now()) });
      }
      const presenceMatch = /^\/v1\/presence\/([^/]+)$/.exec(pathname);
      if (presenceMatch !== null) {
        if (request.method !== 'PUT') return json(405, { error: 'method not allowed' });
        const heartbeat = parsePresence(await bodyOf(request));
        if (
          heartbeat === undefined ||
          heartbeat.sessionId !== decodeURIComponent(presenceMatch[1] ?? '')
        ) {
          return json(400, { error: 'invalid presence' });
        }
        return json(200, { status: queue.recordPresence(heartbeat, now()) });
      }

      return json(404, { error: 'not found' });
    } catch (error) {
      if (error instanceof RangeError) return json(413, { error: 'body too large' });
      if (error instanceof SyntaxError) return json(400, { error: 'invalid JSON' });
      throw error;
    }
  };
}
