import { principalFromApiKey, type Principal } from '@lostgradient/backchannel';
import { operationsFromToolbox } from '@lostgradient/backchannel-armorer';
import { createBrowserSignIn, oidc } from '@lostgradient/credentials/browser-sign-in';
import { hostedOAuth, OAuthStore } from '@lostgradient/mcp/oauth';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
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

export function createFixture(resourcePath: string) {
  const origin = required('PUBLIC_ORIGIN');
  const issuer = required('OIDC_ISSUER');
  const reader = required('READER_SUBJECT');
  const editor = required('EDITOR_SUBJECT');
  fixtureScopes('', reader, editor);
  const storage = new BunSQLiteStorage(required('SQLITE_PATH'));
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
      clientId: required('OIDC_CLIENT_ID'),
      clientSecret: required('OIDC_CLIENT_SECRET'),
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
    return scopes
      ? {
          delegableScopes: scopes,
          principal: principalFromApiKey({ subject: grant.subject, scopes }),
        }
      : null;
  };
  const key = 'fixture:equipment:name';
  const input = z.object({ assetId: z.literal('CAM-7') });
  const output = input.extend({ name: z.string() });
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
  const requestContext = (principal: Principal) => {
    if (!('subject' in principal) || !principal.subject) throw new Error('Missing fixture subject');
    return {
      authority: {
        principalId: principal.subject,
        tenantId: 'equipment',
        ownerId: principal.subject,
        capabilities: [],
        authorizationRevision: '1',
      },
    };
  };
  const operations = operationsFromToolbox(
    toolbox,
    [
      {
        tool: lookup.id,
        name: 'equipment.lookup',
        scopes: ['equipment:read'],
        outputSchema: output,
        mcpExposable: true,
        behavior: { kind: 'read', key: ['assetId'] },
      },
      {
        tool: rename.id,
        name: 'equipment.rename',
        scopes: ['equipment:write'],
        outputSchema: output,
        mcpExposable: true,
        behavior: { kind: 'command', invalidates: ['equipment.lookup'] },
      },
    ],
    { requestContext },
  );
  return {
    origin,
    storage,
    browser,
    oauth,
    resolvePrincipal,
    toolbox,
    lookup,
    rename,
    operations,
    requestContext,
  };
}
