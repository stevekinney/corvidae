import {
  guardWorkspaceResponse,
  type AuthenticatedPrincipal,
  type OperationHandlerAuthenticate,
} from '@lostgradient/backchannel';
import {
  createConnectedAppsHandler,
  hostedConnectedAppsHost,
} from '@lostgradient/connected-apps/backchannel';

import { settingsAccessResponse } from './api-key-settings.ts';

/** Mount self-service inventory and revocation for one admitted browser session at a time. */
export function createConnectedAppsSettings(options: {
  oauth: Parameters<typeof hostedConnectedAppsHost>[0];
  origin: string;
  permittedConnectorScopes: ReadonlySet<string>;
  guardWrite: (request: Request) => Promise<boolean>;
}) {
  const { oauth, origin, permittedConnectorScopes, guardWrite } = options;
  const connectionMembership = (principal: AuthenticatedPrincipal | undefined) =>
    principal?.method === 'browser-session' &&
    principal.workspace?.actorKind === 'user' &&
    principal.workspace.capabilities.includes('workspace:use')
      ? principal.workspace
      : undefined;
  const connectionAccess = async (request: Request, resolve: OperationHandlerAuthenticate) => {
    const context = await resolve(request);
    return context instanceof Response
      ? context
      : settingsAccessResponse(context.principal, connectionMembership(context.principal));
  };
  const manageConnections = async (request: Request, resolve: OperationHandlerAuthenticate) => {
    if (request.headers.has('authorization') || request.headers.has('x-api-key'))
      return new Response('Forbidden', { status: 403 });
    const first = await resolve(request);
    if (first instanceof Response) return first;
    const subject = first.principal?.subject;
    const member = connectionMembership(first.principal);
    if (subject === undefined || member === undefined)
      return new Response('Forbidden', { status: 403 });
    const current = async () => {
      const context = await resolve(request);
      if (context instanceof Response) return false;
      const candidate = connectionMembership(context.principal);
      return (
        context.principal?.subject === subject &&
        candidate?.workspaceId === member.workspaceId &&
        candidate.actorId === member.actorId &&
        candidate.owner === member.owner &&
        candidate.membershipRevision === member.membershipRevision
      );
    };
    const handler = createConnectedAppsHandler({
      host: hostedConnectedAppsHost(
        {
          async listConnectedApps(identity) {
            const grants = await oauth.listConnectedApps(identity);
            return grants.map((grant) => ({
              ...grant,
              permissions: grant.permissions.map((permission) => ({
                ...permission,
                available: permission.available && permittedConnectorScopes.has(permission.scope),
              })),
            }));
          },
          revokeConnectedApp: (identity, grantId) => oauth.revokeConnectedApp(identity, grantId),
        },
        current,
      ),
      authenticateSession: async () =>
        (await current()) ? first : new Response('Forbidden', { status: 403 }),
      publicOrigin: origin,
      guardWrite,
    });
    const url = new URL('/connected-apps/jsonrpc', origin);
    return guardWorkspaceResponse(await handler(new Request(url, request)), current);
  };
  return { connectionAccess, manageConnections };
}
