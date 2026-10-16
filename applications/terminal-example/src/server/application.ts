import { createHash, timingSafeEqual } from 'node:crypto';
import { join, normalize, sep } from 'node:path';

import {
  createTerminalWebSocketServer,
  type AuthorizationRequest,
  type CreateProcess,
  type TerminalWebSocketHandlers,
  type TerminalWebSocketServer,
  type UpgradeServer,
} from '@lostgradient/ventriloquist/websocket';

import {
  isProfileIdentifier,
  type SessionGrant,
  type SessionRequest,
  type SlotStatus,
} from '../shared/profile-catalog.ts';
import { ConfigurationError, servedOrigin, type ServerConfiguration } from './configuration.ts';
import { SECURITY_HEADERS } from './content-security-policy.ts';
import { readHostEnvironment } from './environment-configuration.ts';
import { localUser, resolveProfile, type ProfileContext } from './profiles.ts';
import { cookieNameForPort, SessionStore } from './session-store.ts';

/** How long `POST /session` waits for the previous session of the same browser to finish cleanup. */
export const DEFAULT_SESSION_WAIT_MILLISECONDS = 15_000;
/** The largest `POST /session` body, in bytes. A real body is under a hundred. */
export const MAXIMUM_REQUEST_BODY_BYTES = 1024;

export type ApplicationOptions = {
  readonly configuration: ServerConfiguration;
  /** The directory `bun run build` wrote: `index.html` and the files it names. */
  readonly buildDirectory: string;
  /** What profiles may read from the host. Defaults to the real environment and account. */
  readonly context?: ProfileContext;
  /** Turns an authorized launch into a process: the Bun pipe and PTY helpers, or a stand-in in a test. */
  readonly createProcess: CreateProcess;
  readonly store?: SessionStore;
  readonly sessionWaitMilliseconds?: number;
  /**
   * The secret in the startup URL. A browser enrolls only by navigating to `/?token=…` with it, so
   * a process that merely reaches the loopback port (or a web page that makes the browser reach
   * it) gets no cookie and no shell.
   */
  readonly startToken: string;
  /** How many browsers the token admits before the server must be restarted. Defaults to the configuration's. */
  readonly browsers?: number;
};

export type Application = {
  /** The one origin the page is served from and the upgrade accepts. */
  readonly origin: string;
  readonly store: SessionStore;
  readonly terminal: TerminalWebSocketServer;
  readonly websocket: TerminalWebSocketHandlers;
  fetch(request: Request, server: UpgradeServer): Promise<Response | undefined>;
  /** Revoke every session and wait for each process to be cleaned up. The listener is the caller's. */
  close(): Promise<void>;
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function plain(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

/** Every file the build wrote, by the URL path it is served at. */
async function indexBuild(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const relative of new Bun.Glob('**/*').scan({ cwd: directory, dot: false })) {
    if (relative === 'metafile.json') continue;
    files.set(`/${relative.split(sep).join('/')}`, join(directory, relative));
  }
  if (!files.has('/index.html')) {
    throw new ConfigurationError(
      `There is no build at ${directory}. Run \`bun run build\` in applications/terminal-example first, or use \`bun run dev\`, which builds before it serves.`,
    );
  }
  return files;
}

function parseSessionRequest(text: string): SessionRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fields = Object.keys(value);
  const { profile, readOnly } = value as Record<string, unknown>;
  if (fields.length !== 2 || !isProfileIdentifier(profile) || typeof readOnly !== 'boolean') {
    return undefined;
  }
  return { profile, readOnly };
}

function page(status: number, heading: string, text: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Terminal example</title></head><body><main><h1>${heading}</h1><p>${text}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' },
  });
}

function sameSecret(given: string, expected: string): boolean {
  const left = createHash('sha256').update(given).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/** A navigation the user made to this page, as the browser reports it. A script or another site cannot forge these headers. */
function isTopLevelNavigation(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  return (
    request.method === 'GET' &&
    (site === 'none' || site === 'same-origin') &&
    request.headers.get('sec-fetch-dest') === 'document'
  );
}

function wait(milliseconds: number): { promise: Promise<'timeout'>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), milliseconds);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export async function createApplication(options: ApplicationOptions): Promise<Application> {
  const origin = servedOrigin(options.configuration);
  const authority = new URL(origin).host;
  const files = await indexBuild(options.buildDirectory);
  const context: ProfileContext = options.context ?? {
    host: readHostEnvironment(),
    user: localUser(),
  };
  const store =
    options.store ??
    new SessionStore({ cookieName: cookieNameForPort(options.configuration.port) });
  let admissionsLeft = options.browsers ?? options.configuration.browsers;
  const sessionWait = options.sessionWaitMilliseconds ?? DEFAULT_SESSION_WAIT_MILLISECONDS;

  const terminal = createTerminalWebSocketServer({
    host: {
      authenticate: (request) => store.authenticate(request),
      authorize: (request: AuthorizationRequest) => {
        // The page named a profile and a mode and nothing else. The ticket proves this browser asked
        // the server for this session a moment ago, and it works once.
        if (!store.redeemTicket(request.subject, request.sessionId, request.ticket)) {
          return { allowed: false, denial: 'forbidden' };
        }
        if (!isProfileIdentifier(request.profileId)) return { allowed: false, denial: 'forbidden' };
        const resolved = resolveProfile(
          request.profileId,
          request.requestedMode === 'read-only',
          context,
        );
        if (resolved === undefined) return { allowed: false, denial: 'unavailable' };
        return { allowed: true, grant: resolved.grant, launch: resolved.launch };
      },
    },
    createProcess: options.createProcess,
    // The page is served from one origin, and only that origin may open a terminal.
    allowedOrigins: [origin],
    // The listener is bound to loopback (the configuration refused anything else), so the plain
    // `ws:` upgrade is allowed. Origin and the cookie still apply.
    allowInsecureLoopback: true,
    boundHostname: options.configuration.hostname,
    slotFor: (subject) => store.slotFor(subject),
  });

  function slotStatus(subject: string): SlotStatus {
    const current = store.slotFor(subject).current;
    if (current === undefined) return 'free';
    if (current.snapshot.quarantined) return 'quarantined';
    return current.snapshot.closed ? 'free' : 'busy';
  }

  async function createSession(request: Request, subject: string): Promise<Response> {
    if (request.headers.get('origin') !== origin) return json(403, { error: 'origin' });
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
      return json(415, { error: 'content-type' });
    }
    // Judge the size from the declared length before reading anything, then again from what arrived.
    const declared = request.headers.get('content-length');
    if (declared === null) return json(411, { error: 'length-required' });
    if (!/^\d+$/.test(declared)) return json(400, { error: 'content-length' });
    if (Number(declared) > MAXIMUM_REQUEST_BODY_BYTES) return json(413, { error: 'too-large' });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAXIMUM_REQUEST_BODY_BYTES) return json(413, { error: 'too-large' });
    if (bytes.byteLength !== Number(declared)) return json(400, { error: 'content-length' });
    const text = new TextDecoder().decode(bytes);
    const parsed = parseSessionRequest(text);
    if (parsed === undefined) return json(400, { error: 'request' });
    if (resolveProfile(parsed.profile, parsed.readOnly, context) === undefined) {
      return json(503, { error: 'unavailable' });
    }
    // One session per browser. A reload or a restart arrives while the previous session is still
    // being cleaned up, so wait for that to finish instead of letting the upgrade be refused.
    const current = store.slotFor(subject).current;
    if (current !== undefined && !current.snapshot.closed) {
      const deadline = wait(sessionWait);
      const outcome = await Promise.race([
        current.closed.then(() => 'closed' as const),
        deadline.promise,
      ]);
      deadline.cancel();
      if (outcome === 'timeout') return json(409, { error: 'busy' });
    }
    if (slotStatus(subject) === 'quarantined') return json(423, { error: 'quarantined' });
    const sessionId = crypto.randomUUID();
    const ticket = store.issueTicket(subject, sessionId);
    if (ticket === undefined) return json(429, { error: 'tickets' });
    const grant: SessionGrant = { sessionId, ticket };
    return json(201, grant);
  }

  async function handle(request: Request, server: UpgradeServer): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (request.headers.get('host') !== authority) return plain(421);
    const path = url.pathname;
    if (path === '/terminal') return terminal.handleUpgrade(request, server);
    const method = request.method;
    if (path === '/session') {
      if (method !== 'POST') return plain(405, { allow: 'POST' });
      const subject = store.identify(request);
      return subject === undefined
        ? json(401, { error: 'unauthenticated' })
        : createSession(request, subject);
    }
    if (path === '/session/status') {
      if (method !== 'GET') return plain(405, { allow: 'GET' });
      const subject = store.identify(request);
      return subject === undefined
        ? json(401, { error: 'unauthenticated' })
        : json(200, { slot: slotStatus(subject) });
    }
    if (method !== 'GET' && method !== 'HEAD') return plain(405, { allow: 'GET, HEAD' });
    if (path === '/' || path === '/index.html') return document(request, url, method);
    const file = files.get(normalize(path).split(sep).join('/'));
    if (file === undefined) return plain(404);
    return new Response(method === 'HEAD' ? null : Bun.file(file), {
      headers: { ...SECURITY_HEADERS },
    });
  }

  /**
   * The page itself. An enrolled browser gets it. Anyone else gets an explanation, and the one way
   * to enroll is a top-level navigation that carries the start token from the startup URL.
   */
  function document(request: Request, url: URL, method: string): Response {
    const token = url.searchParams.get('token');
    const identified = store.identify(request) !== undefined;
    if (identified && token !== null) {
      // Already enrolled: the token spends nothing, and the address bar is cleaned.
      return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, location: '/' } });
    }
    if (identified) {
      const file = files.get('/index.html') as string;
      return new Response(method === 'HEAD' ? null : Bun.file(file), {
        headers: { ...SECURITY_HEADERS },
      });
    }
    if (token === null || !isTopLevelNavigation(request)) {
      return page(
        401,
        'Open the start URL',
        'This terminal starts shells on this machine, so it needs the start URL the server printed when it started. Open that address in your browser.',
      );
    }
    if (!sameSecret(token, options.startToken)) {
      return page(
        403,
        'That start URL is not right',
        'The token in the address does not match this server. Use the start URL the server printed when it started.',
      );
    }
    if (admissionsLeft <= 0) {
      return page(
        403,
        'The start URL has been used',
        'It admits a limited number of browsers and they are all taken. To let another browser in, restart the server and use the new start URL.',
      );
    }
    const enrollment = store.enroll();
    if (!enrollment.ok) {
      return enrollment.reason === 'full'
        ? page(
            503,
            'The server is full',
            'Every browser it remembers has a session that cannot be ended safely, so it will not take another. Restart the server.',
          )
        : page(
            429,
            'Too many browsers',
            'Browsers are enrolling too fast. Wait a minute and try again.',
          );
    }
    admissionsLeft -= 1;
    return new Response(null, {
      status: 303,
      headers: { ...SECURITY_HEADERS, location: '/', 'set-cookie': enrollment.setCookie },
    });
  }

  return {
    origin,
    store,
    terminal,
    websocket: terminal.websocket,
    fetch: handle,
    close: () => terminal.close(),
  };
}
