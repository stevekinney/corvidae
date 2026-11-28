import {
  anonymousPrincipal,
  principalFromJwtClaims,
  type Principal,
} from '@lostgradient/backchannel';
import { expect, test } from 'bun:test';
import { connectedAppsOperations, createConnectedAppsHandler } from './backchannel.ts';

test.each(['jwt', 'browser-session'] as const)(
  'limits personal management to a current %s session and applies the write guard',
  async (method) => {
    const actor = {
      ...principalFromJwtClaims({ sub: 'member' }),
      method,
      workspace: {
        version: 1 as const,
        workspaceId: 'workspace',
        actorId: 'member',
        actorKind: 'user' as const,
        owner: 'owner',
        membershipRevision: '1',
        capabilities: ['workspace:use' as const],
      },
    };
    let signedIn = true;
    let revoked = false;
    const handler = createConnectedAppsHandler({
      publicOrigin: 'https://app.test',
      authenticateSession: async () =>
        signedIn
          ? { method, principal: actor }
          : { method: 'anonymous', principal: anonymousPrincipal() },
      guardWrite: async (request) => request.headers.get('x-csrf') === 'valid',
      host: {
        currentMember: async () => true,
        list: async (principal) => {
          expect(principal).toEqual(actor);
          return [];
        },
        revoke: async (principal, grantId) => {
          expect(principal).toEqual(actor);
          if (grantId !== 'owned') return false;
          revoked = true;
          return true;
        },
      },
    });
    const call = async (method: string, params: object, csrf = 'valid') => {
      const response = await handler(
        new Request('https://app.test/connected-apps/jsonrpc', {
          method: 'POST',
          headers: {
            origin: 'https://app.test',
            'x-csrf': csrf,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
      );
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return {
        response,
        body: response.headers.get('content-type')?.includes('json')
          ? ((await response.json()) as { result?: unknown; error?: unknown })
          : undefined,
      };
    };
    expect(connectedAppsOperations.every((operation) => !operation.mcpExposable)).toBe(true);
    const listing = await call('connected.apps.list', {});
    expect(listing.body?.result).toEqual({
      grants: [],
      canList: true,
      canRevoke: true,
    });
    const denied = await call('connected.apps.revoke', { grantId: 'owned' }, 'invalid');
    expect(denied.response.status).toBe(403);
    expect(revoked).toBe(false);
    const missing = await call('connected.apps.revoke', { grantId: 'missing' });
    const foreign = await call('connected.apps.revoke', { grantId: 'foreign' });
    expect(missing.response.status).toBe(foreign.response.status);
    expect(missing.body?.error).toEqual(foreign.body?.error);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await call('connected.apps.revoke', { grantId: 'owned' });
      expect(result.body?.result).toEqual({
        grantId: 'owned',
        status: 'revoked',
      });
    }
    signedIn = false;
    const anonymous = await call('connected.apps.list', {});
    expect(anonymous.body?.error).toBeDefined();
  },
);

test('external management capabilities receive the current actor and can be absent', async () => {
  const actor = {
    ...principalFromJwtClaims({ sub: 'member' }),
    workspace: {
      version: 1 as const,
      workspaceId: 'workspace',
      actorId: 'member',
      actorKind: 'user' as const,
      owner: 'owner',
      membershipRevision: '1',
      capabilities: ['workspace:use' as const],
    },
  };
  const calls: unknown[] = [];
  const host = {
    currentMember: async () => true,
    list: async (principal: Principal) => {
      calls.push(principal);
      return [];
    },
    revoke: async (principal: Principal, id: string) => {
      calls.push([principal, id]);
      return true;
    },
    managementDestination: 'https://issuer.test/settings',
  };
  const makeHandler = (
    configured:
      typeof host | { currentMember: typeof host.currentMember; managementDestination: string },
  ) =>
    createConnectedAppsHandler({
      host: configured,
      authenticateSession: async () => ({ method: 'jwt', principal: actor }),
      publicOrigin: 'https://app.test',
      guardWrite: async () => true,
    });
  const invoke = async (
    handler: ReturnType<typeof makeHandler>,
    method: string,
    params: object,
  ) => {
    const response = await handler(
      new Request('https://app.test/connected-apps/jsonrpc', {
        method: 'POST',
        headers: { origin: 'https://app.test', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );
    const body = (await response.json()) as { result: unknown };
    return body.result;
  };
  const enabled = makeHandler(host);
  await invoke(enabled, 'connected.apps.list', {});
  await invoke(enabled, 'connected.apps.revoke', { grantId: 'selected' });
  expect(calls).toEqual([actor, [actor, 'selected']]);
  expect(
    await invoke(
      makeHandler({
        currentMember: async () => true,
        managementDestination: 'https://issuer.test/settings',
      }),
      'connected.apps.list',
      {},
    ),
  ).toEqual({
    grants: [],
    canList: false,
    canRevoke: false,
    managementDestination: 'https://issuer.test/settings',
  });
});
