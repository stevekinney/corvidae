import {
  createOperationHandlerAuthenticator,
  guardWorkspaceResponse,
  unauthenticatedLocalAuthContext,
  type AuthConfig,
  type OperationHandlerAuthenticate,
} from '@lostgradient/backchannel';
import {
  ANONYMOUS_LOCAL_OWNER,
  authorizeWorkspaceClass,
  BUREAU_SCOPES,
  withWorkspaceMembership,
  type WorkspaceMembership,
  type WorkspaceMembershipOptions,
  type WorkspaceOperationClass,
} from '@lostgradient/bureau';
import { WEFT_SCOPE_VOCABULARY } from '@lostgradient/weft';
import { A2A_SUBJECT } from './a2a-authentication.ts';
import {
  createHostMutationContext,
  HostMutationError,
  parseHostMutationInput,
  type HostMutationContext,
} from './host-mutation-context.ts';
import { localWorkspaceMembership } from './workspace-principal.ts';

/** Trusted host composition; request payloads cannot select either member. */
export type HostWorkspaceAuthentication = {
  /** Verify credentials before resolving workspace membership. */
  readonly authentication?: AuthConfig;
  /** Resolve current members in the one workspace bound to this host's storage. */
  readonly workspace: WorkspaceMembershipOptions;
  /**
   * Whether this member can share memory with another eligible owner. The directory keeps owner
   * identities private; a missing or failed answer hides the action.
   */
  readonly memorySharingAvailable?: ((member: WorkspaceMembership) => Promise<boolean>) | undefined;
};

/** Include the durable A2A service identity independently of key issuance. */
export function hostWorkspaceWithA2a(
  workspaceId: string,
  configured?: WorkspaceMembershipOptions,
): WorkspaceMembershipOptions {
  const local = localWorkspaceMembership(workspaceId, true);
  if (configured === undefined) return local;
  if (configured.workspaceId !== workspaceId)
    throw new Error('The authentication directory belongs to another workspace.');
  const serviceOwner = 'api-key:' + encodeURIComponent(A2A_SUBJECT);
  return {
    ...configured,
    resolveMembership: async (credential) =>
      credential.method === 'api-key' && credential.subject === A2A_SUBJECT
        ? local.resolveMembership(credential)
        : configured.resolveMembership(credential),
    resolveOwnerMembership: async (owner) =>
      (await (owner === serviceOwner ? local : configured).resolveOwnerMembership?.(owner)) ?? null,
  };
}

/** Request-local authentication and current class authorization. */
export type HostAuthority = {
  /** Verify a credential before Bureau resolves its own workspace snapshot. */
  readonly authenticateCredential: OperationHandlerAuthenticate;
  /** Resolve current authority while pinning the request's original actor and workspace. */
  readonly authenticate: OperationHandlerAuthenticate;
  /** Refuse a route class before invoking its handler. */
  authorize(
    request: Request,
    classification: WorkspaceOperationClass,
  ): Promise<Response | undefined>;
  /** Resolve a transport mutation without accepting client-selected identity. */
  mutation(
    request: Request,
    input: Readonly<Record<string, unknown>>,
  ): Promise<HostMutationContext>;
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
  browser?: {
    readonly matches: (request: Request) => boolean;
    readonly authenticate: OperationHandlerAuthenticate;
  },
  managedService?: AuthConfig,
  allowUnrecognizedLocalCredential?: () => Promise<boolean>,
): Promise<HostAuthority> {
  const credentials =
    authentication === undefined
      ? undefined
      : createOperationHandlerAuthenticator(authentication, {
          scopeVocabulary: WEFT_SCOPE_VOCABULARY,
          additionalScopes: BUREAU_SCOPES,
        });
  const service =
    managedService === undefined
      ? undefined
      : createOperationHandlerAuthenticator(
          { ...managedService, auditSink: () => {} },
          { scopeVocabulary: WEFT_SCOPE_VOCABULARY, additionalScopes: BUREAU_SCOPES },
        );
  await Promise.all([credentials?.ready, service?.ready]);
  const local: OperationHandlerAuthenticate = async () => {
    const context = unauthenticatedLocalAuthContext(WEFT_SCOPE_VOCABULARY);
    return {
      ...context,
      ...(context.principal === undefined
        ? {}
        : { principal: { ...context.principal, subject: ANONYMOUS_LOCAL_OWNER } }),
    };
  };
  const authenticateCredential: OperationHandlerAuthenticate = async (request) => {
    if (browser?.matches(request)) return browser.authenticate(request);
    const presented = request.headers.has('authorization') || request.headers.has('x-api-key');
    if (presented && service) {
      const verified = await service(request);
      if (!(verified instanceof Response)) return verified;
    }
    if (allowLocal && !presented) return local(request);
    if (!credentials) return new Response('Authentication required', { status: 401 });
    const context = await credentials(request);
    if (context instanceof Response && allowLocal && (await allowUnrecognizedLocalCredential?.()))
      return local(request);
    if (
      service &&
      !(context instanceof Response) &&
      context.principal?.method === 'api-key' &&
      context.principal.subject === A2A_SUBJECT
    )
      return new Response('Authentication required', { status: 401 });
    return context;
  };
  const resolve = withWorkspaceMembership(authenticateCredential, workspace);
  const identities = new WeakMap<Request, ReturnType<typeof unauthenticatedLocalAuthContext>>();
  const authenticate: OperationHandlerAuthenticate = async (request) => {
    const resolved = await resolve(request);
    if (resolved instanceof Response) return resolved;
    const identity = resolved.principal?.workspace;
    const previousPrincipal = identities.get(request)?.principal;
    const previous = previousPrincipal?.workspace;
    if (
      identity === undefined ||
      (previous !== undefined &&
        (previous.workspaceId !== identity.workspaceId ||
          previous.actorId !== identity.actorId ||
          previous.owner !== identity.owner ||
          (resolved.principal?.method === 'browser-session' &&
            (previous.membershipRevision !== identity.membershipRevision ||
              [...(previousPrincipal?.scopes ?? [])].some(
                (scope) => !resolved.principal?.hasScope(scope),
              )))))
    )
      return new Response('Workspace identity changed', { status: 403 });
    identities.set(request, resolved);
    return resolved;
  };
  const authority: HostAuthority = {
    authenticateCredential,
    authenticate,
    async authorize(request, classification) {
      const context = await authenticate(request);
      if (context instanceof Response) return context;
      if (context.principal === undefined)
        return new Response('Authentication required', { status: 401 });
      const decision = authorizeWorkspaceClass(classification, context.principal);
      return decision.allowed ? undefined : new Response(decision.reason, { status: 403 });
    },
    async mutation(request, input) {
      const parsed = parseHostMutationInput(input);
      const resolveIdentity = async () => {
        const context = await authenticate(request);
        if (
          context instanceof Response ||
          context.principal === undefined ||
          !authorizeWorkspaceClass('administrator-shared', context.principal).allowed
        )
          return undefined;
        return context.principal.workspace;
      };
      const identity = await resolveIdentity();
      if (identity === undefined) throw new HostMutationError('forbidden');
      return createHostMutationContext(identity, parsed, resolveIdentity);
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
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY, additionalScopes: BUREAU_SCOPES },
    ),
  );
  await Promise.all(authenticators.map((authenticate) => authenticate.ready));
  return {
    ...(authentication.auditSink === undefined ? {} : { auditSink: authentication.auditSink }),
    resolveApiKeyPrincipal: async (key) => {
      const request = new Request('http://localhost/', { headers: { 'x-api-key': key } });
      for (const [index, authenticate] of authenticators.entries()) {
        const context = await authenticate(request);
        if (
          !(context instanceof Response) &&
          context.principal !== undefined &&
          (index === 0 || context.principal.subject !== A2A_SUBJECT)
        )
          return context.principal;
      }
      return null;
    },
  };
}
