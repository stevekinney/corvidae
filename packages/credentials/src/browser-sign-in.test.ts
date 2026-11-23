import { MemoryStorage } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { createApplication } from '@lostgradient/velveteen/server';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from 'openid-client';
import { createBrowserSignIn } from './browser-sign-in.ts';

test('requires storage with atomic conditional writes', () => {
  using storage = new MemoryStorage();
  const unsupported = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'capabilities')
        return () => ({ ...target.capabilities(), conditionalBatch: false });
      return Reflect.get(target, property, receiver);
    },
  });
  expect(() =>
    createBrowserSignIn({
      publicOrigin: 'https://app.example',
      storage: unsupported,
      workspaceId: 'workspace',
      cookieName: 'session',
      provider: {} as never,
      resolveAccount: async () => 'account',
      resolveMembership: async () => ({ workspaceId: 'workspace' }),
    }),
  ).toThrow();
});

const base64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const json = (value: unknown) => base64(new TextEncoder().encode(JSON.stringify(value)));

for (const mounted of [false, true]) {
  test(`browser sign-in lifecycle (${mounted ? 'Velveteen' : 'Fetch'})`, async () => {
    const keys = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    let issuer = '',
      subject = 'first',
      fault = '';
    const codes = new Map<
      string,
      { nonce: string; challenge: string; subject: string; redirect: string }
    >();
    const server = Bun.serve({
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
          codes.set(code, {
            nonce: url.searchParams.get('nonce')!,
            challenge: url.searchParams.get('code_challenge')!,
            subject,
            redirect,
          });
          const callback = new URL(redirect);
          callback.searchParams.set('code', code);
          callback.searchParams.set('state', url.searchParams.get('state')!);
          return Response.redirect(callback, 302);
        }
        if (url.pathname !== '/token') return new Response('Not Found', { status: 404 });
        const body = new URLSearchParams(await request.text());
        const code = body.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
        if (
          !grant ||
          body.get('redirect_uri') !== grant.redirect ||
          (await client.calculatePKCECodeChallenge(body.get('code_verifier') ?? '')) !==
            grant.challenge
        )
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: fault === 'issuer' ? 'https://wrong.test' : issuer,
          sub: fault === 'subject' ? '' : grant.subject,
          aud: fault === 'audience' ? 'wrong' : 'application',
          iat: now,
          exp: fault === 'expiry' ? now - 300 : now + 600,
          nonce: fault === 'nonce' ? 'wrong' : grant.nonce,
          email: 'same@example.test',
        };
        const payload = `${json({ alg: 'RS256', kid: 'key' })}.${json(claims)}`;
        const signature = await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          keys.privateKey,
          new TextEncoder().encode(payload),
        );
        return Response.json({
          access_token: 'upstream-secret',
          token_type: 'Bearer',
          id_token: `${payload}.${fault === 'signature' ? base64(new Uint8Array(signature).fill(1)) : base64(new Uint8Array(signature))}`,
        });
      },
    });
    using issuerCleanup = { [Symbol.dispose]: () => server.stop(true) };
    void issuerCleanup;
    issuer = `http://127.0.0.1:${server.port}`;
    const configuration = await client.discovery(
      new URL(issuer),
      'application',
      { client_secret: 'secret', [client.clockTolerance]: 0 },
      undefined,
      { execute: [client.allowInsecureRequests, client.enableNonRepudiationChecks] },
    );
    const directory = mkdtempSync(
      join(process.env['CREDENTIALS_TEST_DIRECTORY'] ?? tmpdir(), 'credentials-'),
    );
    using cleanup = { [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) };
    void cleanup;
    let storage = new BunSQLiteStorage(join(directory, 'sessions.sqlite'));
    using storageCleanup = { [Symbol.dispose]: () => storage[Symbol.dispose]() };
    void storageCleanup;
    using otherStorage = new BunSQLiteStorage(join(directory, 'sessions.sqlite'));
    let active = true;
    const options = {
      publicOrigin: 'https://app.test',
      storage,
      workspaceId: 'workspace',
      cookieName: 'session',
      provider: Promise.resolve(configuration),
      resolveAccount: async ({ issuer, subject }: { issuer: string; subject: string }) =>
        `${issuer}:${subject}`,
      resolveMembership: async ({ workspaceId }: { workspaceId: string }) =>
        active ? { workspaceId } : null,
    };
    let first = createBrowserSignIn(options);
    const second = createBrowserSignIn({ ...options, storage: otherStorage });
    const host = async (service: typeof first) => {
      const applicationFetch = async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path.startsWith('/auth/')) return service.fetch(request);
        const session = await service.currentSession(request);
        if (!session)
          return path === '/api'
            ? Response.json({ error: 'unauthorized' }, { status: 401 })
            : service.startSignIn(request);
        return Response.json({ subjectId: session.subjectId, workspaceId: session.workspaceId });
      };
      if (!mounted) return applicationFetch;
      const app = await createApplication({
        generation: {
          directory: '.',
          manifest: {
            version: 1,
            basePath: '',
            routing: { version: 1, nodes: [], routes: [] },
            client: { file: '', url: '', stylesheets: [], nodes: {} },
            server: { file: '', nodes: {} },
            routes: {},
            assets: [],
            outputs: [],
          },
        },
        registry: {
          manifest: { version: 1, nodes: [], routes: [] },
          nodes: [],
          Root: {} as never,
          render: () => ({ body: '', head: '' }),
        },
        hooks: { handle: ({ event }) => applicationFetch(event.request) },
      });
      return app.fetch;
    };
    let fetchFirst = await host(first);
    const fetchSecond = await host(second);
    const status = async (response: Promise<Response>) => {
      const result = await response;
      return result.status;
    };
    expect(await status(fetchFirst(new Request('https://app.test/api')))).toBe(401);
    expect(await status(fetchFirst(new Request('https://app.test/private')))).toBe(303);
    const start = async (destination = '/private?tab=1') => {
      const response = await fetchFirst(
        new Request(`https://app.test/auth/sign-in?returnTo=${encodeURIComponent(destination)}`),
      );
      const authorization = new URL(response.headers.get('location')!);
      expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorization.searchParams.get('code_challenge')).toBeTruthy();
      expect(authorization.searchParams.get('state')).toBeTruthy();
      expect(authorization.searchParams.get('nonce')).toBeTruthy();
      const issued = await fetch(authorization, { redirect: 'manual' });
      const callback = new URL(issued.headers.get('location')!);
      return {
        authorization,
        code: callback.searchParams.get('code')!,
        binding: response.headers.getSetCookie()[0].split(';')[0],
      };
    };
    const finish = async (
      attempt: Awaited<ReturnType<typeof start>>,
      state = attempt.authorization.searchParams.get('state')!,
    ) => {
      return fetchSecond(
        new Request(`https://app.test/auth/callback?code=${attempt.code}&state=${state}`, {
          headers: { cookie: attempt.binding },
        }),
      );
    };
    const one = await start();
    subject = 'second';
    const two = await start();
    expect(await status(finish(one, two.authorization.searchParams.get('state')!))).toBe(400);
    storage[Symbol.dispose]();
    storage = new BunSQLiteStorage(join(directory, 'sessions.sqlite'));
    first = createBrowserSignIn({ ...options, storage });
    fetchFirst = await host(first);
    const response = await finish(one);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://app.test/private?tab=1');
    expect(response.headers.getSetCookie()[0]).toContain('HttpOnly; SameSite=Lax');
    expect(response.headers.getSetCookie()[0]).toContain('Secure');
    const sessionCookie = response.headers.getSetCookie()[0].split(';')[0];
    const session = await second.currentSession(
      new Request('https://app.test/private', { headers: { cookie: sessionCookie } }),
    );
    expect(session?.subjectId).toBe(`${issuer}:first`);
    expect(session?.workspaceId).toBe('workspace');
    const pageResponse = await fetchSecond(
      new Request('https://app.test/private', { headers: { cookie: sessionCookie } }),
    );
    const page = await pageResponse.text();
    expect(JSON.parse(page)).toEqual({
      subjectId: `${issuer}:first`,
      workspaceId: 'workspace',
    });
    expect(page).not.toContain(sessionCookie.split('=')[1]);
    expect(page).not.toContain('upstream-secret');
    const binding = await second.consentBinding(
      new Request('https://app.test/', { headers: { cookie: sessionCookie } }),
    );
    expect(binding).toBeTruthy();
    expect(binding).not.toBe(sessionCookie.split('=')[1]);
    expect(page).not.toContain(binding!);
    expect(await status(finish(one))).toBe(400);
    subject = 'second';
    const secondResponse = await finish(two);
    expect(secondResponse.status).toBe(303);
    expect(await status(finish(two))).toBe(400);
    const secondCookie = secondResponse.headers.getSetCookie()[0].split(';')[0];
    const secondSession = await first.currentSession(
      new Request('https://app.test/', { headers: { cookie: secondCookie } }),
    );
    expect(secondSession?.subjectId).not.toBe(session?.subjectId);
    const sessionCount = async () => {
      let count = 0;
      for await (const ignored of storage.scan('browser-sign-in:session:session:')) {
        void ignored;
        count++;
      }
      return count;
    };
    expect(await sessionCount()).toBe(2);
    for (const invalid of ['nonce', 'issuer', 'signature', 'audience', 'subject', 'expiry']) {
      fault = invalid;
      const attempt = await start();
      expect(await status(finish(attempt))).toBe(400);
      expect(await sessionCount()).toBe(2);
    }
    fault = '';
    const attempt = await start('https://evil.test/');
    expect(await status(finish(attempt, 'invalid_state_that_is_long_enough'))).toBe(400);
    expect(await sessionCount()).toBe(2);
    const safeRedirect = await finish(attempt);
    expect(safeRedirect.headers.get('location')).toBe('https://app.test/');
    const write = (origin: string, csrf: string) =>
      new Request('https://app.test/auth/sign-out', {
        method: 'POST',
        headers: { cookie: sessionCookie, origin, 'x-csrf-token': csrf },
      });
    expect(await status(fetchSecond(write('https://evil.test', session!.csrfToken)))).toBe(403);
    expect(await status(fetchSecond(write('https://app.test', 'wrong')))).toBe(403);
    expect(
      await first.currentSession(
        new Request('https://app.test/', { headers: { cookie: sessionCookie } }),
      ),
    ).not.toBeNull();
    const signout = await fetchSecond(write('https://app.test', session!.csrfToken));
    expect(signout.status).toBe(303);
    expect(signout.headers.getSetCookie()[0]).toContain('Max-Age=0');
    expect(
      await first.currentSession(
        new Request('https://app.test/', { headers: { cookie: sessionCookie } }),
      ),
    ).toBeNull();
    expect(
      await second.currentSession(
        new Request('https://app.test/', { headers: { cookie: sessionCookie } }),
      ),
    ).toBeNull();
    active = false;
    expect(
      await status(
        fetchFirst(new Request('https://app.test/api', { headers: { cookie: secondCookie } })),
      ),
    ).toBe(401);
    expect(
      await second.currentSession(
        new Request('https://app.test/', { headers: { cookie: secondCookie } }),
      ),
    ).toBeNull();
    expect(
      await status(
        fetchSecond(new Request('https://app.test/api', { headers: { cookie: secondCookie } })),
      ),
    ).toBe(401);
    for await (const [key, value] of storage.scan('browser-sign-in:')) {
      const record = key + new TextDecoder().decode(value);
      expect(record).not.toContain(secondCookie.split('=')[1]);
      expect(record).not.toContain('upstream-secret');
    }
  });
}
