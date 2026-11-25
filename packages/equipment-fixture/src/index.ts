import { createBrowserSignIn, oidc } from '@lostgradient/credentials/browser-sign-in';
import { hostedOAuth, OAuthStore } from '@lostgradient/mcp/oauth';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';
import type { EquipmentEnvironment } from './environment-configuration.ts';

export function publicRequest(request: Request, origin: string): Request | Response {
  const publicOrigin = new URL(origin);
  const host = request.headers.get('host')?.toLowerCase();
  const defaultPort = publicOrigin.protocol === 'https:' ? '443' : '80';
  if (
    host !== publicOrigin.host &&
    !(publicOrigin.port === '' && host === `${publicOrigin.hostname}:${defaultPort}`)
  )
    return new Response('Invalid host', { status: 400 });
  const url = new URL(request.url);
  url.protocol = publicOrigin.protocol;
  url.host = publicOrigin.host;
  return new Request(url, request);
}

export function fixtureScopes(subject: string, reader: string, editor: string) {
  if (!reader || !editor || reader === editor)
    throw new Error('Fixture identities must be distinct');
  return subject === editor
    ? ['equipment:read', 'equipment:write']
    : subject === reader
      ? ['equipment:read']
      : null;
}

export function createFixture(resourcePath: string, configuration: EquipmentEnvironment) {
  const { origin, issuer, reader, editor, clientId, clientSecret, sqlitePath } = configuration;
  fixtureScopes('', reader, editor);
  const storage = new BunSQLiteStorage(sqlitePath);
  const role = (subject: string) => fixtureScopes(subject, reader, editor);
  const principalForGrant = async ({ subject, tenant }: { subject: string; tenant: string }) => {
    const scopes = tenant === 'equipment' ? role(subject) : null;
    return scopes ? { delegableScopes: scopes } : null;
  };
  const browser = createBrowserSignIn({
    publicOrigin: origin,
    storage,
    workspaceId: 'equipment',
    cookieName: 'equipment_session',
    provider: oidc({
      issuer,
      clientId,
      clientSecret,
    }),
    resolveAccount: async (identity) =>
      identity.issuer === issuer && role(identity.subject) ? identity.subject : null,
    resolveMembership: async ({ subjectId, workspaceId }) =>
      role(subjectId) && workspaceId === 'equipment' ? { workspaceId } : null,
  });
  const store = new OAuthStore(storage);
  const oauth = hostedOAuth({
    issuer: origin,
    resource: `${origin}${resourcePath}`,
    scopes: ['equipment:read', 'equipment:write'],
    startingScopes: ['equipment:read'],
    scopeDescriptions: {
      'equipment:read': 'Read equipment',
      'equipment:write': 'Rename equipment',
    },
    store,
    identity: browser.oauthIdentity(store, principalForGrant),
  });
  const resolvePrincipal = async (grant: { subject: string; tenant?: string }) => {
    const scopes = grant.tenant === 'equipment' ? role(grant.subject) : null;
    return scopes ? { delegableScopes: scopes } : null;
  };
  const key = 'fixture:equipment:name';
  const input = z.object({ assetId: z.literal('CAM-7') });
  const read = async () =>
    new TextDecoder().decode((await storage.get(key)) ?? new TextEncoder().encode('Camera'));
  const lookup = createTool({
    namespace: 'equipment',
    version: '1.0.0',
    name: 'lookup',
    description: 'Look up equipment',
    input,
    metadata: { readOnly: true },
    execute: async () => ({ assetId: 'CAM-7' as const, name: await read() }),
  });
  const rename = createTool({
    namespace: 'equipment',
    version: '1.0.0',
    name: 'rename',
    description: 'Rename equipment',
    input: input.extend({ name: z.string().min(1) }),
    metadata: { mutates: true },
    execute: async ({ name }) => {
      await storage.put(key, new TextEncoder().encode(name));
      return { assetId: 'CAM-7' as const, name };
    },
  });
  const toolbox = createToolbox([lookup, rename]);
  const requestContext = (subject: string) => {
    return {
      authority: {
        principalId: subject,
        tenantId: 'equipment',
        ownerId: subject,
        capabilities: [],
        authorizationRevision: '1',
      },
    };
  };
  return {
    origin,
    storage,
    browser,
    oauth,
    resolvePrincipal,
    toolbox,
    lookup,
    rename,
    requestContext,
  };
}
