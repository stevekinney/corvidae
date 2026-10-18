/**
 * The Interborough host: one loopback origin that serves the browser application, Weft's engine
 * API for the Engine console, and a Bureau.
 *
 * The state lives in Bungalow's directory (`~/.interborough`, or `INTERBOROUGH_HOME`): the
 * Bureau runs on Bun SQLite at Bungalow's database path with `BureauOptions.id` set to Bungalow's
 * `deploymentId`, so a restart finds its tasks, sessions, schedules, and goals where it left them.
 * Agent definitions are code, so they are rebuilt from {@link createSeededAgents} on every start.
 *
 * Every request acts as the one local caller, `anonymous:local`, holding every Weft scope and
 * every Bureau scope. There is no sign-in: the host binds `127.0.0.1` only, and the Bureau handler
 * (`unauthenticatedAccess: 'allow'`) serves every request as that caller. A host that listened on
 * anything but loopback would hand every operation to whoever could reach the port, which is why
 * the hostname is not an option.
 *
 * Weft's server would report its own shared `unauthenticated-local` caller for a request with no
 * credential, so it listens on a second, private loopback port that answers only a per-process
 * key mapped to `anonymous:local`, and the public listener relays to it (`engine-proxy.ts`). Both
 * halves of the application therefore name the same caller.
 *
 * The routes on the public origin:
 *
 * - `/api/*`, `/v1/*`, `/jsonrpc`, `/mcp`, and Weft's discovery documents: Weft's engine
 *   operations, relayed to its server.
 * - `/bureau/*`: Bureau's operations, served by `createBureauHandler` with the `/bureau` prefix
 *   removed. They do not share Weft's root because both catalogs claim `/jsonrpc` and `/v1/…`.
 * - `/assets/*` and the client routes: the built application, with `index.html` for every route
 *   the client router owns.
 *
 * @module host
 */

import { randomBytes } from 'node:crypto';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBungalow, type Bungalow, type BungalowEnvironment } from '@lostgradient/bungalow';
import { createBureau, createBureauHandler, type Bureau } from '@lostgradient/bureau';
import { stopWhen } from '@lostgradient/operative';
import {
  BunSQLiteStorage,
  Engine,
  serve,
  type RegistryAgnosticEngine,
  type ServeOptions,
  type Storage,
  type WeftServer,
} from '@lostgradient/weft';

import { routes as clientRoutes } from '../app/routes.ts';
import {
  createLocalAuthentication,
  isEngineRequestPath,
  relayRequest,
  webSocketRelayData,
  webSocketRelayHandlers,
  type WebSocketRelayData,
} from './engine-proxy.ts';
import { processEnvironment, resolvePort } from './environment-configuration.ts';
import { allowedHosts, createRequestGuard } from './request-guard.ts';
import {
  createSeededAgents,
  createSeededGenerate,
  createSeededValidators,
  PUBLISHED_AGENT_NAMES,
  seedBureau,
  type SeededAgents,
} from './seed.ts';

/** The application name Bungalow keys the state directory, `INTERBOROUGH_HOME`, and lock on. */
export const APPLICATION_NAME = 'interborough';

/** The only address the host listens on. */
const LOOPBACK = '127.0.0.1';

/** The Bungalow secret that signs the approvals the seeded `tool-runner` raises. */
export const APPROVAL_SECRET_KEY = 'approval-secret';

/** The path prefix under which the Bureau handler is mounted. */
export const BUREAU_PATH_PREFIX = '/bureau';

/** Where `bun scripts/build.ts` writes the application: `build/` at the package root. */
export const DEFAULT_BUILD_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'build',
);

export type HostOptions = {
  /** The environment to read `INTERBOROUGH_HOME` and `INTERBOROUGH_PORT` from. Defaults to the process's. */
  readonly environment?: BungalowEnvironment;
  /** The port to listen on; `0` asks for a free one. Defaults to `INTERBOROUGH_PORT`, then 7234. */
  readonly port?: number;
  /** The built application to serve. Defaults to `build/` at the package root. */
  readonly buildDirectory?: string;
  /**
   * Builds the engine behind the Engine console over the storage the Bureau uses. The default is
   * an engine that registers no workflows and runs no background tasks, because the Bureau's
   * own engine already recovers its runs and fires its timers on this storage, and a second
   * engine doing the same would act on them twice. A host that wants the console to start and
   * inspect workflows of its own supplies an engine that registers them.
   */
  readonly createConsoleEngine?: (
    storage: Storage,
  ) => RegistryAgnosticEngine | Promise<RegistryAgnosticEngine>;
  /** The few Weft server settings a host may tune for the engine API it relays. */
  readonly engineServer?: Pick<ServeOptions, 'cancellationGracePeriodMs'>;
  /** Whether to create the seeded schedule and goal. Agents are always defined. Defaults to `true`. */
  readonly seed?: boolean;
};

export type Host = {
  /** The origin the host listens on, `http://127.0.0.1:<port>/`. */
  readonly url: URL;
  /** The Bureau, running on Bungalow's database. */
  readonly bureau: Bureau<SeededAgents>;
  /** The engine behind the Engine console, over the same storage as the Bureau. */
  readonly engine: RegistryAgnosticEngine;
  /** Weft's server, which owns the listening socket. */
  readonly server: WeftServer;
  /** The Bureau's identifier, which is Bungalow's `deploymentId`. */
  readonly deploymentId: string;
  /** The SQLite database file the Bureau and the engine share. */
  readonly databasePath: string;
  /** Stop listening, shut the Bureau and the engine down, close the database, and release the lock. */
  close(): Promise<void>;
};

/** The installation's approval secret, created on first use and kept in Bungalow's `secrets/`. */
function approvalSecret(bungalow: Bungalow): string {
  const existing = bungalow.readSecret(APPROVAL_SECRET_KEY);
  if (existing !== undefined) return existing;
  const created = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  bungalow.writeSecret(APPROVAL_SECRET_KEY, created);
  return created;
}

/** Where the `/bureau` prefix comes off a request before the Bureau handler sees it. */
function withoutBureauPrefix(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(BUREAU_PATH_PREFIX.length) || '/';
  return new Request(url, request);
}

function missingBuild(): Response {
  return new Response(
    'Interborough has not been built. Run `bun run --filter=@lostgradient/interborough build`.',
    { status: 503 },
  );
}

/** The files under `/assets/`, refusing any path that leaves the build directory. */
async function assetResponse(buildDirectory: string, pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response('Malformed asset path.', { status: 400 });
  }
  // The route is `/assets/*`, so only the build's `assets/` directory is reachable: `..` may not
  // climb out of it to `index.html` or anything else in the build.
  const assets = resolvePath(buildDirectory, 'assets');
  const path = resolvePath(buildDirectory, `.${decoded}`);
  if (!path.startsWith(`${assets}${sep}`)) return new Response('Not found', { status: 404 });
  const asset = Bun.file(path);
  if (!(await asset.exists())) return new Response('Not found', { status: 404 });
  return new Response(asset, {
    headers: { 'cache-control': 'public, max-age=31536000, immutable' },
  });
}

type PublicRoutes = Bun.Serve.Routes<WebSocketRelayData, string>;

/**
 * The route table for the application: `index.html` for every client route, and the build's
 * assets. The routes are the client router's own patterns, so a route added there is served here.
 */
function applicationRoutes(buildDirectory: string, refuse: Guard): PublicRoutes {
  const shell = async (): Promise<Response> => {
    const page = Bun.file(join(buildDirectory, 'index.html'));
    if (!(await page.exists())) return missingBuild();
    return new Response(page, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  };
  const table: PublicRoutes = {
    '/assets/*': {
      GET: (request) =>
        refuse(request) ?? assetResponse(buildDirectory, new URL(request.url).pathname),
    },
  };
  for (const route of clientRoutes) {
    table[route.pattern] = { GET: (request) => refuse(request) ?? shell() };
  }
  return table;
}

/** A request guard: the refusal to send, or `undefined` to let the request through. */
type Guard = (request: Request) => Response | undefined;

/** Where the engine's private listener is, once it is up. */
type EngineUpstream = { readonly url: string; readonly key: string };

/** Start the host. The caller owns it and must `close()` it. */
export async function startHost(options: HostOptions = {}): Promise<Host> {
  const environment = options.environment ?? processEnvironment();
  const bungalow: Bungalow = openBungalow({ name: APPLICATION_NAME, environment });
  const held: Held = { bungalow };
  try {
    const storage = new BunSQLiteStorage(bungalow.database);
    held.storage = storage;
    // No provider key is read and no model is called: every agent answers from a script.
    const bureau = await createBureau({
      id: bungalow.deploymentId,
      agents: createSeededAgents(approvalSecret(bungalow)),
      generate: createSeededGenerate(),
      // A run that makes no tool call is finished. Without this the Bureau's own runs, such as a
      // schedule's fire, keep asking the model until the step limit.
      stopWhen: stopWhen.noToolCalls(),
      validators: createSeededValidators(),
      storage,
    });
    held.bureau = bureau;
    if (options.seed !== false) {
      await seedBureau(bureau, {
        read: (key) => bungalow.readSecret(key),
        write: (key, value) => bungalow.writeSecret(key, value),
      });
    }
    const engine = await (options.createConsoleEngine?.(storage) ??
      new Engine({ storage, backgroundTasks: 'manual' }));
    held.engine = engine;

    const bureauHandler = createBureauHandler(bureau, {
      unauthenticatedAccess: 'allow',
      publish: PUBLISHED_AGENT_NAMES,
    });
    let engineUpstream: ((upstream: EngineUpstream) => void) | undefined;
    const upstream = new Promise<EngineUpstream>((resolve) => {
      engineUpstream = resolve;
    });
    // Every route, the relay, and every WebSocket upgrade go through one guard (`request-guard.ts`).
    let listening: Bun.Server<WebSocketRelayData> | undefined;
    const refuse = createRequestGuard(() => listening?.port ?? 0);
    const publicServer = Bun.serve<WebSocketRelayData>({
      hostname: LOOPBACK,
      port: options.port ?? resolvePort(environment),
      routes: {
        ...applicationRoutes(options.buildDirectory ?? DEFAULT_BUILD_DIRECTORY, refuse),
        [`${BUREAU_PATH_PREFIX}/*`]: (request: Request) =>
          refuse(request) ?? bureauHandler(withoutBureauPrefix(request)),
      },
      async fetch(request, listener) {
        const refusal = refuse(request);
        if (refusal !== undefined) return refusal;
        if (!isEngineRequestPath(new URL(request.url).pathname)) {
          return new Response('Not found', { status: 404 });
        }
        const { url, key } = await upstream;
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const data = webSocketRelayData(request, url, key);
          if (data !== undefined && listener.upgrade(request, { data })) return undefined;
          return new Response('WebSocket upgrade failed', { status: 500 });
        }
        return relayRequest(request, url, key);
      },
      websocket: webSocketRelayHandlers,
    });
    held.publicServer = publicServer;
    listening = publicServer;
    const publicPort = publicServer.port;
    if (publicPort === undefined) throw new Error('The public listener has no port.');

    const key = randomBytes(32).toString('hex');
    const server = serve({
      engine,
      hostname: LOOPBACK,
      port: 0,
      auth: createLocalAuthentication(key),
      // Discovery documents name absolute URLs, and they must name the origin a browser used, not
      // the private listener the relay forwards to.
      publicOrigin: `http://${LOOPBACK}:${publicPort}`,
      trustedHosts: allowedHosts(publicPort),
      ...options.engineServer,
    });
    held.server = server;
    await server.ready;
    engineUpstream?.({ url: server.url, key });
    return {
      url: new URL(`http://${LOOPBACK}:${publicPort}/`),
      bureau,
      engine,
      server,
      deploymentId: bungalow.deploymentId,
      databasePath: bungalow.database,
      close: () => (held.closing ??= teardown(held)),
    };
  } catch (error) {
    await teardown(held).catch(() => undefined);
    throw error;
  }
}

/** What the host holds while it starts and runs, so a failure at any step can release the rest. */
type Held = {
  readonly bungalow: Bungalow;
  storage?: BunSQLiteStorage;
  bureau?: Bureau<SeededAgents>;
  engine?: RegistryAgnosticEngine;
  server?: WeftServer;
  publicServer?: Bun.Server<WebSocketRelayData>;
  closing?: Promise<void>;
};

/** Release everything the host holds, in the reverse of the order it took it, whatever failed. */
async function teardown(held: Held): Promise<void> {
  const failures: unknown[] = [];
  const step = async (release: (() => unknown) | undefined): Promise<void> => {
    try {
      await release?.();
    } catch (error) {
      failures.push(error);
    }
  };
  await step(held.publicServer && (() => held.publicServer?.stop(true)));
  await step(held.server && (() => held.server?.stop()));
  await step(held.bureau && (() => held.bureau?.shutdown()));
  await step(held.engine && (() => held.engine?.[Symbol.asyncDispose]()));
  await step(held.storage && (() => held.storage?.[Symbol.dispose]()));
  await step(() => held.bungalow.close());
  if (failures.length > 0) {
    throw new AggregateError(failures, 'The Interborough host did not shut down cleanly.');
  }
}
