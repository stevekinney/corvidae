import {
  ANONYMOUS_LOCAL_OWNER,
  authorizeWorkspaceClass,
  BUREAU_SCOPES,
  withWorkspaceMembership,
  type WorkspaceMembershipOptions,
  type WorkspaceOperationClass,
} from '@lostgradient/bureau';
import {
  createOperationHandlerAuthenticator,
  guardWorkspaceResponse,
  unauthenticatedLocalAuthContext,
  type AuthConfig,
  type OperationHandlerAuthenticate,
} from '@lostgradient/weft';

/** Trusted host composition; request payloads cannot select either member. */
export type HostWorkspaceAuthentication = {
  /** Verify credentials before resolving workspace membership. */
  readonly authentication: AuthConfig;
  /** Resolve current members in the one workspace bound to this host's storage. */
  readonly workspace: WorkspaceMembershipOptions;
};

/** Request-local authentication and current class authorization. */
export type HostAuthority = {
  /** Resolve current authority while pinning the request's original actor and workspace. */
  readonly authenticate: OperationHandlerAuthenticate;
  /** Refuse a route class before invoking its handler. */
  authorize(
    request: Request,
    classification: WorkspaceOperationClass,
  ): Promise<Response | undefined>;
  /** Revalidate before returning a response and releasing each private body chunk. */
  release(
    request: Request,
    classification: WorkspaceOperationClass,
    response: Response,
  ): Promise<Response>;
};

/** Resolve every request from verified credentials and the host's workspace directory. */
export async function createHostAuthority(
  workspace: WorkspaceMembershipOptions,
  authentication?: AuthConfig,
  allowLocal = false,
): Promise<HostAuthority> {
  const credentials =
    authentication === undefined
      ? undefined
      : createOperationHandlerAuthenticator(authentication, { additionalScopes: BUREAU_SCOPES });
  await credentials?.ready;
  const local: OperationHandlerAuthenticate = async () => {
    const context = unauthenticatedLocalAuthContext();
    return {
      ...context,
      ...(context.principal === undefined
        ? {}
        : { principal: { ...context.principal, subject: ANONYMOUS_LOCAL_OWNER } }),
    };
  };
  const resolve = withWorkspaceMembership(
    credentials === undefined
      ? local
      : (request) =>
          allowLocal && !request.headers.has('authorization') && !request.headers.has('x-api-key')
            ? local(request)
            : credentials(request),
    workspace,
  );
  const identities = new WeakMap<Request, ReturnType<typeof unauthenticatedLocalAuthContext>>();
  const authenticate: OperationHandlerAuthenticate = async (request) => {
    const resolved = await resolve(request);
    if (resolved instanceof Response) return resolved;
    const identity = resolved.principal?.workspace;
    const previous = identities.get(request)?.principal?.workspace;
    if (
      identity === undefined ||
      (previous !== undefined &&
        (previous.workspaceId !== identity.workspaceId ||
          previous.actorId !== identity.actorId ||
          previous.owner !== identity.owner))
    )
      return new Response('Workspace identity changed', { status: 403 });
    identities.set(request, resolved);
    return resolved;
  };
  const authority: HostAuthority = {
    authenticate,
    async authorize(request, classification) {
      const context = await authenticate(request);
      if (context instanceof Response) return context;
      if (context.principal === undefined)
        return new Response('Authentication required', { status: 401 });
      const decision = authorizeWorkspaceClass(classification, context.principal);
      return decision.allowed ? undefined : new Response(decision.reason, { status: 403 });
    },
    release: (request, classification, response) =>
      guardWorkspaceResponse(
        response,
        async () => (await authority.authorize(request, classification)) === undefined,
      ),
  };
  return authority;
}

/** Keep the separately credentialed A2A service beside injected user credentials. */
export async function combineHostAuthentication(
  authentication: AuthConfig | undefined,
  a2a: AuthConfig | undefined,
): Promise<AuthConfig | undefined> {
  if (authentication === undefined) return a2a;
  if (a2a === undefined) return authentication;
  if (authentication.jwt !== undefined || authentication.mtls !== undefined)
    throw new TypeError('Workspace host composition currently requires API-key authentication.');
  const authenticators = [a2a, authentication].map((configuration) =>
    createOperationHandlerAuthenticator(
      { ...configuration, auditSink: () => {} },
      { additionalScopes: BUREAU_SCOPES },
    ),
  );
  await Promise.all(authenticators.map((authenticate) => authenticate.ready));
  return {
    ...(authentication.auditSink === undefined ? {} : { auditSink: authentication.auditSink }),
    resolveApiKeyPrincipal: async (key) => {
      const request = new Request('http://localhost/', { headers: { 'x-api-key': key } });
      for (const authenticate of authenticators) {
        const context = await authenticate(request);
        if (!(context instanceof Response) && context.principal !== undefined)
          return context.principal;
      }
      return null;
    },
  };
}
