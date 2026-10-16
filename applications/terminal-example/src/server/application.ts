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
import { SessionStore } from './session-store.ts';

/** How long `POST /session` waits for the previous session of the same browser to finish cleanup. */
export const DEFAULT_SESSION_WAIT_MILLISECONDS = 15_000;
const MAXIMUM_REQUEST_BODY_BYTES = 1024;

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
  const store = options.store ?? new SessionStore();
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
    const text = await request.text();
    if (text.length > MAXIMUM_REQUEST_BODY_BYTES) return json(413, { error: 'too-large' });
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
    const requested = path === '/' ? '/index.html' : normalize(path).split(sep).join('/');
    const file = files.get(requested);
    if (file === undefined) return plain(404);
    const headers: Record<string, string> = { ...SECURITY_HEADERS };
    if (requested === '/index.html' && store.identify(request) === undefined) {
      headers['set-cookie'] = store.enroll();
    }
    return new Response(method === 'HEAD' ? null : Bun.file(file), { headers });
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
