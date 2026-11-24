import {
  createProtectedHttpHandler,
  type Principal,
  type ProtectedHttpOptions,
  type VerifiedGrant,
} from '@lostgradient/mcp/http';
import type { ToolRequestContext } from '../../execution-context';
import { createMCP, type CreateMCPOptions } from './server';
import type { ToolboxLike } from './tools';

export type ToolboxMcpHttpOptions<T extends Principal> = Omit<CreateMCPOptions, 'selection'> & {
  tools: readonly { id: string; name: string; scopes: readonly string[] }[];
  authorization: Omit<ProtectedHttpOptions<T>, 'dispatch'>;
  requestContext: (
    principal: T,
    grant: VerifiedGrant,
  ) => ToolRequestContext | Promise<ToolRequestContext>;
  surfaceScopes?: readonly string[];
};

/** Serves a pinned toolbox through the shared protected HTTP handler. */
export async function createToolboxMcpHandler<T extends Principal>(
  toolbox: ToolboxLike,
  options: ToolboxMcpHttpOptions<T>,
) {
  const {
    tools,
    requestContext,
    authorization: originalAuthorization,
    surfaceScopes: originalSurfaceScopes,
    ...mcpOptions
  } = options;
  const authorization = {
    ...originalAuthorization,
    scopes: [...originalAuthorization.scopes],
    allowedOrigins: [...(originalAuthorization.allowedOrigins ?? [])],
  };
  const surfaceScopes = [...(originalSurfaceScopes ?? [])];
  const selected = tools.map((tool) => ({ ...tool, scopes: [...tool.scopes] }));
  const scopesByName = new Map(selected.map((tool) => [tool.name, tool.scopes]));
  const mcp = await createMCP(toolbox, { ...mcpOptions, selection: selected });
  const fetch = createProtectedHttpHandler({
    ...authorization,
    async dispatch(request, context) {
      const grant = context.grant;
      if (
        ![grant.grantId, grant.clientId, grant.tenant, grant.subject].every(
          (value) => typeof value === 'string' && value.length > 0,
        )
      ) {
        return new Response(null, { status: 401 });
      }
      let message: { method?: string; params?: { name?: string } } | undefined;
      if (request.method === 'POST') {
        try {
          message = (await request.clone().json()) as typeof message;
        } catch {
          /* SDK handles malformed requests. */
        }
      }
      const scopes =
        message?.method === 'tools/call'
          ? scopesByName.get(message.params?.name ?? '')
          : surfaceScopes;
      if (scopes) {
        const decision = await context.requireScopes(scopes);
        if (!decision.ok) return decision.response;
      }
      const authorize = async (name: string) => {
        const required = scopesByName.get(name);
        if (!required) throw new Error('Unknown MCP tool');
        const decision = await context.requireScopes(required);
        if (!decision.ok) throw new Error('MCP tool access denied');
        const actor = await requestContext(decision.principal, grant);
        const fresh = await context.requireScopes(required);
        if (!fresh.ok) throw new Error('MCP tool access denied');
        return actor;
      };
      return mcp.fetch(request, {
        authInfo: {
          token: '',
          clientId: grant.clientId!,
          scopes: [...grant.scopes],
          extra: {
            armorerBinding: JSON.stringify([
              grant.issuer,
              grant.audience,
              grant.grantId,
              grant.clientId,
              grant.tenant,
              grant.subject,
            ]),
            armorerAuthorize: authorize,
          },
        },
      });
    },
  });
  return { fetch, close: mcp.close, shutdown: mcp.shutdown };
}
