import { createApiKeyManagementHandler } from '@lostgradient/api-key-settings/backchannel';
import { guardWorkspaceResponse, type Principal } from '@lostgradient/backchannel';
import type { WorkspaceMembership } from '@lostgradient/bureau';
import { createApiKeys } from '@lostgradient/credentials/api-keys';
import { sha256HexSync } from '@lostgradient/cryptography';
import type { Storage } from '@lostgradient/storage';
import type { ServerHooks } from '@lostgradient/velveteen/server';

import { A2A_SCOPES, A2A_SUBJECT } from './a2a-authentication.ts';
import type { HostAuthority } from './host-authority.ts';
import { isNativeAssetPath } from './native-document-request.ts';

/** Select an interactive API key manager after the host has admitted the request's origin. */
export function keySettingsMembership(
  principal: Principal | undefined,
  profile: 'shared' | 'local',
): WorkspaceMembership | undefined {
  if (principal === undefined || principal.method === 'unauthenticated') return undefined;
  const member = principal.workspace;
  if (
    member === undefined ||
    !member.capabilities.includes('workspace:use') ||
    !member.capabilities.includes('workspace:manage')
  )
    return undefined;
  if (profile === 'shared')
    return member.actorKind === 'user' && principal.method === 'browser-session'
      ? member
      : undefined;
  return member.actorKind === 'local' &&
    member.actorId === 'local-owner' &&
    principal.method === 'unauthenticated-local' &&
    member.capabilities.includes('deployment:operate')
    ? member
    : undefined;
}

/** Return a request-scoped UI decision while leaving credential metadata in the command handler. */
export function keySettingsAccessHandler(
  authority: Pick<HostAuthority, 'authenticate'>,
  matchesSharedOrigin: (request: Request) => boolean,
) {
  return async (request: Request): Promise<Response> => {
    const context = await authority.authenticate(request);
    if (context instanceof Response) return context;
    const profile = matchesSharedOrigin(request) ? 'shared' : 'local';
    return settingsAccessResponse(
      context.principal,
      keySettingsMembership(context.principal, profile),
    );
  };
}

/** Return a scoped UI admission decision without handing page code credential metadata. */
export function settingsAccessResponse(
  principal: Principal | undefined,
  member: WorkspaceMembership | undefined,
): Response {
  const scope =
    member === undefined || principal === undefined || principal.method === 'unauthenticated'
      ? undefined
      : sha256HexSync(
          JSON.stringify([
            member.workspaceId,
            member.actorId,
            member.owner,
            member.membershipRevision,
            ...[...principal.scopes].toSorted(),
          ]),
        );
  return Response.json(scope === undefined ? { allowed: false } : { allowed: true, scope }, {
    headers: { 'cache-control': 'private, no-store' },
  });
}

/** The guarded desktop owner provisions service credentials under the host's durable workspace. */
export function createLocalA2aKeys(storage: Storage, workspaceId: string, now: () => number) {
  const scopes: readonly string[] = A2A_SCOPES;
  const inspect = Symbol();
  const service = createApiKeys<Principal | typeof inspect>({
    storage,
    now,
    resolveAuthority: async (identity) =>
      identity.workspaceId === workspaceId && identity.subject === A2A_SUBJECT
        ? { ...identity, scopes }
        : null,
    authorizeManagement: async (principal, target) =>
      (principal === inspect
        ? target.action === 'list'
        : keySettingsMembership(principal, 'local')?.workspaceId === workspaceId) &&
      target.workspaceId === workspaceId &&
      target.subject === A2A_SUBJECT &&
      target.scopes.every((scope) => scopes.includes(scope)),
  });
  return {
    ...service,
    hasIssued: async () => {
      const records = await service.list(inspect, { workspaceId, subject: A2A_SUBJECT });
      return records.length > 0;
    },
  };
}

/** Deliver the mounted route to the packaged key management protocol. */
export function keySettingsProtocolRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = '/key-admin/jsonrpc';
  return new Request(url, request);
}

/** Manage only the A2A service's keys from an already guarded desktop request. */
export function localKeySettingsHandler(options: {
  authority: Pick<HostAuthority, 'authenticate'>;
  keys: ReturnType<typeof createLocalA2aKeys>;
  workspaceId: string;
  now: () => number;
}) {
  const { authority, keys, workspaceId, now } = options;
  return async (request: Request): Promise<Response> => {
    const current = async () => {
      const context = await authority.authenticate(request);
      if (context instanceof Response) return context;
      const member = keySettingsMembership(context.principal, 'local');
      return member?.workspaceId === workspaceId
        ? context
        : new Response('Forbidden', { status: 403 });
    };
    const authorized = await current();
    if (authorized instanceof Response) return authorized;
    const host = request.headers.get('host');
    if (host === null) return new Response('Forbidden', { status: 403 });
    const stillAuthorized = async () => !((await current()) instanceof Response);
    const handler = createApiKeyManagementHandler({
      publicOrigin: `http://${host}`,
      authenticateSession: current,
      guardWrite: stillAuthorized,
      guardTrustedOperatorWrite: stillAuthorized,
      host: {
        keys,
        currentManager: stillAuthorized,
        targets: async () => [{ subject: A2A_SUBJECT, scopes: [...A2A_SCOPES] }],
        allowedActions: async (_principal, key) => {
          const time = now();
          if (
            key.revokedAt !== undefined ||
            (key.expiresAt !== undefined && key.expiresAt <= time) ||
            (key.retiresAt !== undefined && key.retiresAt <= time)
          )
            return [];
          return key.retiresAt === undefined ? ['rotate', 'revoke'] : ['revoke'];
        },
        overlapCutoff: () => now() + 60_000,
      },
    });
    const response = await handler(keySettingsProtocolRequest(request));
    return guardWorkspaceResponse(response, stillAuthorized);
  };
}

/** Desktop documents can only forward the same-origin host reads used by Settings. */
export function desktopSettingsServerHooks(
  authority: HostAuthority,
  port: () => number,
): ServerHooks {
  return {
    async handle({ event, resolve }) {
      // Velveteen has already served any matching published asset before this hook.
      if (isNativeAssetPath(event.url.pathname)) return new Response('Not found', { status: 404 });
      const context = await authority.authenticate(event.request);
      if (context instanceof Response) return context;
      if (keySettingsMembership(context.principal, 'local') === undefined)
        return new Response('Forbidden', { status: 403 });
      return authority.release(event.request, 'private-owned', await resolve(event));
    },
    async handleFetch({ event, request }) {
      const target = new URL(request.url);
      if (
        request.method !== 'GET' ||
        target.origin !== event.url.origin ||
        !['/api/v1/principal', '/host/api-keys/access', '/host/connected-apps/access'].includes(
          target.pathname,
        )
      ) {
        return new Response('Forbidden', { status: 403 });
      }
      target.host = `127.0.0.1:${port()}`;
      return fetch(target, { signal: event.signal, redirect: 'manual' });
    },
  };
}
