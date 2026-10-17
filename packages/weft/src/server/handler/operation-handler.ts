import type { AuthContext } from '../authentication.ts';
import type { DiscoveryInfo } from '../discovery-info.ts';
import { handleJsonRpcHttpRequest } from '../json-rpc-http.ts';
import {
  createOperationRegistry,
  executeOperation,
  executeSubscription,
  type OperationRegistry,
  type RegistrableOperation,
} from '../operation-catalog.ts';
import type { ServerSentEventHeartbeatOptions } from '../operations/sse-stream.ts';
import type { Principal } from '../principal.ts';
import { GENERIC_SUBSCRIPTION_ROUTE_PREFIX, JSON_RPC_PATH } from '../route-model.ts';
import {
  buildPreflightResponse,
  decorateResponseWithCors,
  isPreflightRequest,
  resolveCorsPolicy,
  validateCorsOptions,
  type CorsOptions,
} from '../runtime/cors.ts';
import { authContextToPrincipal } from './auth-context-principal.ts';
import type { OperationHandlerAuthenticate } from './operation-handler-authentication.ts';
import {
  createOperationHandlerDocuments,
  type OperationHandlerDocuments,
} from './operation-handler-discovery.ts';
import {
  isAtOrUnder,
  resolveMounts,
  type OperationHandlerMount,
  type OperationHandlerMountContext,
} from './operation-handler-mounts.ts';
import {
  DEFAULT_MAX_STREAM_DURATION_MS,
  handleSubscriptionRequest,
} from './operation-handler-subscription.ts';
import { errorResponse, jsonResponse, negotiatedResponse } from './response-helpers.ts';

/**
 * Options for {@link createOperationHandler}.
 *
 * `Host` is whatever the registered operations read from `host` in their
 * `invoke` and `authorize` hooks. It is inferred from `host` alone, so an
 * operation that needs a capability the host lacks is a compile error here.
 */
export type OperationHandlerOptions<Host> = {
  /** The whole catalog this handler serves. Weft's own operations are not added. */
  readonly operations: ReadonlyArray<RegistrableOperation<NoInfer<Host>>>;
  /** Delivered as `host` to every `invoke` and `authorize` call. */
  readonly host: Host;
  /**
   * Resolves the caller. Omitted, every request is anonymous and only
   * `public` operations pass. See `createOperationHandlerAuthenticator` for
   * Weft's API-key and JWT schemes, including package `additionalScopes`.
   */
  readonly authenticate?: OperationHandlerAuthenticate;
  /** Same validation and defaults as `ServeOptions.cors`; omitted means no CORS headers. */
  readonly cors?: CorsOptions;
  /** Adapters that claim a path prefix ahead of catalog routing. */
  readonly mounts?: ReadonlyArray<OperationHandlerMount>;
  readonly discoveryInfo?: DiscoveryInfo;
  /** Maximum JSON-RPC request body size in bytes. Defaults to 1 MB. */
  readonly maxRequestBodyBytes?: number;
  /**
   * How long one Server-Sent Events subscription response may stream before
   * the handler ends it cleanly, so a client resumes with `Last-Event-ID`.
   * A positive integer number of milliseconds; defaults to fifteen minutes.
   * It applies to `GET /v1/subscriptions/:operationName` only.
   */
  readonly maxStreamDurationMs?: number;
  /**
   * Heartbeat interval and the timer and clock seam behind it. The
   * `maxStreamDurationMs` deadline is armed through the same `schedule`, so a
   * test drives both with one manual clock.
   */
  readonly heartbeat?: ServerSentEventHeartbeatOptions;
};

/** A fetch handler over a caller-supplied operation registry. */
export type OperationHandler = (request: Request) => Promise<Response>;

const HEALTH_PATH = '/v1/health';
const DOCUMENT_PATHS = ['/openapi.json', '/openrpc.json', '/asyncapi.json'] as const;
const PUBLIC_PATHS: ReadonlySet<string> = new Set([HEALTH_PATH, ...DOCUMENT_PATHS]);

function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`createOperationHandler: ${name} must be a positive integer (got ${value})`);
  }
}

function normalizedPathname(request: Request): string {
  const { pathname } = new URL(request.url);
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/**
 * Create a fetch handler that serves a caller-supplied operation registry with
 * Weft's transport plumbing and never reads an `Engine`.
 *
 * What it serves, and in what order a request is handled: CORS preflight,
 * authentication, mounts, then the catalog routes (`POST /jsonrpc`,
 * `GET /v1/subscriptions/:operationName` as Server-Sent Events with
 * `Last-Event-ID` replay, `GET /v1/health`, and the OpenAPI, OpenRPC, and
 * AsyncAPI documents generated from the registry alone), and finally CORS
 * decoration of the response.
 *
 * It does not serve `/mcp`, `/.well-known/*`, `/v1/metrics`, the workflow
 * WebSocket streams, or any remote-worker route; those need an `Engine` and
 * stay behind `serve()`. Rate limiting stays there too, since its key falls back
 * to the client address a fetch handler cannot see; put a limiter in front.
 *
 * A factory rather than a per-request function, so registry construction, CORS
 * validation, mount validation, and option validation fail once, synchronously,
 * before the first request.
 *
 * @example
 * ```ts
 * import { createOperationHandler, defineOperation } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const echo = defineOperation({
 *   name: 'probe.echo',
 *   mcpExposable: false,
 *   summary: 'Echo a message',
 *   destructive: false,
 *   inputSchema: z.object({ message: z.string() }),
 *   outputSchema: z.object({ message: z.string() }),
 *   access: { kind: 'public' },
 *   transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
 *   unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
 *   invoke: async ({ input }) => ({ message: input.message }),
 * });
 *
 * const handler = createOperationHandler({ operations: [echo], host: {} });
 * const response = await handler(new Request('http://localhost/v1/health'));
 * console.log(response.status); // 200
 * ```
 */
export function createOperationHandler<Host>(
  options: OperationHandlerOptions<Host>,
): OperationHandler {
  assertPositiveInteger(options.maxRequestBodyBytes, 'maxRequestBodyBytes');
  assertPositiveInteger(options.maxStreamDurationMs, 'maxStreamDurationMs');
  const authenticate = options.authenticate;
  const registry = createOperationRegistry<Host>(options.operations);
  const mounts = resolveMounts(options.mounts ?? []);
  const corsPolicy =
    options.cors === undefined
      ? undefined
      : (validateCorsOptions(options.cors, authenticate !== undefined),
        resolveCorsPolicy(options.cors, authenticate !== undefined));
  const documents = createOperationHandlerDocuments({
    registry,
    discoveryInfo: options.discoveryInfo,
    authenticates: authenticate !== undefined,
  });

  const handle = async (request: Request): Promise<Response> => {
    const pathname = normalizedPathname(request);
    const isPublic = PUBLIC_PATHS.has(pathname) || mounts.publicPaths.has(pathname);
    let authContext: AuthContext | undefined;
    if (authenticate !== undefined && !isPublic) {
      const outcome = await authenticate(request);
      if (outcome instanceof Response) return outcome;
      authContext = outcome;
    }
    const principal = authContextToPrincipal(authContext);

    const mount = mounts.match(pathname);
    if (mount !== undefined) {
      return mount.fetch(request, mountContext(registry, options.host, principal));
    }
    return routeCatalog({ request, pathname, principal, registry, documents, options });
  };

  return async (request) => {
    if (corsPolicy !== undefined && isPreflightRequest(request)) {
      return buildPreflightResponse(corsPolicy, request);
    }
    let response: Response;
    try {
      response = await handle(request);
    } catch (error) {
      console.error('Unhandled error in createOperationHandler', {
        method: request.method,
        path: new URL(request.url).pathname,
        error,
      });
      response = errorResponse('Internal server error', 500);
    }
    return corsPolicy === undefined
      ? response
      : decorateResponseWithCors(corsPolicy, request, response);
  };
}

function mountContext(
  registry: OperationRegistry,
  host: unknown,
  principal: Principal,
): OperationHandlerMountContext {
  const context = { principal, host, transport: 'http-rest', registry } as const;
  return {
    principal,
    dispatch: (operationName, input) => executeOperation(operationName, input, context),
    subscribe: (operationName, input) => executeSubscription(operationName, input, context),
  };
}

type CatalogRequest<Host> = {
  readonly request: Request;
  readonly pathname: string;
  readonly principal: Principal;
  readonly registry: OperationRegistry;
  readonly documents: OperationHandlerDocuments;
  readonly options: OperationHandlerOptions<Host>;
};

async function routeCatalog<Host>(catalog: CatalogRequest<Host>): Promise<Response> {
  const { request, pathname, options } = catalog;
  if (pathname === JSON_RPC_PATH) {
    return handleJsonRpcHttpRequest(request, {
      registry: catalog.registry,
      host: options.host,
      principal: catalog.principal,
      discoverDocument: catalog.documents.openRpc,
      ...(options.maxRequestBodyBytes === undefined
        ? {}
        : { maxBodyBytes: options.maxRequestBodyBytes }),
    });
  }
  if (isAtOrUnder(pathname, GENERIC_SUBSCRIPTION_ROUTE_PREFIX)) {
    return routeSubscription(catalog);
  }
  if (request.method === 'GET') {
    const response = routeGet(catalog);
    if (response !== null) return response;
  }
  return errorResponse(`Not found: ${request.method} ${pathname}`, 404);
}

function routeGet(
  catalog: Pick<CatalogRequest<unknown>, 'request' | 'pathname' | 'documents'>,
): Response | null {
  const { request, pathname, documents } = catalog;
  switch (pathname) {
    case HEALTH_PATH:
      return negotiatedResponse(request, { status: 'ok' });
    case '/openapi.json':
      return jsonResponse(documents.openApi());
    case '/openrpc.json':
      return jsonResponse(documents.openRpc());
    case '/asyncapi.json':
      return jsonResponse(documents.asyncApi());
    default:
      return null;
  }
}

function routeSubscription<Host>(catalog: CatalogRequest<Host>): Promise<Response> {
  const { request, pathname, options } = catalog;
  const rawName = pathname.slice(GENERIC_SUBSCRIPTION_ROUTE_PREFIX.length + 1);
  if (rawName === '' || rawName.includes('/')) {
    return Promise.resolve(errorResponse(`Not found: ${request.method} ${pathname}`, 404));
  }
  let operationName: string;
  try {
    operationName = decodeURIComponent(rawName);
  } catch {
    return Promise.resolve(errorResponse('Malformed route parameter', 400));
  }
  return handleSubscriptionRequest(request, operationName, {
    registry: catalog.registry,
    host: options.host,
    principal: catalog.principal,
    maxStreamDurationMs: options.maxStreamDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS,
    heartbeat: options.heartbeat,
  });
}
