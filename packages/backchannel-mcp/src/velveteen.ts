import {
  createOperationHandler,
  createOperationRegistry,
  type AuthenticatedPrincipal,
  type OperationFault,
  type OperationHandlerMountOperation,
  type OperationHandlerOptions,
} from '@lostgradient/backchannel';
import { createProtectedHttpHandler, type VerifiedGrant } from '@lostgradient/mcp/http';
import {
  createOperationMcpMount,
  isMcpTool,
  type OperationMcpMountOptions,
} from './operation-tools.ts';

/** The verified connector grant and the application's current authority for it. */
export type CatalogAuthority = {
  /** The authorization server advertised to MCP clients. */
  issuer: string;
  /** Verify a bearer credential and return its resource-bound grant. */
  verifyAccessToken(token: string): Promise<VerifiedGrant | null>;
  /** Resolve the subject's current principal and delegable permissions. */
  resolvePrincipal(grant: VerifiedGrant): Promise<{
    principal: AuthenticatedPrincipal;
    delegableScopes: readonly string[];
  } | null>;
  /** Serve issuer routes when the application hosts its own authorization server. */
  handle?(request: Request): Promise<Response>;
};

type CatalogOptions<Host> = Pick<OperationHandlerOptions<Host>, 'operations' | 'host'> & {
  basePath: string;
  publicOrigin: string;
  authenticateApi: NonNullable<OperationHandlerOptions<Host>['authenticate']>;
  mcp: {
    serverInfo: OperationMcpMountOptions['serverInfo'];
    authorization:
      | CatalogAuthority
      | {
          configure(options: {
            origin: string;
            resourcePath: string;
            scopes: string[];
          }): CatalogAuthority;
        };
    requiredScopes?: readonly string[];
  };
};

function alternatives(
  access: OperationHandlerMountOperation['access'],
): readonly (readonly string[])[] {
  const requirements =
    access.kind === 'scoped'
      ? [access.scopes]
      : access.kind === 'scopedAlternatives'
        ? access.alternatives
        : access.kind === 'optionalAuth'
          ? [access.authenticatedScopes]
          : [];
  return requirements.flatMap((requirement) =>
    requirement.kind === 'allOf'
      ? [[...requirement.scopes]]
      : requirement.scopes.map((scope) => [scope]),
  );
}

function canonicalPath(path: string): string {
  if (path !== '' && !/^\/(?:[^/?#\\]+)(?:\/[^/?#\\]+)*$/.test(path))
    throw new TypeError('Invalid catalog mount path');
  return path
    .split('/')
    .map((segment) => {
      if (!segment) return '';
      const decoded = decodeURIComponent(segment);
      if (!decoded || decoded === '.' || decoded === '..' || /[\\/]/.test(decoded))
        throw new TypeError('Invalid catalog mount path');
      return encodeURIComponent(decoded);
    })
    .join('/');
}

/** Register one catalog service and its protected discovery routes with Velveteen. */
export function mountCatalog<Host>(options: CatalogOptions<Host>) {
  const suppliedProfile = options.mcp.authorization;
  const capturedProfile =
    'configure' in suppliedProfile
      ? { configure: suppliedProfile.configure.bind(suppliedProfile) }
      : {
          issuer: suppliedProfile.issuer,
          verifyAccessToken: suppliedProfile.verifyAccessToken.bind(suppliedProfile),
          resolvePrincipal: suppliedProfile.resolvePrincipal.bind(suppliedProfile),
          ...(suppliedProfile.handle === undefined
            ? {}
            : { handle: suppliedProfile.handle.bind(suppliedProfile) }),
        };
  options = {
    ...options,
    basePath: canonicalPath(options.basePath),
    operations: options.operations.map((operation) => ({
      ...operation,
      access: structuredClone(operation.access),
      transports: { ...operation.transports },
      unknownKeyPolicy: { ...operation.unknownKeyPolicy },
      ...(operation.behavior === undefined
        ? {}
        : { behavior: structuredClone(operation.behavior) }),
      ...(operation.parameterizedAccess === undefined
        ? {}
        : { parameterizedAccess: structuredClone(operation.parameterizedAccess) }),
      ...(operation.tags === undefined ? {} : { tags: [...operation.tags] }),
      ...(operation.conflictReasonTokens === undefined
        ? {}
        : { conflictReasonTokens: [...operation.conflictReasonTokens] }),
      ...(operation.mcpTool === undefined ? {} : { mcpTool: { ...operation.mcpTool } }),
      ...(operation.producibleFaults === undefined
        ? {}
        : { producibleFaults: [...operation.producibleFaults] }),
    })),
    mcp: {
      ...options.mcp,
      authorization: capturedProfile,
      serverInfo: { ...options.mcp.serverInfo },
      ...(options.mcp.requiredScopes === undefined
        ? {}
        : { requiredScopes: [...options.mcp.requiredScopes] }),
    },
  };
  const profile = options.mcp.authorization;
  const allowedProbe: OperationFault = {
    code: 'Forbidden',
    message: 'policy probe',
    data: { reason: 'policy probe' },
  };
  const probeRegistry = createOperationRegistry(options.operations, {
    interceptors: [async () => ({ ok: false, fault: allowedProbe })],
  });
  const scopes = [
    ...new Set(
      options.operations.flatMap((operation) =>
        isMcpTool(operation) ? alternatives(operation.access).flat() : [],
      ),
    ),
  ];
  const api = createOperationHandler({
    host: options.host,
    operations: options.operations,
    authenticate: options.authenticateApi,
  });
  const issuerPath = new URL(
    'configure' in profile ? options.publicOrigin : profile.issuer,
  ).pathname.replace(/\/$/, '');
  return {
    [options.basePath]: {
      rootPaths(base: string) {
        const resourcePath = `${canonicalPath(base)}${options.basePath}/mcp`;
        return [
          `/.well-known/oauth-protected-resource${resourcePath}`,
          ...('configure' in profile || profile.handle
            ? [
                `/.well-known/oauth-authorization-server${issuerPath}`,
                ...['authorize', 'token', 'register', 'revoke'].map(
                  (path) => `${issuerPath}/oauth/${path}`,
                ),
              ]
            : []),
        ];
      },
      start(base: string) {
        const resourcePath = `${canonicalPath(base)}${options.basePath}/mcp`;
        const authorization =
          'configure' in profile
            ? profile.configure({ origin: options.publicOrigin, resourcePath, scopes })
            : profile;
        const metadataPath = `/.well-known/oauth-protected-resource${resourcePath}`;
        const protectedHttp = createProtectedHttpHandler({
          origin: options.publicOrigin,
          resourcePath,
          issuer: authorization.issuer,
          scopes,
          verifyAccessToken: (token) => authorization.verifyAccessToken(token),
          resolvePrincipal: (grant) => authorization.resolvePrincipal(grant),
          async dispatch(request, context) {
            const admission = await context.requireScopes(options.mcp.requiredScopes ?? []);
            if (!admission.ok) return admission.response;
            const headers = new Headers(request.headers);
            headers.delete('authorization');
            const url = new URL(request.url);
            url.pathname = '/mcp';
            const principal = admission.principal.principal;
            const effectiveScopes = new Set(
              context.grant.scopes.filter(
                (scope) =>
                  admission.principal.delegableScopes.includes(scope) &&
                  principal.scopes.has(scope),
              ),
            );
            const effectivePrincipal = {
              ...principal,
              scopes: effectiveScopes,
              hasScope: (scope: string) => effectiveScopes.has(scope),
            };
            const handler = createOperationHandler({
              host: options.host,
              operations: options.operations,
              authenticate: async () => ({
                method: effectivePrincipal.method === 'jwt' ? 'jwt' : 'api-key',
                principal: effectivePrincipal,
              }),
              mounts: [
                createOperationMcpMount({
                  oauth: true,
                  serverInfo: options.mcp.serverInfo,
                  async scopeChallenge(operation, _context, input, signal) {
                    const latest = await context.requireScopes([]);
                    if (!latest.ok) return {};
                    const currentPrincipal = latest.principal.principal;
                    const candidates = alternatives(operation.access);
                    const grantable = candidates.filter((candidate) =>
                      candidate.every(
                        (scope) =>
                          latest.principal.delegableScopes.includes(scope) &&
                          currentPrincipal.scopes.has(scope),
                      ),
                    );
                    const choice =
                      grantable.find((candidate) =>
                        candidate.every((scope) => context.grant.scopes.includes(scope)),
                      ) ?? grantable[0];
                    if (choice && choice.some((scope) => !context.grant.scopes.includes(scope))) {
                      const authorizedScopes = new Set(
                        latest.principal.delegableScopes.filter((scope) =>
                          currentPrincipal.scopes.has(scope),
                        ),
                      );
                      const policyPrincipal = {
                        ...currentPrincipal,
                        scopes: authorizedScopes,
                        hasScope: (scope: string) => authorizedScopes.has(scope),
                      };
                      const probe = await probeRegistry.get(operation.name)!.dispatch(input, {
                        principal: policyPrincipal,
                        host: options.host,
                        transport: 'mcp',
                        registry: probeRegistry,
                        signal,
                      });
                      if (probe.ok)
                        return {
                          fault: { code: 'EngineFailure', message: 'internal error', data: {} },
                        };
                      if (probe.fault !== allowedProbe) return { fault: probe.fault };
                    }
                    const result = await context.requireScopes(choice ?? []);
                    if (result.ok) {
                      const fresh = result.principal.principal;
                      const effective = new Set(
                        context.grant.scopes.filter(
                          (scope) =>
                            result.principal.delegableScopes.includes(scope) &&
                            fresh.scopes.has(scope),
                        ),
                      );
                      Object.assign(effectivePrincipal, fresh, {
                        scopes: effective,
                        hasScope: (scope: string) => effective.has(scope),
                      });
                      if (fresh.workspace === undefined) delete effectivePrincipal.workspace;
                      return undefined;
                    }
                    const challenge = result.response.headers.get('www-authenticate');
                    return challenge
                      ? {
                          challenge: `${challenge}, error_description="Additional permission is required"`,
                        }
                      : {};
                  },
                }),
              ],
            });
            return handler(
              new Request(url, {
                method: request.method,
                headers,
                body: request.body,
                signal: request.signal,
                duplex: 'half',
              } as RequestInit),
            );
          },
        });
        let closed = false;
        const fetch = async (request: Request) => {
          if (closed) return new Response('Catalog disposed', { status: 503 });
          const url = new URL(request.url);
          if (url.pathname === metadataPath) return protectedHttp(request);
          if (url.pathname === '/mcp') {
            url.pathname = resourcePath;
            return protectedHttp(new Request(url, request));
          }
          if (
            authorization.handle &&
            (url.pathname.startsWith('/.well-known/') ||
              url.pathname.startsWith(`${issuerPath}/oauth/`))
          )
            return authorization.handle(request);
          return api(request);
        };
        return {
          fetch,
          close: () => {
            closed = true;
          },
        };
      },
    },
  };
}
