import { openBungalow } from '@lostgradient/bungalow';
import { BUREAU_SCOPES, type WorkspaceMembership } from '@lostgradient/bureau';
import { AUTHORIZATION_SCOPES, principalFromApiKey } from '@lostgradient/weft';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const hosts: Host[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function authenticatedHost(a2aKey?: string) {
  const home = await mkdtemp(join(tmpdir(), 'interborough-workspace-transports-'));
  homes.push(home);
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  const workspaceId = bungalow.workspaceId;
  if (a2aKey !== undefined) await bungalow.deploymentSecrets.write('a2a-api-key', a2aKey);
  await bungalow.close();
  const members = new Map<string, WorkspaceMembership>(
    ['member', 'administrator'].map((actorId) => [
      actorId,
      {
        version: 1,
        workspaceId,
        actorId,
        actorKind: 'user',
        owner: `owner-${actorId}`,
        membershipRevision: 'membership-1',
        capabilities:
          actorId === 'administrator' ? ['workspace:use', 'workspace:manage'] : ['workspace:use'],
      },
    ]),
  );
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    workspaceId,
    port: 0,
    plugins: [],
    workspaceAuthentication: {
      authentication: {
        resolveApiKeyPrincipal: async (key: string) =>
          members.has(key)
            ? principalFromApiKey({
                subject: key,
                scopes: [...AUTHORIZATION_SCOPES, ...BUREAU_SCOPES],
              })
            : null,
      },
      workspace: {
        workspaceId,
        resolveMembership: async ({ subject }: { subject: string | undefined }) =>
          members.get(subject ?? '') ?? null,
        resolveOwnerMembership: async (owner: string) =>
          [...members.values()].find((member) => member.owner === owner) ?? null,
      },
    },
  });
  hosts.push(host);
  return { host, members, workspaceId };
}

function request(host: Host, path: string, actor: string, init: RequestInit = {}) {
  return fetch(new URL(path, host.url), {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-api-key': actor },
  });
}

describe('injected workspace transport authority', () => {
  test('keeps the A2A credential a service without workspace-administrator or deployment powers', async () => {
    const { host } = await authenticatedHost('separate-a2a-credential');
    const response = await request(host, '/api/v1/principal', 'separate-a2a-credential');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workspace: { actorKind: 'service', capabilities: ['workspace:use'] },
    });
    for (const path of ['/host/providers', '/host/paths', '/api/v1/workflows']) {
      const denied = await request(host, path, 'separate-a2a-credential');
      expect(denied.status, path).toBe(403);
    }
    const member = await request(host, '/api/v1/principal', 'member');
    expect(await member.json()).toMatchObject({ workspace: { actorId: 'member' } });
  });
  test('keeps Bureau JSON-RPC actors distinct and closes a revoked WebSocket before its next frame', async () => {
    const { host, members } = await authenticatedHost();
    for (const actor of ['member', 'administrator']) {
      const response = await request(host, '/bureau/jsonrpc', actor, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'weft.system.principal',
          params: {},
        }),
      });
      expect(await response.json()).toMatchObject({ result: { workspace: { actorId: actor } } });
    }
    const url = new URL('/bureau/jsonrpc', host.url);
    url.protocol = 'ws:';
    const socket: WebSocket = Reflect.construct(WebSocket, [
      url.toString(),
      { headers: { 'x-api-key': 'member' } },
    ]);
    try {
      const first = await new Promise<string>((resolve, reject) => {
        socket.addEventListener(
          'open',
          () =>
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'weft.system.principal',
                params: {},
              }),
            ),
          { once: true },
        );
        socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
        socket.addEventListener('error', () => reject(new Error('Fixture WebSocket failed')), {
          once: true,
        });
      });
      expect(JSON.parse(first)).toMatchObject({ result: { workspace: { actorId: 'member' } } });
      members.delete('member');
      const messages: string[] = [];
      socket.addEventListener('message', (event) => messages.push(String(event.data)));
      const closed = new Promise<number>((resolve) =>
        socket.addEventListener('close', (event) => resolve(event.code), { once: true }),
      );
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'weft.system.principal', params: {} }),
      );
      expect(await closed).toBe(1008);
      expect(messages).toEqual([]);
    } finally {
      socket.close();
    }
  });
  test('reports each current actor without accepting caller-selected identity', async () => {
    const { host, workspaceId } = await authenticatedHost();
    const responses = await Promise.all(
      ['member', 'administrator'].map(async (actor) => {
        const response = await request(host, '/api/v1/principal', actor, {
          headers: { 'x-workspace-id': 'forged', 'x-actor-id': 'administrator' },
        });
        expect(response.status).toBe(200);
        return response.json();
      }),
    );
    expect(responses).toMatchObject([
      { workspace: { workspaceId, actorId: 'member', owner: 'owner-member' } },
      { workspace: { workspaceId, actorId: 'administrator', owner: 'owner-administrator' } },
    ]);
  });

  test('refuses attackers and workspace roles on the deployment plane', async () => {
    const { host } = await authenticatedHost();
    const attacker = await request(host, '/api/v1/principal', 'attacker');
    expect(attacker.status).toBe(401);
    for (const actor of ['member', 'administrator']) {
      for (const path of ['/host/paths', '/host/storage', '/host/status', '/api/v1/workflows']) {
        const response = await request(host, path, actor);
        expect(response.status, `${actor}: ${path}`).toBe(403);
      }
    }
  });

  test('requires current membership again on reconnect', async () => {
    const { host, members } = await authenticatedHost();
    const admitted = await request(host, '/api/v1/principal', 'member');
    expect(admitted.status).toBe(200);
    members.delete('member');
    const removed = await request(host, '/api/v1/principal', 'member');
    expect(removed.status).toBe(401);
  });
});
