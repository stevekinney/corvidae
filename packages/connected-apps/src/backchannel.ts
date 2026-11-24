import {
  createOperationHandler,
  defineOperation,
  type OperationHandlerAuthenticate,
  type Principal,
} from '@lostgradient/backchannel';
import { readRestBodyBounded } from '@lostgradient/backchannel/internals';
import type { hostedOAuth } from '@lostgradient/mcp/oauth';
import { z } from 'zod';

const permission = z.object({ scope: z.string(), description: z.string(), available: z.boolean() });
const grant = z.object({
  grantId: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  resource: z.string(),
  approvedAt: z.number().nullable(),
  permissions: z.array(permission),
});
const listOutput = z.object({
  grants: z.array(grant),
  canList: z.boolean(),
  canRevoke: z.boolean(),
  managementDestination: z.string().optional(),
});
const empty = z.object({});
const grantInput = z.object({ grantId: z.string().min(1) });
const revokeOutput = z.object({ grantId: z.string(), status: z.literal('revoked') });
export type ConnectedApp = z.infer<typeof grant>;
export type ConnectedAppsHost = {
  currentMember: (principal: Principal) => Promise<boolean>;
  list?: (principal: Principal) => Promise<ConnectedApp[]>;
  revoke?: (principal: Principal, grantId: string) => Promise<boolean>;
  managementDestination?: string;
};
export function hostedConnectedAppsHost(
  issuer: ReturnType<typeof hostedOAuth>,
  currentMember: ConnectedAppsHost['currentMember'],
): ConnectedAppsHost {
  const identity = (principal: Principal) => {
    if (principal.method !== 'jwt' || !principal.subject || !principal.workspace)
      throw new Error('Forbidden');
    return { subject: principal.subject, tenant: principal.workspace.workspaceId };
  };
  return {
    currentMember,
    list: (principal) => issuer.listConnectedApps(identity(principal)),
    revoke: (principal, grantId) => issuer.revokeConnectedApp(identity(principal), grantId),
  };
}
const common = {
  mcpExposable: false,
  tags: ['Connected apps'],
  access: { kind: 'authenticated' as const },
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
};
const authorize = async ({
  principal,
  host,
}: {
  principal: Principal;
  host: ConnectedAppsHost;
}) => {
  const allowed =
    principal.method === 'jwt' &&
    principal.subject !== undefined &&
    principal.workspace?.actorKind === 'user' &&
    principal.workspace.capabilities.includes('workspace:use') &&
    (await host.currentMember(principal));
  return allowed
    ? { allowed: true as const }
    : { allowed: false as const, classification: 'forbidden' as const, reason: 'Forbidden' };
};
const list = defineOperation<typeof empty, typeof listOutput, ConnectedAppsHost>({
  ...common,
  name: 'connected.apps.list',
  summary: 'List connected apps',
  destructive: false,
  inputSchema: empty,
  outputSchema: listOutput,
  behavior: { kind: 'read' },
  authorize,
  invoke: async ({ principal, host }) => ({
    grants: host.list ? await host.list(principal) : [],
    canList: Boolean(host.list),
    canRevoke: Boolean(host.list && host.revoke),
    ...(host.managementDestination ? { managementDestination: host.managementDestination } : {}),
  }),
});
const revoke = defineOperation<typeof grantInput, typeof revokeOutput, ConnectedAppsHost>({
  ...common,
  name: 'connected.apps.revoke',
  summary: 'Disconnect a connected app',
  destructive: true,
  inputSchema: grantInput,
  outputSchema: revokeOutput,
  behavior: { kind: 'command', invalidates: ['connected.apps.list'] },
  authorize,
  producibleFaults: ['NotFound'],
  invoke: async ({ input, principal, host }) => {
    if (!host.revoke || !(await host.revoke(principal, input.grantId)))
      throw {
        code: 'NotFound',
        message: 'Connected app not found',
        data: { resource: 'connected app' },
      };
    return { grantId: input.grantId, status: 'revoked' as const };
  },
});
export const connectedAppsOperations = [list, revoke] as const;

export function createConnectedAppsHandler(options: {
  host: ConnectedAppsHost;
  authenticateSession: OperationHandlerAuthenticate;
  publicOrigin: string;
  guardWrite: (request: Request) => Promise<boolean>;
}) {
  const origin = new URL(options.publicOrigin).origin;
  const handler = createOperationHandler({
    operations: connectedAppsOperations,
    host: options.host,
    authenticate: options.authenticateSession,
    publicPaths: [],
  });
  return async (request: Request) => {
    const headers = { 'Cache-Control': 'private, no-store' };
    const url = new URL(request.url);
    if (url.pathname !== '/connected-apps/jsonrpc' || request.method !== 'POST')
      return new Response('Not found', { status: 404, headers });
    let bytes: Uint8Array;
    try {
      bytes = await readRestBodyBounded(request);
    } catch {
      return new Response('Bad request', { status: 400, headers });
    }
    const buffered = new Request(request, { method: 'POST', body: bytes.buffer as ArrayBuffer });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      body = undefined;
    }
    const calls = Array.isArray(body) ? body : [body];
    if (
      calls.some(
        (call) =>
          typeof call === 'object' &&
          call !== null &&
          'method' in call &&
          call.method === 'connected.apps.revoke',
      )
    ) {
      let allowed = false;
      try {
        allowed =
          request.headers.get('origin') === origin && (await options.guardWrite(buffered.clone()));
      } catch {
        return new Response('Write guard unavailable', { status: 503, headers });
      }
      if (!allowed) return new Response('Forbidden', { status: 403, headers });
    }
    url.pathname = '/jsonrpc';
    const response = await handler(new Request(url, buffered));
    const resultHeaders = new Headers(response.headers);
    resultHeaders.set('Cache-Control', 'private, no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: resultHeaders,
    });
  };
}
