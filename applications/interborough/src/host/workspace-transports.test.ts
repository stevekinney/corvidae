import { openBungalow } from '@lostgradient/bungalow';
import { BUREAU_SCOPES, type WorkspaceMembership } from '@lostgradient/bureau';
import { createAgent } from '@lostgradient/operative';
import {
  AUTHORIZATION_SCOPES,
  MCP_LEGACY_PROTOCOL_VERSION,
  principalFromApiKey,
} from '@lostgradient/weft';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOAuthMcpServer } from './tool-source-servers.test-support.ts';

import { startHost, type Host } from './host.ts';

const hosts: Host[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function authenticatedHost(
  a2aKey?: string,
  pendingGeneration?: { started: () => void; promise: Promise<void> },
) {
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
    ['member', 'administrator', 'owner', 'peer', 'grantee', 'foreign'].map((actorId) => [
      actorId,
      {
        version: 1,
        workspaceId: actorId === 'foreign' ? 'another-workspace' : workspaceId,
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
    extraAgents: {
      agents: {
        fixture: createAgent({
          name: 'fixture',
          generate: async () => ({ content: 'PRIVATE-HOST-TRANSPORT-SENTINEL', toolCalls: [] }),
        }),
        waiting: createAgent({
          name: 'waiting',
          generate: async () => {
            pendingGeneration?.started();
            await pendingGeneration?.promise;
            return { content: 'PRIVATE-HOST-TRANSPORT-SENTINEL', toolCalls: [] };
          },
        }),
      },
    },
    workspaceAuthentication: {
      authentication: {
        resolveApiKeyPrincipal: async (key: string) =>
          members.has(key) || key === 'removed'
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
  test('stops a live stream when its credential is remapped before a private result', async () => {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const { host, members, workspaceId } = await authenticatedHost(undefined, {
      started: started.resolve,
      promise: release.promise,
    });
    const run = await host.bureau.tasks.start('waiting', 'ordinary input', {
      principal: 'owner-member',
    });
    try {
      await started.promise;
      const expected = encodeURIComponent(JSON.stringify([workspaceId, 'member']));
      const response = await request(
        host,
        `/bureau/ag-ui/runs/${encodeURIComponent(run.id)}`,
        'member',
        {
          headers: { accept: 'text/event-stream', 'x-interborough-expected-identity': expected },
        },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      members.set('member', { ...members.get('member')!, actorId: 'peer', owner: 'owner-peer' });
      release.resolve();
      let after = '';
      const decoder = new TextDecoder();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        after += decoder.decode(part.value, { stream: true });
      }
      expect(after).not.toContain('PRIVATE-HOST-TRANSPORT-SENTINEL');
      const controlRelease = Promise.withResolvers<void>();
      const controlStarted = Promise.withResolvers<void>();
      const controlFixture = await authenticatedHost(undefined, {
        started: controlStarted.resolve,
        promise: controlRelease.promise,
      });
      const control = await controlFixture.host.bureau.tasks.start('waiting', 'ordinary input', {
        principal: 'owner-member',
      });
      try {
        await controlStarted.promise;
        const controlResponse = await request(
          controlFixture.host,
          `/bureau/ag-ui/runs/${encodeURIComponent(control.id)}`,
          'member',
          {
            headers: {
              accept: 'text/event-stream',
              'x-interborough-expected-identity': encodeURIComponent(
                JSON.stringify([controlFixture.workspaceId, 'member']),
              ),
            },
          },
        );
        controlRelease.resolve();
        expect(await controlResponse.text()).toContain('PRIVATE-HOST-TRANSPORT-SENTINEL');
        await control.result();
      } finally {
        controlRelease.resolve();
        await control.result().catch(() => {});
      }
    } finally {
      release.resolve();
      await run.result().catch(() => {});
    }
  });

  test('rejects a stale browser identity across host, engine, and Bureau transports', async () => {
    const { host, members, workspaceId } = await authenticatedHost();
    const expected = encodeURIComponent(JSON.stringify([workspaceId, 'member']));
    const headers = { 'x-interborough-expected-identity': expected };
    const initial = await request(host, '/api/v1/principal', 'member', { headers });
    expect(initial.status).toBe(200);
    members.set('member', { ...members.get('member')!, actorId: 'peer', owner: 'owner-peer' });
    for (const path of [
      '/api/v1/principal',
      '/api/v1/workflows',
      '/host/mcp-apps',
      '/bureau/jsonrpc',
    ]) {
      const response = await request(
        host,
        path,
        'member',
        path === '/bureau/jsonrpc'
          ? {
              method: 'POST',
              headers: { ...headers, 'content-type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'weft.system.principal',
                params: {},
              }),
            }
          : { headers },
      );
      expect(response.status, path).toBe(409);
      expect(response.headers.get('x-interborough-identity-mismatch'), path).toBe('1');
    }
  });

  test('the retired integrations endpoint returns 404', async () => {
    const { host } = await authenticatedHost();
    const response = await request(host, '/host/integrations', 'member');
    expect(response.status).toBe(404);
  });

  test('OAuth callback authority stays with the initiating administrator', async () => {
    const { host, members } = await authenticatedHost();
    const oauth = await startOAuthMcpServer();
    try {
      await host.toolSources.connect({
        id: 'calendar',
        principal: 'anonymous:local',
        source: {
          id: 'calendar',
          kind: 'mcp',
          transport: { type: 'http', url: `${oauth.origin}/`, authentication: { type: 'oauth' } },
        },
      });
      const snapshotResponse = await request(host, '/host/tool-sources', 'administrator');
      const snapshot = (await snapshotResponse.json()) as { configurationRevision: string | null };
      const input = {
        operationId: 'one-sign-in',
        expectedRevision: snapshot.configurationRevision,
      };
      const start = await request(host, '/host/tool-sources/calendar/authorize', 'administrator', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(start.status).toBe(200);
      const answer = (await start.json()) as { authorizationUrl: string };
      const redirect = await fetch(answer.authorizationUrl, { redirect: 'manual' });
      const callback = redirect.headers.get('location');
      if (callback === null) throw new Error('Expected an OAuth callback');
      const initiating = members.get('administrator');
      if (initiating === undefined) throw new Error('Missing fixture administrator');
      const badState = new URL(callback);
      badState.searchParams.set('state', 'wrong-state');
      const invalidCallback = await fetch(badState);
      expect(invalidCallback.status).toBe(400);
      expect(oauth.issuedAccessTokens).toHaveLength(0);
      members.delete('administrator');
      const removedCallback = await fetch(callback);
      expect(removedCallback.status).toBe(403);
      expect(oauth.issuedAccessTokens).toHaveLength(0);
      members.set('administrator', initiating);
      const complete = await fetch(callback);
      expect(complete.status).toBe(200);
      expect(oauth.issuedAccessTokens).toHaveLength(1);
      const replay = await fetch(callback);
      expect(replay.status).toBe(400);
      expect(oauth.issuedAccessTokens).toHaveLength(1);
    } finally {
      await oauth.stop();
    }
  });

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

test('the host relay preserves six-actor private outcomes across JSON-RPC, MCP, SSE and AG-UI', async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { host } = await authenticatedHost(undefined, {
    started: started.resolve,
    promise: release.promise,
  });
  const live = await host.bureau.tasks.start('waiting', 'PRIVATE-HOST-TRANSPORT-SENTINEL', {
    principal: 'owner-owner',
  });
  try {
    await started.promise;
    const run = await host.bureau.tasks.start('fixture', 'PRIVATE-HOST-TRANSPORT-SENTINEL', {
      principal: 'owner-owner',
    });
    await run.result();
    for (const actor of ['peer', 'administrator', 'grantee', 'foreign', 'removed', 'owner']) {
      const deniedMembership = actor === 'foreign' || actor === 'removed';
      for (const transport of ['jsonrpc', 'mcp'] as const) {
        const response = await request(host, `/bureau/${transport}`, actor, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MCP_LEGACY_PROTOCOL_VERSION,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: transport === 'mcp' ? 'tools/call' : 'bureau.tasks.get',
            params:
              transport === 'mcp'
                ? { name: 'bureau.tasks.get', arguments: { taskId: run.id } }
                : { taskId: run.id },
          }),
        });
        const text = await response.text();
        if (deniedMembership) expect(response.status).toBe(403);
        else if (actor === 'owner') {
          expect(response.status).toBe(200);
          expect(text).toContain(run.id);
        } else {
          expect(text).toContain('NotFound');
          expect(text).not.toContain('PRIVATE-HOST-TRANSPORT-SENTINEL');
        }
      }
      const events = await request(
        host,
        `/bureau/v1/subscriptions/bureau.tasks.events?taskId=${encodeURIComponent(run.id)}`,
        actor,
        { headers: { accept: 'text/event-stream' } },
      );
      const eventsText = await events.text();
      expect(events.status).toBe(deniedMembership ? 403 : actor === 'owner' ? 200 : 404);
      if (actor !== 'owner') expect(eventsText).not.toContain('PRIVATE-HOST-TRANSPORT-SENTINEL');
      else expect(eventsText).toContain('PRIVATE-HOST-TRANSPORT-SENTINEL');
      const attachment = await request(
        host,
        `/bureau/ag-ui/runs/${encodeURIComponent(live.id)}`,
        actor,
        { headers: { accept: 'text/event-stream' } },
      );
      if (actor === 'owner') release.resolve();
      const attachmentText = await attachment.text();
      if (deniedMembership) expect(attachment.status).toBe(403);
      else if (actor !== 'owner') {
        expect(attachmentText).toContain('RUN_NOT_FOUND');
        expect(attachmentText).not.toContain('PRIVATE-HOST-TRANSPORT-SENTINEL');
      } else {
        expect(attachment.status).toBe(200);
        expect(attachmentText).not.toContain('RUN_NOT_FOUND');
        expect(attachmentText).toContain(live.id);
        expect(attachmentText).toContain('PRIVATE-HOST-TRANSPORT-SENTINEL');
      }
      const before = await host.providers.snapshot();
      const refusal = await request(host, '/host/providers/anthropic', actor, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: 'denied-mutation',
          expectedRevision: before.configurationRevision,
          apiKey: 'secret',
        }),
      });
      if (actor !== 'administrator') {
        expect(refusal.status).toBe(403);
        const after = await host.providers.snapshot();
        expect(after.configurationRevision).toBe(before.configurationRevision);
      }
    }
  } finally {
    release.resolve();
    await live.result();
  }
});
