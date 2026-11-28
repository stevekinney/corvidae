import { createApiKeyManagementHandler } from '@lostgradient/api-key-settings/backchannel';
import {
  guardWorkspaceResponse,
  principalFromApiKey,
  type AuthenticatedPrincipal,
  type OperationHandlerAuthenticate,
} from '@lostgradient/backchannel';
import type { OperationMcpMountOptions } from '@lostgradient/backchannel-mcp';
import {
  withWorkspaceMembership,
  type WorkspaceMembership,
  type WorkspaceMembershipOptions,
} from '@lostgradient/bureau';
import { createApiKeys, type ApiKeyMetadata } from '@lostgradient/credentials/api-keys';
import {
  createBrowserSignIn,
  type BrowserSignInOptions,
} from '@lostgradient/credentials/browser-sign-in';
import { createProtectedHttpHandler } from '@lostgradient/mcp/http';
import { hostedOAuth, OAuthStore } from '@lostgradient/mcp/oauth';
import type { Storage } from '@lostgradient/storage';
import type { ServerHooks } from '@lostgradient/velveteen/server';
import { keySettingsMembership, keySettingsProtocolRequest } from './api-key-settings.ts';
import { createConnectedAppsSettings } from './connected-apps-settings.ts';
import type { HostAuthority } from './host-authority.ts';

/** Reviewed Bureau reads eligible for connector grants; additions require reviewing the operation. */
const CONNECTOR_READ_OPERATIONS = new Set([
  'bureau.tasks.get',
  'bureau.tasks.list',
  'bureau.reviews.get',
  'bureau.reviews.list',
]);

/** Trusted deployment configuration; browser input cannot choose its provider or directory. */
export type SharedBrowserSignInOptions = {
  readonly origin: string;
  readonly provider: BrowserSignInOptions['provider'];
  readonly resolveAccount: BrowserSignInOptions['resolveAccount'];
  readonly scopes: (membership: WorkspaceMembership) => Promise<readonly string[]>;
  readonly oauth: {
    readonly resourcePath: string;
    readonly scopes: readonly string[];
    readonly startingScopes: readonly string[];
    readonly scopeDescriptions: Readonly<Record<string, string>>;
    readonly delegableScopes: (membership: WorkspaceMembership) => Promise<readonly string[]>;
    readonly operationScopes: Readonly<Record<string, string>>;
  };
  readonly keyManagement?: {
    readonly targets: (
      manager: WorkspaceMembership,
    ) => Promise<{ subject: string; scopes: string[] }[]>;
    readonly allowedActions: (
      manager: WorkspaceMembership,
      key: ApiKeyMetadata,
    ) => Promise<('rotate' | 'revoke')[]>;
    readonly overlapCutoff: () => number;
  };
  readonly createPrivateServer?: (hooks: ServerHooks) => Promise<{
    fetch(request: Request): Promise<Response>;
    dispose(): Promise<void>;
  }>;
};

/** Bind a Velveteen request and its same-origin internal reads to one live browser identity. */
export function sharedBrowserServerHooks(
  authority: HostAuthority,
  origin: string,
  port: () => number,
): ServerHooks {
  return {
    async handle({ event, resolve }) {
      const context = await authority.authenticate(event.request);
      if (context instanceof Response) return context;
      const principal = context.principal;
      if (principal?.method !== 'browser-session' || !principal.workspace)
        return new Response('Forbidden', { status: 403 });
      event.locals['interboroughWorkspace'] = principal.workspace;
      const response = await resolve(event);
      const guarded = await authority.release(event.request, 'private-owned', response);
      const headers = new Headers(guarded.headers);
      headers.set('cache-control', 'private, no-store');
      return new Response(guarded.body, {
        status: guarded.status,
        statusText: guarded.statusText,
        headers,
      });
    },
    async handleFetch({ event, request, fetch: next }) {
      if (new URL(request.url).origin !== origin) return next(request);
      let body: string | undefined;
      if (request.method === 'POST' && new URL(request.url).pathname === '/jsonrpc') {
        body = await request.clone().text();
        let call: unknown;
        try {
          call = JSON.parse(body);
        } catch {
          return new Response('Forbidden', { status: 403 });
        }
        if (
          typeof call !== 'object' ||
          call === null ||
          Array.isArray(call) ||
          !Object.hasOwn(call, 'method') ||
          typeof Reflect.get(call, 'method') !== 'string' ||
          !['bureau.reviews.list', 'bureau.reviews.get'].includes(Reflect.get(call, 'method'))
        )
          return new Response('Forbidden', { status: 403 });
      } else if (!['GET', 'HEAD'].includes(request.method)) {
        return new Response('Forbidden', { status: 403 });
      }
      const context = await authority.authenticate(event.request);
      if (context instanceof Response) return context;
      const workspace = context.principal?.workspace;
      if (context.principal?.method !== 'browser-session' || !workspace)
        return new Response('Forbidden', { status: 403 });
      const target = new URL(request.url);
      target.protocol = 'http:';
      target.host = `127.0.0.1:${port()}`;
      const headers = new Headers(request.headers);
      headers.delete('authorization');
      headers.delete('x-api-key');
      headers.set('host', new URL(origin).host);
      headers.set('cookie', event.request.headers.get('cookie') ?? '');
      if (body !== undefined) headers.set('origin', origin);
      headers.set(
        'x-interborough-expected-identity',
        encodeURIComponent(
          JSON.stringify([workspace.workspaceId, workspace.actorId, workspace.membershipRevision]),
        ),
      );
      const response = await fetch(target, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: event.signal,
      });
      return authority.release(event.request, 'private-owned', response);
    },
  };
}

/** Compose sessions and consent over the same atomic workspace store. */
export function createSharedBrowserSignIn(
  options: SharedBrowserSignInOptions,
  workspace: WorkspaceMembershipOptions,
  storage: Storage,
) {
  options = {
    ...options,
    oauth: {
      ...options.oauth,
      scopes: [...options.oauth.scopes],
      startingScopes: [...options.oauth.startingScopes],
      scopeDescriptions: { ...options.oauth.scopeDescriptions },
      operationScopes: { ...options.oauth.operationScopes },
    },
    ...(options.keyManagement === undefined ? {} : { keyManagement: { ...options.keyManagement } }),
  };
  workspace = { ...workspace };
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.origin !== options.origin)
    throw new TypeError('Shared browser sign-in requires an HTTPS origin');
  const resource = new URL(options.oauth.resourcePath, origin);
  if (
    !options.oauth.resourcePath.startsWith('/') ||
    options.oauth.resourcePath.startsWith('//') ||
    resource.origin !== origin.origin ||
    resource.pathname !== options.oauth.resourcePath ||
    resource.search ||
    resource.hash
  )
    throw new TypeError('Invalid shared MCP resource path');
  if (
    options.oauth.resourcePath !== '/bureau/mcp' ||
    options.oauth.scopes.some((scope) => !scope.endsWith(':read')) ||
    Object.entries(options.oauth.operationScopes).some(
      ([name, scope]) =>
        !CONNECTOR_READ_OPERATIONS.has(name) || !options.oauth.scopes.includes(scope),
    )
  )
    throw new TypeError('Shared MCP grants must name allowlisted read scopes');
  const membership = async (subject: string) => {
    const resolve = withWorkspaceMembership(
      async () => ({
        method: 'browser-session',
        principal: { ...principalFromApiKey({ subject, scopes: [] }), method: 'browser-session' },
      }),
      workspace,
    );
    const result = await resolve(new Request(origin));
    return result instanceof Response ? null : (result.principal?.workspace ?? null);
  };
  const browser = createBrowserSignIn({
    publicOrigin: options.origin,
    storage,
    workspaceId: workspace.workspaceId,
    cookieName: 'interborough_session',
    provider: options.provider,
    resolveAccount: options.resolveAccount,
    resolveMembership: async ({ subjectId, workspaceId }) =>
      workspaceId === workspace.workspaceId ? membership(subjectId) : null,
  });
  const store = new OAuthStore(storage);
  const principalForGrant = async ({ subject, tenant }: { subject: string; tenant: string }) => {
    const current = tenant === workspace.workspaceId ? await membership(subject) : null;
    return current
      ? { delegableScopes: [...(await options.oauth.delegableScopes(current))] }
      : null;
  };
  const oauth = hostedOAuth({
    issuer: options.origin,
    resource: resource.href,
    scopes: [...options.oauth.scopes],
    startingScopes: [...options.oauth.startingScopes],
    scopeDescriptions: { ...options.oauth.scopeDescriptions },
    store,
    identity: browser.oauthIdentity(store, principalForGrant),
  });
  const matches = (request: Request) => {
    const host = request.headers.get('host')?.toLowerCase();
    return host === origin.host || (origin.port === '' && host === `${origin.hostname}:443`);
  };
  const publicRequest = (request: Request) => {
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.host = origin.host;
    return new Request(url, request);
  };
  const authenticate: OperationHandlerAuthenticate = async (request) => {
    const authorization = request.headers.get('authorization');
    if (authorization !== null) {
      const path = new URL(request.url).pathname;
      const match = /^Bearer ([A-Za-z0-9._~+\x2f-]+=*)$/i.exec(authorization);
      if ((path !== '/mcp' && path !== '/bureau/mcp') || !match)
        return new Response('Authentication required', { status: 401 });
      const grant = await oauth.verifyAccessToken(match[1]!);
      if (!grant || grant.audience !== resource.href || grant.tenant !== workspace.workspaceId)
        return new Response('Authentication required', { status: 401 });
      const current = await membership(grant.subject);
      if (!current) return new Response('Authentication required', { status: 401 });
      return {
        method: 'connector-token',
        principal: {
          ...principalFromApiKey({ subject: grant.subject, scopes: [...grant.scopes] }),
          method: 'connector-token',
          workspace: current,
        },
      };
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.get('origin') !== origin.origin
    )
      return new Response('Forbidden', { status: 403 });
    const session = await browser.currentSession(request);
    if (!session) return new Response('Authentication required', { status: 401 });
    const current = await membership(session.subjectId);
    if (!current) return new Response('Workspace membership required', { status: 403 });
    const scopes = await options.scopes(current);
    const principal: AuthenticatedPrincipal = {
      ...principalFromApiKey({ subject: session.subjectId, scopes: [...scopes] }),
      method: 'browser-session',
      workspace: current,
    };
    return { method: 'browser-session', principal };
  };
  const manageKeys = async (request: Request, resolve: OperationHandlerAuthenticate) => {
    if (request.headers.has('authorization') || request.headers.has('x-api-key'))
      return new Response('Forbidden', { status: 403 });
    const first = await resolve(request);
    if (first instanceof Response) return first;
    const original = first.principal;
    const initialMember = keySettingsMembership(original, 'shared');
    if (!original || !initialMember) return new Response('Forbidden', { status: 403 });
    const current = async () => {
      const result = await resolve(request);
      if (result instanceof Response) return null;
      const principal = result.principal;
      const member = keySettingsMembership(principal, 'shared');
      if (
        principal === undefined ||
        member === undefined ||
        member.workspaceId !== initialMember.workspaceId ||
        member.actorId !== initialMember.actorId ||
        member.owner !== initialMember.owner ||
        member.membershipRevision !== initialMember.membershipRevision ||
        [...original.scopes].some((scope) => !principal.hasScope(scope))
      )
        return null;
      return member;
    };
    const targets = async () => {
      const member = await current();
      if (!member || !options.keyManagement) return [];
      const available = await options.keyManagement.targets(member);
      return available.map((target) => ({
        ...target,
        scopes: target.scopes.filter((scope) => original.scopes.has(scope)),
      }));
    };
    const keys = createApiKeys({
      storage,
      resolveAuthority: async ({ workspaceId, subject }) => {
        if (workspaceId !== workspace.workspaceId) return null;
        const available = await targets();
        const target = available.find((entry) => entry.subject === subject);
        return target ? { workspaceId, subject, scopes: target.scopes } : null;
      },
      authorizeManagement: async (_actor, target) => {
        const available = await targets();
        return (
          target.workspaceId === workspace.workspaceId &&
          available.some(
            (entry) =>
              entry.subject === target.subject &&
              target.scopes.every((scope) => entry.scopes.includes(scope)),
          )
        );
      },
    });
    const handler = createApiKeyManagementHandler({
      publicOrigin: options.origin,
      authenticateSession: async () =>
        (await current()) ? first : new Response('Forbidden', { status: 403 }),
      guardWrite: (write) => browser.validWrite(publicRequest(write)),
      host: {
        keys,
        currentManager: async () =>
          (await current()) !== null && options.keyManagement !== undefined,
        targets: async () => targets(),
        allowedActions: async (_principal, key) => {
          const member = await current();
          return member && options.keyManagement
            ? options.keyManagement.allowedActions(member, key)
            : [];
        },
        overlapCutoff: () => options.keyManagement?.overlapCutoff() ?? 0,
      },
    });
    const response = await handler(keySettingsProtocolRequest(publicRequest(request)));
    return guardWorkspaceResponse(response, async () => (await current()) !== null);
  };
  const { connectionAccess, manageConnections } = createConnectedAppsSettings({
    oauth,
    origin: options.origin,
    permittedConnectorScopes: new Set(Object.values(options.oauth.operationScopes)),
    guardWrite: (write) => browser.validWrite(publicRequest(write)),
  });
  const operationFilter: NonNullable<OperationMcpMountOptions['operationFilter']> = (
    operation,
    context,
  ) => {
    if (context.principal.method !== 'connector-token') return true;
    const scope = Object.hasOwn(options.oauth.operationScopes, operation.name)
      ? options.oauth.operationScopes[operation.name]
      : undefined;
    return (
      scope !== undefined &&
      CONNECTOR_READ_OPERATIONS.has(operation.name) &&
      !operation.destructive &&
      operation.behavior?.kind !== 'command' &&
      context.principal.hasScope(scope)
    );
  };
  const scopeChallenge: NonNullable<OperationMcpMountOptions['scopeChallenge']> = async (
    operation,
    context,
  ) => (operationFilter(operation, context) ? undefined : {});
  const protectedMcp = (request: Request, dispatch: (request: Request) => Promise<Response>) =>
    createProtectedHttpHandler({
      origin: options.origin,
      resourcePath: options.oauth.resourcePath,
      issuer: options.origin,
      scopes: options.oauth.scopes,
      verifyAccessToken: oauth.verifyAccessToken,
      resolvePrincipal: async (grant) => {
        const current =
          grant.tenant === workspace.workspaceId ? await membership(grant.subject) : null;
        return current
          ? { delegableScopes: [...(await options.oauth.delegableScopes(current))] }
          : null;
      },
      dispatch: async (protectedRequest) => {
        if (protectedRequest.method === 'POST') {
          let payload: unknown;
          try {
            payload = await protectedRequest.clone().json();
          } catch {
            return new Response('Invalid MCP request', { status: 400 });
          }
          if (
            typeof payload !== 'object' ||
            payload === null ||
            Array.isArray(payload) ||
            !Object.hasOwn(payload, 'method') ||
            ![
              'initialize',
              'notifications/initialized',
              'ping',
              'tools/list',
              'tools/call',
            ].includes(String(Reflect.get(payload, 'method')))
          )
            return new Response('Forbidden', { status: 403 });
        }
        return dispatch(protectedRequest);
      },
    })(publicRequest(request));
  return {
    browser,
    oauth,
    matches,
    publicRequest,
    authenticate,
    manageKeys,
    manageConnections,
    connectionAccess,
    operationFilter,
    scopeChallenge,
    protectedMcp,
  };
}

/** Register only the shared browser's routes on its configured origin. */
export function sharedBrowserRoutes(
  shared: ReturnType<typeof createSharedBrowserSignIn> | undefined,
  privateServer: { fetch(request: Request): Promise<Response> } | undefined,
  ordinaryDocument: (request: Request) => Response | Promise<Response>,
  candidateAssets?: (request: Request) => Response | Promise<Response>,
) {
  const localPage = (request: Request) =>
    privateServer?.fetch(request) ?? ordinaryDocument(request);
  const serveAsset = async (
    request: Request,
    privateAsset: (request: Request) => Response | Promise<Response>,
  ): Promise<Response> => {
    if (privateServer !== undefined) {
      const response = await privateAsset(request);
      if (response.status !== 404 || candidateAssets === undefined) return response;
      await response.body?.cancel();
    }
    return candidateAssets?.(request) ?? new Response('Not found', { status: 404 });
  };
  const localAsset = (request: Request) => serveAsset(request, localPage);
  const localRoutes = {
    '/settings/api-keys': { GET: localPage, HEAD: localPage },
    '/settings/connected-apps': { GET: localPage, HEAD: localPage },
    '/_assets/*': { GET: localAsset, HEAD: localAsset },
  };
  if (!shared) return localRoutes;
  const onOrigin =
    (handler: (request: Request) => Response | Promise<Response>) => (request: Request) =>
      shared.matches(request) ? handler(request) : new Response('Not found', { status: 404 });
  const signIn = onOrigin((request) => shared.browser.fetch(shared.publicRequest(request)));
  const oauth = onOrigin((request) => shared.oauth.handle(shared.publicRequest(request)));
  const routes = {
    '/auth/sign-in': { GET: signIn },
    '/auth/callback': { GET: signIn },
    '/auth/sign-out': { POST: signIn },
    '/auth/session': {
      GET: onOrigin(async (request) => {
        const session = await shared.browser.currentSession(request);
        if (!session) return new Response('Authentication required', { status: 401 });
        return Response.json(
          { csrfToken: session.csrfToken },
          { headers: { 'cache-control': 'private, no-store' } },
        );
      }),
    },
    '/.well-known/oauth-authorization-server': { GET: oauth },
    '/.well-known/oauth-protected-resource/bureau/mcp': {
      GET: onOrigin((request) =>
        shared.protectedMcp(request, async () => new Response(null, { status: 404 })),
      ),
    },
    '/oauth/register': { POST: oauth },
    '/oauth/authorize': { GET: oauth, POST: oauth },
    '/oauth/token': { POST: oauth },
    '/oauth/revoke': { POST: oauth },
  };
  if (!privateServer) {
    return {
      ...routes,
      '/reviews': {
        GET: (request: Request) =>
          shared.matches(request)
            ? new Response('Reviews unavailable', { status: 503 })
            : ordinaryDocument(request),
      },
    };
  }
  const page = onOrigin((request) => privateServer.fetch(shared.publicRequest(request)));
  const settingsPage = (request: Request) =>
    shared.matches(request) ? page(request) : localPage(request);
  const asset = (request: Request) =>
    serveAsset(request, shared.matches(request) ? page : localPage);
  return {
    ...routes,
    '/settings/api-keys': { GET: settingsPage, HEAD: settingsPage, POST: page },
    '/settings/connected-apps': { GET: settingsPage, HEAD: settingsPage, POST: page },
    '/reviews': {
      GET: (request: Request) =>
        shared.matches(request) ? page(request) : ordinaryDocument(request),
    },
    '/_assets/*': { GET: asset, HEAD: asset },
    '/_remote/*': { POST: page },
  };
}
