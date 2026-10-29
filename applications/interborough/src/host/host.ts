/**
 * The Interborough host: one loopback origin that serves the browser application, Weft's engine
 * API for the Engine console, and a Bureau.
 *
 * The state lives in Bungalow's directory (`~/.interborough`, or `INTERBOROUGH_HOME`): the
 * Bureau runs on Bun SQLite at Bungalow's database path with `BureauOptions.id` set to Bungalow's
 * `deploymentId`, so a restart finds its tasks, sessions, schedules, and goals where it left them.
 * The seeded agents are code, so they are rebuilt from {@link createSeededAgents} on every start.
 * Other agents are Markdown files in `agents/` under the home, which the Bureau loads and watches
 * (COR-1524): `researcher.md` is the agent `researcher`, its `model` is `<provider>/<model>` from
 * the catalog below, and its `tools` come from {@link createAgentFileTools}.
 *
 * Memory is governed memory over the same database (`memory.ts`), embedded with a hashing
 * embedder that needs no model provider, so every agent, the seeded ones included, remembers across
 * its owner's chats.
 *
 * The model catalog holds the models of the providers in Bungalow's `configuration.json` that have
 * an API key in its secrets (`providers.ts`). The seeded agents still answer from a script.
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
 * - `/bureau/*`: Bureau's operations and its AG-UI mount (`/bureau/ag-ui`, which Chat talks to),
 *   served by `createBureauHandler` with the `/bureau` prefix removed. They do not share Weft's root because both catalogs claim `/jsonrpc` and `/v1/…`.
 * - `/host/paths`: where the host keeps the files a person edits by hand, so the agent editor and
 *   the Workflows pages can show an agent's file path and a workflow's, and the agent editor can
 *   say where to configure a model provider: the configuration file, and the file that holds each
 *   provider's API key.
 * - `/assets/*` and the client routes: the built application, with `index.html` for every route
 *   the client router owns.
 *
 * @module host
 */

import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  openBungalow,
  type Bungalow,
  type BungalowEnvironment,
  type DatabaseLocation,
} from '@lostgradient/bungalow';
import {
  createBureau,
  createBureauHandler,
  createDurableAssetStorage,
  resolveProviderGenerate,
  type Bureau,
  type SettingsOptions,
} from '@lostgradient/bureau';
import { agentFileDirectory, workflowFileDirectory } from '@lostgradient/bureau/sources';
import { typesafeJev, type GenerateFunction } from '@lostgradient/operative';
import { type Storage } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import {
  serve,
  type RegistryAgnosticEngine,
  type ServeOptions,
  type WeftServer,
} from '@lostgradient/weft';

import { routes as clientRoutes } from '../app/routes.ts';
import { HOST_PATHS_ROUTE } from '../lib/host-paths.ts';
import {
  createDevReload,
  DEV_RELOAD_ROUTE,
  injectDevReloadClient,
  type DevReload,
} from './dev-reload.ts';
import {
  createLocalAuthentication,
  isEngineRequestPath,
  relayRequest,
  webSocketRelayData,
  webSocketRelayHandlers,
  type WebSocketRelayData,
} from './engine-proxy.ts';
import { processEnvironment, resolvePort } from './environment-configuration.ts';
import { contentDirectoryPath, sqliteDatabasePath } from './locations.ts';
import { mcpAppMounts } from './mcp-app-mounts.ts';
import { createHostMemory } from './memory.ts';
import {
  createCatalogGenerate,
  loadProviders,
  PROVIDER_NAMES,
  PROVIDER_SECRET_KEYS,
  TYPESAFE_SECRET_KEY,
  type ModelSelection,
} from './providers.ts';
import { allowedHosts, createRequestGuard } from './request-guard.ts';
import {
  createAgentFileTools,
  createSeededAgents,
  createSeededValidators,
  PUBLISHED_AGENT_NAMES,
  seedBureau,
  SEEDED_AGENT_NAMES,
  type SeededAgents,
} from './seed.ts';
import { isShellNavigation } from './shell-request.ts';

/** The application name Bungalow keys the state directory, `INTERBOROUGH_HOME`, and lock on. */
export const APPLICATION_NAME = 'interborough';

/** The only address the host listens on. */
const LOOPBACK = '127.0.0.1';

/** The Bungalow secret that signs the approvals the seeded `tool-runner` raises. */
export const APPROVAL_SECRET_KEY = 'approval-secret';

/** The directory of agent files under the Interborough home: `researcher.md` is the agent `researcher`. */
export const AGENT_DIRECTORY_NAME = 'agents';

/**
 * The directory of workflow files under the Interborough home: `nightly-digest.json` is the
 * workflow `nightly-digest` (COR-1527). Its steps may name any agent, the files in `agents/`
 * included, and it runs as the deployment's one owner.
 */
export const WORKFLOW_DIRECTORY_NAME = 'workflows';

/** The path prefix under which the Bureau handler is mounted. */
export const BUREAU_PATH_PREFIX = '/bureau';

/** Where `bun scripts/build.ts` writes the application: `build/` at the package root. */
export const DEFAULT_BUILD_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'build',
);

/** Agents a host serves beside the seeded ones, and which of them it publishes. */
export type ExtraAgents = {
  readonly agents: Readonly<Record<string, SeededAgents['assistant']>>;
  readonly published: readonly string[];
};

export type HostOptions = {
  /** The environment to read `INTERBOROUGH_HOME` and `INTERBOROUGH_PORT` from. Defaults to the process's. */
  readonly environment?: BungalowEnvironment;
  /** The port to listen on; `0` asks for a free one. Defaults to `INTERBOROUGH_PORT`, then 7234. */
  readonly port?: number;
  /** The built application to serve. Defaults to `build/` at the package root. */
  readonly buildDirectory?: string;
  /**
   * Replaces the engine behind the Engine console, for a host whose console must start and inspect
   * workflows of its own (the end-to-end fixtures). The default is the Bureau's durable engine:
   * the one that owns the Bureau's runs, so a cancel from the console is fenced by their owner
   * and the live feed sees them. A replacement is a second engine over the same storage and the
   * host disposes it, so it must register its own workflows and run no background tasks of its
   * own on the Bureau's runs.
   */
  readonly createConsoleEngine?: (
    storage: Storage,
  ) => RegistryAgnosticEngine | Promise<RegistryAgnosticEngine>;
  /** Replaces the scripted generate of the seeded `assistant` agent. For tests that need a run to stay in flight. */
  readonly generate?: GenerateFunction;
  /** The few Weft server settings a host may tune for the engine API it relays. */
  readonly engineServer?: Pick<
    ServeOptions,
    'cancellationGracePeriodMs' | 'workerReconnectGracePeriodMs'
  >;
  /**
   * Agents to define and publish beside the seeded ones, for tests that need an agent of their own
   * without changing the seed. `published` names the ones the Bureau handler serves.
   */
  readonly extraAgents?: ExtraAgents;
  /** Whether to create the seeded schedule and goal. Agents are always defined. Defaults to `true`. */
  readonly seed?: boolean;
  /**
   * Replaces Bureau's provider resolver, which {@link Host.generateFor} calls with the provider,
   * model, and API key from Bungalow's secret. For tests that stand a fake client in for the SDK.
   */
  readonly resolveProviderGenerate?: typeof resolveProviderGenerate;
  /** Receives the host's startup warnings. Defaults to `console.warn`. */
  readonly warn?: (message: string) => void;
  /**
   * Which runtime settings the Bureau holds to their code options (`settings.locked`), so the
   * settings page shows them read-only. A person's host locks none; the end-to-end host locks one,
   * so the page's locked state is exercised against the real Bureau.
   */
  readonly settings?: SettingsOptions;
  /**
   * Whether this is the development host (`dev.ts`). It serves the reload stream at
   * `/__dev/reload` and injects its client into `index.html`, and {@link Host.notifyRebuilt}
   * sends the reload. A host without it has no such route and serves the page as built. Defaults
   * to `false`.
   */
  readonly development?: boolean;
};

export type Host = {
  /** The origin the host listens on, `http://127.0.0.1:<port>/`. */
  readonly url: URL;
  /** The Bureau, running on Bungalow's database. */
  readonly bureau: Bureau<SeededAgents>;
  /** The engine behind the Engine console: the Bureau's durable engine unless the host was given another. */
  readonly engine: RegistryAgnosticEngine;
  /** Weft's server, which owns the listening socket. */
  readonly server: WeftServer;
  /** The Bureau's identifier, which is Bungalow's `deploymentId`. */
  readonly deploymentId: string;
  /** Where the Bureau and the engine share their database: the SQLite file, for the one kind the host supports. */
  readonly database: DatabaseLocation;
  /**
   * The generate for an agent assigned a model in the Bureau's catalog, resolved through Bureau's
   * provider path with the API key from Bungalow's secrets. Throws for a model the catalog does
   * not hold.
   */
  generateFor(selection: ModelSelection): GenerateFunction;
  /**
   * Tell every open page of a development host that the build has been replaced, so each reloads.
   * Call it after a successful rebuild. It does nothing on a host started without `development`.
   */
  notifyRebuilt(): void;
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

/**
 * The application's one page, `index.html`, which the client router takes over. A development host
 * injects the reload client into it as it serves it (`dev-reload.ts`); the file in the build never
 * holds it.
 */
function shellResponder(buildDirectory: string, development: boolean): () => Promise<Response> {
  return async () => {
    const page = Bun.file(join(buildDirectory, 'index.html'));
    if (!(await page.exists())) return missingBuild();
    return new Response(development ? injectDevReloadClient(await page.text()) : page, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  };
}

type PublicRoutes = Bun.Serve.Routes<WebSocketRelayData, string>;

/**
 * The route table for the application: `index.html` for every client route, and the build's
 * assets. The routes are the client router's own patterns, so a route added there is served here.
 */
function applicationRoutes(
  buildDirectory: string,
  refuse: Guard,
  shell: () => Promise<Response>,
): PublicRoutes {
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
  // The seeded agents are defined last, so an extra agent that took a seeded name would be replaced
  // without a word. That is a mistake in whoever named it, so it stops the host before anything opens.
  for (const name of SEEDED_AGENT_NAMES) {
    if (options.extraAgents?.agents !== undefined && name in options.extraAgents.agents) {
      throw new Error(
        `The extra agent "${name}" has the name of a seeded agent, which would replace it. Give it another name.`,
      );
    }
  }
  const environment = options.environment ?? processEnvironment();
  const bungalow: Bungalow = await openBungalow({ name: APPLICATION_NAME, environment });
  const held: Held = { bungalow };
  try {
    const storage = new BunSQLiteStorage(sqliteDatabasePath(bungalow.database));
    held.storage = storage;
    // The catalog holds the models of the providers `configuration.json` names that have a key in
    // the secrets, and nothing else. The Bureau is created with exactly these rows, so no boot step
    // plans against a provider that is not configured. The seeded agents still answer from a
    // script.
    const providers = await loadProviders({
      configurationLocation: bungalow.configurationLocation,
      readConfiguration: () => bungalow.readConfiguration(),
      readSecret: (key) => bungalow.readSecret(key),
      warn: options.warn ?? ((message) => console.warn(message)),
    });
    const generateFor = (selection: ModelSelection): GenerateFunction =>
      createCatalogGenerate(selection, {
        rows: providers.rows,
        apiKeys: providers.apiKeys,
        resolveProviderGenerate: options.resolveProviderGenerate ?? resolveProviderGenerate,
      });
    const agentDirectory = contentDirectoryPath(bungalow.content(AGENT_DIRECTORY_NAME));
    const workflowDirectory = contentDirectoryPath(bungalow.content(WORKFLOW_DIRECTORY_NAME));
    // The TypeSafe key, when the secrets hold one, gives Bureau a decision model for the kinds Jev
    // serves. It is read here and handed to the model, which keeps it in memory.
    const typesafeKey = bungalow.readSecret(TYPESAFE_SECRET_KEY)?.trim();
    const bureau = await createBureau({
      id: bungalow.deploymentId,
      agents: {
        ...options.extraAgents?.agents,
        ...createSeededAgents(approvalSecret(bungalow), options.generate),
      },
      // A session run of a seeded agent is offered `requestHumanInput`, which `request-human-input`
      // calls to park for an operator's answer.
      validators: createSeededValidators(),
      ...(typesafeKey === undefined || typesafeKey === ''
        ? {}
        : { decisions: { model: typesafeJev({ apiKey: typesafeKey }) } }),
      // A file's `model` is a row of this catalog, so it runs with the key in the secrets.
      models: {
        catalog: providers.rows,
        generate: (row) => {
          const provider = PROVIDER_NAMES.find((name) => name === row.provider);
          if (provider === undefined) {
            throw new Error(`The ${row.provider} provider is not one this host offers.`);
          }
          return generateFor({ provider, model: row.model });
        },
      },
      storage,
      // Governed memory (COR-1546): an agent remembers across every chat its owner has with it, and
      // the Memory page lists, searches, forgets, and corrects what it remembers.
      memory: createHostMemory(storage),
      // Managed assets (COR-1547): the handler serves uploads and an asset's content, and a chat
      // attachment is one, so the Bureau keeps them in the same database as everything else.
      assets: { storage: createDurableAssetStorage(storage) },
      // Agent files: Markdown files in Bungalow's `agents/` directory are agents (COR-1524). A
      // file's `model` is a row of the `models` catalog.
      agentSource: agentFileDirectory(agentDirectory, { tools: createAgentFileTools() }),
      // Workflow files: JSON files in Bungalow's `workflows/` directory are agent-authored
      // workflows (COR-1527), registered with the Bureau's engine and run on their schedules.
      workflowSource: workflowFileDirectory(workflowDirectory),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
    });
    held.bureau = bureau;
    if (options.seed !== false) {
      await seedBureau(bureau, storage);
    }
    // The console serves the engine that owns the Bureau's runs. A second engine over the same
    // storage holds no lease on them, so its cancel would not be fenced by their owner and its
    // live feed would not see them.
    let engine = bureau.durableEngine();
    if (engine === undefined) throw new Error('The Bureau composed no durable engine.');
    if (options.createConsoleEngine !== undefined) {
      engine = await options.createConsoleEngine(storage);
      held.replacementEngine = engine;
    }

    const bureauHandler = createBureauHandler(bureau, {
      unauthenticatedAccess: 'allow',
      publish: [...PUBLISHED_AGENT_NAMES, ...(options.extraAgents?.published ?? [])],
      // Chat runs over AG-UI: the mount starts, attaches to, and resumes a run, and takes the
      // `RunAgentInput` Chat's transport sends.
      agUi: {},
      // An MCP host (Claude Desktop or Claude Code) observes and steers this Bureau's work at
      // `/bureau/mcp` (COR-839). It is Bureau's own endpoint, not the engine's `/mcp`: Bureau owns
      // what a local caller does as `anonymous:local`, which the engine's relayed principal is not.
      // Its run inspector is an MCP App (COR-910): the page is built here, in this application, and
      // handed to the adapter as an injected `ui://` resource linked to `bureau.tasks.inspect`.
      mcp: await mcpAppMounts(),
    });
    let engineUpstream: ((upstream: EngineUpstream) => void) | undefined;
    const upstream = new Promise<EngineUpstream>((resolve) => {
      engineUpstream = resolve;
    });
    // Every route, the relay, and every WebSocket upgrade go through one guard (`request-guard.ts`).
    let listening: Bun.Server<WebSocketRelayData> | undefined;
    const refuse = createRequestGuard(() => listening?.port ?? 0);
    const buildDirectory = options.buildDirectory ?? DEFAULT_BUILD_DIRECTORY;
    const devReload = options.development === true ? createDevReload() : undefined;
    if (devReload !== undefined) held.devReload = devReload;
    const shell = shellResponder(buildDirectory, devReload !== undefined);
    const publicServer = Bun.serve<WebSocketRelayData>({
      hostname: LOOPBACK,
      port: options.port ?? resolvePort(environment),
      // Bun closes a connection that sends nothing for 10 seconds by default. The pages hold
      // streams that are quiet for longer: the engine's event feed pings every 15 seconds, and a
      // chat run waiting on a person's answer sends nothing at all. A stream cut that way ends
      // without its terminating chunk, and Chromium logs `ERR_INCOMPLETE_CHUNKED_ENCODING` for each
      // one (COR-1643). The listener is loopback-only behind the request guard, so a connection
      // that stays open costs nothing a timeout would save.
      idleTimeout: 0,
      routes: {
        ...applicationRoutes(buildDirectory, refuse, shell),
        // The development reload stream. A production host registers no route, so the path is a 404.
        ...(devReload === undefined
          ? {}
          : {
              [DEV_RELOAD_ROUTE]: {
                GET: (request: Request) => refuse(request) ?? devReload.connect(),
              },
            }),
        [`${BUREAU_PATH_PREFIX}/*`]: (request: Request) =>
          refuse(request) ?? bureauHandler(withoutBureauPrefix(request)),
        // Where a person edits what the host keeps by hand. The pages show an agent's file path and
        // a workflow's.
        [HOST_PATHS_ROUTE]: {
          GET: (request: Request) =>
            refuse(request) ??
            Response.json({
              agentDirectory,
              workflowDirectory,
              configurationFile: bungalow.configurationLocation,
              providers: PROVIDER_NAMES.map((name) => ({
                name,
                secretFile: bungalow.secretLocation(PROVIDER_SECRET_KEYS[name]),
              })),
            }),
        },
      },
      async fetch(request, listener) {
        const refusal = refuse(request);
        if (refusal !== undefined) return refusal;
        if (!isEngineRequestPath(new URL(request.url).pathname)) {
          // An address no client route names: the router renders its not-found view inside the
          // shell. A miss on an asset, the engine, or the Bureau stays a 404.
          if (isShellNavigation(request)) return shell();
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
      // Signs the worker start-override previews an operator spends on a terminal run's restart.
      // Derived from this process's key, so a restart of the host invalidates every outstanding
      // token, which is the safe direction, and nothing secret is written to disk.
      workerStartOverrideSigningSecret: deriveStartOverrideSigningSecret(key),
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
      database: bungalow.database,
      generateFor,
      notifyRebuilt: () => devReload?.notify(),
      close: () => (held.closing ??= teardown(held)),
    };
  } catch (error) {
    await teardown(held).catch(() => undefined);
    throw error;
  }
}

/** The signing secret for worker start-override previews, derived from the per-process key. */
export function deriveStartOverrideSigningSecret(key: string): string {
  return createHash('sha256').update(`interborough:worker-start-override:${key}`).digest('hex');
}

/** What the host holds while it starts and runs, so a failure at any step can release the rest. */
type Held = {
  readonly bungalow: Bungalow;
  storage?: BunSQLiteStorage;
  bureau?: Bureau<SeededAgents>;
  replacementEngine?: RegistryAgnosticEngine;
  server?: WeftServer;
  publicServer?: Bun.Server<WebSocketRelayData>;
  devReload?: DevReload;
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
  // End the reload streams first, so no page is left reading a host that is going away.
  await step(held.devReload && (() => held.devReload?.close()));
  await step(held.publicServer && (() => held.publicServer?.stop(true)));
  await step(held.server && (() => held.server?.stop()));
  await step(held.bureau && (() => held.bureau?.shutdown({ policy: 'detach' })));
  await step(held.replacementEngine && (() => held.replacementEngine?.[Symbol.asyncDispose]()));
  await step(held.storage && (() => held.storage?.[Symbol.dispose]()));
  await step(() => held.bungalow.close());
  if (failures.length > 0) {
    throw new AggregateError(failures, 'The Interborough host did not shut down cleanly.');
  }
}
