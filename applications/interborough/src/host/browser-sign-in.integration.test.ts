import { openBungalow } from '@lostgradient/bungalow';
import type { WorkspaceMembership } from '@lostgradient/bureau';
import { createAgent } from '@lostgradient/operative';
import { createApplication } from '@lostgradient/velveteen/server';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from 'openid-client';
import { startHost } from './host.ts';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('listener binds verified browser identities, revokes private access and resumes consent', async () => {
  const key = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  const pending = new Map<
    string,
    { nonce: string; challenge: string; redirect: string; subject: string }
  >();
  let subject = 'admin';
  let issuer = '';
  let acceptedIssuer = '';
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/openid-configuration')
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
      if (url.pathname === '/jwks')
        return Response.json({ keys: [{ ...jwk, kid: 'key', alg: 'RS256', use: 'sig' }] });
      if (url.pathname === '/authorize') {
        const code = crypto.randomUUID();
        const redirect = url.searchParams.get('redirect_uri')!;
        pending.set(code, {
          nonce: url.searchParams.get('nonce')!,
          challenge: url.searchParams.get('code_challenge')!,
          redirect,
          subject,
        });
        const callback = new URL(redirect);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        return Response.redirect(callback, 302);
      }
      const form = new URLSearchParams(await request.text());
      const grant = pending.get(form.get('code') ?? '');
      if (
        !grant ||
        grant.redirect !== form.get('redirect_uri') ||
        (await client.calculatePKCECodeChallenge(form.get('code_verifier') ?? '')) !==
          grant.challenge
      )
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      pending.delete(form.get('code')!);
      const now = Math.floor(Date.now() / 1000);
      const payload = `${encode({ alg: 'RS256', kid: 'key' })}.${encode({ iss: issuer, sub: grant.subject, aud: 'interborough', iat: now, exp: now + 600, nonce: grant.nonce })}`;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        key.privateKey,
        new TextEncoder().encode(payload),
      );
      return Response.json({
        access_token: 'token',
        token_type: 'Bearer',
        id_token: `${payload}.${Buffer.from(signature).toString('base64url')}`,
      });
    },
  });
  issuer = `http://127.0.0.1:${provider.port}`;
  acceptedIssuer = issuer;
  const home = await mkdtemp(join(tmpdir(), 'interborough-sign-in-'));
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  const workspaceId = bungalow.workspaceId;
  await bungalow.close();
  const members = new Map<string, WorkspaceMembership>();
  for (const actorId of ['admin', 'member'])
    members.set(actorId, {
      version: 1,
      workspaceId,
      actorId,
      actorKind: 'user',
      owner: `owner:${actorId}`,
      membershipRevision: 'revision-1',
      capabilities: actorId === 'admin' ? ['workspace:use', 'workspace:manage'] : ['workspace:use'],
    });
  const configuration = await client.discovery(
    new URL(issuer),
    'interborough',
    { client_secret: 'secret' },
    undefined,
    { execute: [client.allowInsecureRequests, client.enableNonRepudiationChecks] },
  );
  const streamStarted = Promise.withResolvers<void>();
  const releaseStream = Promise.withResolvers<void>();
  const loadStarted = Promise.withResolvers<void>();
  const releaseLoad = Promise.withResolvers<void>();
  const keyTargetsStarted = Promise.withResolvers<void>();
  const releaseKeyTargets = Promise.withResolvers<void>();
  let holdLoad = false;
  let holdKeyTargets = false;
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    workspaceId,
    port: 0,
    plugins: [],
    extraAgents: {
      agents: {
        fixture: createAgent({
          name: 'fixture',
          generate: async () => ({ content: 'PRIVATE-LISTENER-SENTINEL', toolCalls: [] }),
        }),
        waiting: createAgent({
          name: 'waiting',
          generate: async () => {
            streamStarted.resolve();
            await releaseStream.promise;
            return { content: 'PRIVATE-STREAM-SENTINEL', toolCalls: [] };
          },
        }),
      },
    },
    workspaceAuthentication: {
      authentication: { apiKeys: ['machine'] },
      workspace: {
        workspaceId,
        resolveMembership: async ({ subject: identity }) => members.get(identity ?? '') ?? null,
        resolveOwnerMembership: async (owner) =>
          [...members.values()].find((member) => member.owner === owner) ?? null,
      },
    },
    sharedBrowserSignIn: {
      origin: 'https://settings.example',
      provider: Promise.resolve(configuration),
      resolveAccount: async (identity) =>
        identity.issuer === acceptedIssuer &&
        ['admin', 'member', 'removed'].includes(identity.subject)
          ? identity.subject
          : null,
      scopes: async () => ['system:read', 'reviews:read'],
      createPrivateServer: async (hooks) => {
        const routing = {
          version: 1,
          nodes: [
            {
              id: '/settings/api-keys',
              directory: '',
              parentId: null,
              params: [],
              page: { component: 'page.svelte' },
            },
          ],
          routes: [
            {
              id: '/settings/api-keys',
              pattern: '^/settings/api-keys$',
              params: [],
              node: 0,
              leaf: 0,
              ancestors: [0],
              layouts: [],
              errors: [null],
            },
          ],
        };
        const generation = {
          directory: home,
          manifest: {
            version: 1,
            basePath: '',
            routing,
            client: { file: 'client.js', url: '/client.js', stylesheets: [], nodes: {} },
            server: { file: 'server.js', nodes: {} },
            routes: {},
            assets: [],
            outputs: [],
          },
        };
        const registry = {
          manifest: routing,
          nodes: [
            {
              page: async () => ({ default: {} }),
              pageServer: async () => ({
                load: async (event: { fetch: typeof fetch }) => {
                  const response = await event.fetch('/api/v1/principal');
                  const identity = await response.json();
                  if (holdLoad) {
                    loadStarted.resolve();
                    await releaseLoad.promise;
                  }
                  return { identity };
                },
              }),
            },
          ],
          Root: {},
          render: (_component: unknown, input: { props: unknown }) => ({
            body: JSON.stringify(input.props),
            head: '',
          }),
        };
        return createApplication({
          generation: generation as never,
          registry: registry as never,
          hooks,
        });
      },
      keyManagement: {
        targets: async () => {
          if (holdKeyTargets) {
            keyTargetsStarted.resolve();
            await releaseKeyTargets.promise;
          }
          return [{ subject: 'service', scopes: ['reviews:read'] }];
        },
        allowedActions: async () => ['rotate', 'revoke'],
        overlapCutoff: () => Date.now() + 60_000,
      },
      oauth: {
        resourcePath: '/bureau/mcp',
        scopes: ['reviews:read'],
        startingScopes: ['reviews:read'],
        scopeDescriptions: { 'reviews:read': 'Read reviews' },
        delegableScopes: async () => ['reviews:read'],
        operationScopes: { 'bureau.tasks.get': 'reviews:read' },
      },
    },
  });
  const send = (path: string, init: RequestInit = {}) =>
    fetch(new URL(path, host.url), {
      ...init,
      redirect: 'manual',
      headers: { ...Object.fromEntries(new Headers(init.headers)), host: 'settings.example' },
    });
  const signIn = async (identity: string, path = '/auth/sign-in') => {
    subject = identity;
    const started = await send(path);
    const cookie = started.headers.getSetCookie()[0]!.split(';')[0]!;
    const authorized = await fetch(started.headers.get('location')!, { redirect: 'manual' });
    const callback = new URL(authorized.headers.get('location')!);
    const result = await send(callback.pathname + callback.search, { headers: { cookie } });
    return { result, cookie: result.headers.getSetCookie()[0]?.split(';')[0] };
  };
  const openSocket = async (cookie: string) => {
    const url = new URL('/bureau/jsonrpc', host.url);
    url.protocol = 'ws:';
    const socket: WebSocket = Reflect.construct(WebSocket, [
      url.toString(),
      { headers: { host: 'settings.example', origin: 'https://settings.example', cookie } },
    ]);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Socket refused')), { once: true });
    });
    return socket;
  };
  const socketPrincipal = (socket: WebSocket) =>
    new Promise<{ result: { workspace: { actorId: string } } }>((resolve) => {
      socket.addEventListener(
        'message',
        (event) =>
          resolve(JSON.parse(String(event.data)) as { result: { workspace: { actorId: string } } }),
        { once: true },
      );
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'weft.system.principal', params: {} }),
      );
    });
  const socketAfterRevocation = (socket: WebSocket) =>
    new Promise<string>((resolve) => {
      socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
      socket.addEventListener('close', () => resolve('closed'), { once: true });
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'weft.system.principal', params: {} }),
      );
    });
  try {
    const run = await host.bureau.tasks.start('fixture', 'PRIVATE-LISTENER-SENTINEL', {
      principal: 'owner:admin',
    });
    await run.result();
    const readPrivate = (cookie?: string) =>
      send('/bureau/jsonrpc', {
        method: 'POST',
        headers: {
          origin: 'https://settings.example',
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'bureau.tasks.get',
          params: { taskId: run.id },
        }),
      });
    const anonymous = await send('/api/v1/principal');
    expect(anonymous.status).toBe(401);
    const administrator = await signIn('admin');
    expect(administrator.result.status).toBe(303);
    const member = await signIn('member');
    expect(member.result.status).toBe(303);
    for (const [cookie, expected] of [
      [administrator.cookie!, 'admin'],
      [member.cookie!, 'member'],
    ] as const) {
      const response = await send('/api/v1/principal', { headers: { cookie } });
      expect(await response.json()).toMatchObject({
        method: 'browser-session',
        subject: expected,
        scopes: ['system:read', 'reviews:read'],
        workspace: { workspaceId, actorId: expected },
      });
    }
    const administratorSocket = await openSocket(administrator.cookie!);
    const memberSocket = await openSocket(member.cookie!);
    const administratorSocketIdentity = await socketPrincipal(administratorSocket);
    const memberSocketIdentity = await socketPrincipal(memberSocket);
    expect(administratorSocketIdentity.result.workspace.actorId).toBe('admin');
    expect(memberSocketIdentity.result.workspace.actorId).toBe('member');
    const adminPage = await send('/settings/api-keys', {
      headers: { cookie: administrator.cookie! },
    });
    const memberPage = await send('/settings/api-keys', { headers: { cookie: member.cookie! } });
    expect(adminPage.headers.get('cache-control')).toBe('private, no-store');
    const adminPageText = await adminPage.text();
    const memberPageText = await memberPage.text();
    expect(adminPageText).toContain('owner:admin');
    expect(adminPageText).not.toContain('owner:member');
    expect(memberPageText).toContain('owner:member');
    expect(memberPageText).not.toContain('owner:admin');
    const listKeys = (cookie: string) =>
      send('/key-admin/jsonrpc', {
        method: 'POST',
        headers: { cookie, origin: 'https://settings.example', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'api.keys.list', params: {} }),
      });
    const adminKeysResponse = await listKeys(administrator.cookie!);
    const adminKeys = await adminKeysResponse.json();
    expect(adminKeys.result.targets).toEqual([{ subject: 'service', scopes: ['reviews:read'] }]);
    const memberKeys = await listKeys(member.cookie!);
    expect(memberKeys.status).toBe(403);
    expect(await memberKeys.text()).not.toContain('service');
    const managementSession = await send('/auth/session', {
      headers: { cookie: administrator.cookie! },
    });
    const managementCsrf = await managementSession.json();
    holdKeyTargets = true;
    const pendingIssue = send('/key-admin/jsonrpc', {
      method: 'POST',
      headers: {
        cookie: administrator.cookie!,
        origin: 'https://settings.example',
        'x-csrf-token': managementCsrf.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'api.keys.issue',
        params: { label: 'revoked while issuing', subject: 'service', scopes: ['reviews:read'] },
      }),
    });
    await keyTargetsStarted.promise;
    const administratorMembership = members.get('admin')!;
    members.delete('admin');
    releaseKeyTargets.resolve();
    const refusedIssue = await pendingIssue;
    expect(refusedIssue.status).toBe(403);
    expect(await refusedIssue.text()).not.toContain('secret');
    holdKeyTargets = false;
    members.set('admin', administratorMembership);
    const keysAfterRefusal = await listKeys(administrator.cookie!);
    const keysAfterRefusalBody = await keysAfterRefusal.json();
    expect(keysAfterRefusalBody.result.keys).toEqual([]);
    for (const headers of [
      { 'x-api-key': 'machine-api-key' },
      { authorization: 'Bearer connector-token' },
      { 'x-api-key': 'model-provider-key' },
      { 'x-api-key': 'engine-relay-key' },
      { authorization: 'Bearer deployment-operator' },
    ]) {
      const response = await send('/key-admin/jsonrpc', {
        method: 'POST',
        headers: {
          ...headers,
          cookie: administrator.cookie!,
          origin: 'https://settings.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'api.keys.list', params: {} }),
      });
      expect(response.status).toBe(403);
    }
    const administratorPrivate = await readPrivate(administrator.cookie);
    const memberPrivate = await readPrivate(member.cookie);
    expect(await administratorPrivate.text()).toContain(run.id);
    expect(await memberPrivate.text()).not.toContain('PRIVATE-LISTENER-SENTINEL');
    const live = await host.bureau.tasks.start('waiting', 'ordinary input', {
      principal: 'owner:admin',
    });
    await streamStarted.promise;
    const streamPath = `/bureau/ag-ui/runs/${encodeURIComponent(live.id)}`;
    const stream = await send(streamPath, {
      headers: {
        cookie: administrator.cookie!,
        accept: 'text/event-stream',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await reader.read();
    const strangerStream = await send(streamPath, {
      headers: {
        cookie: member.cookie!,
        accept: 'text/event-stream',
        'sec-fetch-site': 'same-origin',
      },
    });
    const strangerStreamText = await strangerStream.text();
    expect(strangerStreamText).toContain('RUN_NOT_FOUND');
    expect(strangerStreamText).not.toContain('PRIVATE-STREAM-SENTINEL');
    for (const unadmitted of ['stranger', 'removed']) {
      const denied = await signIn(unadmitted);
      const deniedPrivate = await readPrivate();
      expect(denied.result.status).toBe(400);
      expect(await deniedPrivate.text()).not.toContain('PRIVATE-LISTENER-SENTINEL');
    }
    acceptedIssuer = 'https://wrong.example';
    const wrongIssuer = await signIn('admin');
    const wrongIssuerPrivate = await readPrivate();
    expect(wrongIssuer.result.status).toBe(400);
    expect(await wrongIssuerPrivate.text()).not.toContain('PRIVATE-LISTENER-SENTINEL');
    acceptedIssuer = issuer;
    const csrfResponse = await send('/auth/session', {
      headers: { cookie: administrator.cookie! },
    });
    const csrf = await csrfResponse.json();
    holdLoad = true;
    const stalePage = send('/settings/api-keys', { headers: { cookie: administrator.cookie! } });
    await loadStarted.promise;
    for (const headers of [
      { origin: 'https://evil.example', 'x-csrf-token': csrf.csrfToken },
      { origin: 'https://settings.example' },
    ]) {
      const deniedSignOut = await send('/auth/sign-out', {
        method: 'POST',
        headers: { ...headers, cookie: administrator.cookie! },
      });
      expect(deniedSignOut.status).toBe(403);
    }
    const signedOut = await send('/auth/sign-out', {
      method: 'POST',
      headers: {
        origin: 'https://settings.example',
        'x-csrf-token': csrf.csrfToken,
        cookie: administrator.cookie!,
      },
    });
    expect(signedOut.status).toBe(303);
    releaseLoad.resolve();
    const stalePageResponse = await stalePage;
    expect(stalePageResponse.status).toBe(403);
    expect(await stalePageResponse.text()).not.toContain('admin');
    holdLoad = false;
    expect(await socketAfterRevocation(administratorSocket)).not.toContain('admin');
    releaseStream.resolve();
    let streamed = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += new TextDecoder().decode(chunk.value);
    }
    expect(streamed).not.toContain('PRIVATE-STREAM-SENTINEL');
    await live.result();
    const signedOutPrincipal = await send('/api/v1/principal', {
      headers: { cookie: administrator.cookie! },
    });
    expect(signedOutPrincipal.status).toBe(401);
    const signedOutPrivate = await readPrivate(administrator.cookie);
    expect(await signedOutPrivate.text()).not.toContain('PRIVATE-LISTENER-SENTINEL');
    members.delete('member');
    expect(await socketAfterRevocation(memberSocket)).not.toContain('member');
    const removedPrincipal = await send('/api/v1/principal', {
      headers: { cookie: member.cookie! },
    });
    expect(removedPrincipal.status).toBe(401);
    const removedPage = await send('/settings/api-keys', { headers: { cookie: member.cookie! } });
    expect(await removedPage.text()).not.toContain('member');
    const removedPrivate = await readPrivate(member.cookie);
    expect(await removedPrivate.text()).not.toContain('PRIVATE-LISTENER-SENTINEL');
    const registration = await send('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Listener fixture',
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json();
    const authorization = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge('a'.repeat(64)),
      code_challenge_method: 'S256',
      scope: 'reviews:read',
      resource: 'https://settings.example/bureau/mcp',
      state: 'original-state',
    });
    const continuation = await signIn('admin', `/oauth/authorize?${authorization}`);
    expect(continuation.result.status).toBe(303);
    const returned = new URL(continuation.result.headers.get('location')!);
    expect(returned.origin).toBe('https://settings.example');
    expect(returned.pathname).toBe('/oauth/authorize');
    expect(returned.searchParams.get('client_id')).toBe(registered.client_id);
    expect(returned.searchParams.get('scope')).toBe('reviews:read');
    expect(returned.searchParams.get('resource')).toBe('https://settings.example/bureau/mcp');
    const consent = await send(returned.pathname + returned.search, {
      headers: { cookie: continuation.cookie! },
    });
    expect(consent.status).toBe(200);
    const form = await consent.text();
    const approval = await send('/oauth/authorize', {
      method: 'POST',
      headers: {
        cookie: continuation.cookie!,
        origin: 'https://settings.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        transaction: /name="transaction" value="([^"]+)"/.exec(form)![1]!,
        csrf: /name="csrf" value="([^"]+)"/.exec(form)![1]!,
        client_id: registered.client_id,
        decision: 'approve',
      }),
    });
    expect(approval.status).toBe(302);
    const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
    const exchange = await send('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        code,
        redirect_uri: 'https://client.example/callback',
        code_verifier: 'a'.repeat(64),
        resource: 'https://settings.example/bureau/mcp',
      }),
    });
    expect(exchange.status).toBe(200);
    const token = await exchange.json();
    const discovery = await send('/bureau/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2024-11-05',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    const tools = await discovery.text();
    expect(tools).toContain('bureau.tasks.get');
    expect(tools).not.toContain('bureau.tasks.cancel');
    expect(tools).not.toContain('bureau.reviews.list');
    const connector = (name: string, argumentsValue: object) =>
      send('/bureau/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.access_token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2024-11-05',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: argumentsValue },
        }),
      });
    const allowedRead = await connector('bureau.tasks.get', { taskId: run.id });
    expect(await allowedRead.text()).toContain(run.id);
    const deniedWrite = await connector('bureau.tasks.cancel', { taskId: run.id });
    expect(await deniedWrite.text()).toContain('error');
    const deniedRead = await connector('bureau.reviews.list', {});
    expect(await deniedRead.text()).toContain('error');
    const connectorKeys = await send('/key-admin/jsonrpc', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'api.keys.list', params: {} }),
    });
    expect(connectorKeys.status).toBe(403);
    const wrongSurface = await send('/api/v1/principal', {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(wrongSurface.status).toBe(401);
    const resourceCall = await send('/bureau/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'ui://private' },
      }),
    });
    expect(resourceCall.status).toBe(403);
    members.delete('admin');
    const removedGrant = await connector('bureau.tasks.get', { taskId: run.id });
    expect(removedGrant.status).toBe(401);
  } finally {
    releaseStream.resolve();
    releaseLoad.resolve();
    releaseKeyTargets.resolve();
    await host.close();
    provider.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});
