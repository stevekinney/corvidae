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
    const configuration = new client.Configuration(
      {
        issuer: 'https://issuer.test',
        authorization_endpoint: 'https://issuer.test/authorize',
        token_endpoint: 'https://issuer.test/token',
        jwks_uri: 'https://issuer.test/jwks',
      },
      'application',
      { client_secret: 'secret', [client.clockTolerance]: 0 },
    );
    client.enableNonRepudiationChecks(configuration);
    let nonce = '',
      challenge = '',
      subject = 'first',
      fault = '';
    configuration[client.customFetch] = async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === '/jwks')
        return Response.json({ keys: [{ ...jwk, kid: 'key', alg: 'RS256', use: 'sig' }] });
      const body = new URLSearchParams(init?.body as string);
      expect(await client.calculatePKCECodeChallenge(body.get('code_verifier')!)).toBe(challenge);
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: fault === 'issuer' ? 'https://wrong.test' : 'https://issuer.test',
        sub: fault === 'subject' ? '' : subject,
        aud: fault === 'audience' ? 'wrong' : 'application',
        iat: now,
        exp: fault === 'expiry' ? now - 300 : now + 600,
        nonce: fault === 'nonce' ? 'wrong' : nonce,
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
    };
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
    expect((await fetchFirst(new Request('https://app.test/api'))).status).toBe(401);
    expect((await fetchFirst(new Request('https://app.test/private'))).status).toBe(303);
    const start = async (destination = '/private?tab=1') => {
      const response = await fetchFirst(
        new Request(`https://app.test/auth/sign-in?returnTo=${encodeURIComponent(destination)}`),
      );
      const authorization = new URL(response.headers.get('location')!);
      expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorization.searchParams.get('code_challenge')).toBeTruthy();
      expect(authorization.searchParams.get('state')).toBeTruthy();
      expect(authorization.searchParams.get('nonce')).toBeTruthy();
      return { authorization, binding: response.headers.getSetCookie()[0]!.split(';')[0]! };
    };
    const finish = async (
      attempt: Awaited<ReturnType<typeof start>>,
      state = attempt.authorization.searchParams.get('state')!,
    ) => {
      nonce = attempt.authorization.searchParams.get('nonce')!;
      challenge = attempt.authorization.searchParams.get('code_challenge')!;
      return fetchSecond(
        new Request(`https://app.test/auth/callback?code=valid&state=${state}`, {
          headers: { cookie: attempt.binding },
        }),
      );
    };
    const one = await start(),
      two = await start();
    expect((await finish(one, two.authorization.searchParams.get('state')!)).status).toBe(400);
    storage[Symbol.dispose]();
    storage = new BunSQLiteStorage(join(directory, 'sessions.sqlite'));
    first = createBrowserSignIn({ ...options, storage });
    fetchFirst = await host(first);
    const response = await finish(one);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://app.test/private?tab=1');
    expect(response.headers.getSetCookie()[0]).toContain('HttpOnly; SameSite=Lax');
    expect(response.headers.getSetCookie()[0]).toContain('Secure');
    const sessionCookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    const session = await second.currentSession(
      new Request('https://app.test/private', { headers: { cookie: sessionCookie } }),
    );
    expect(session?.subjectId).toBe('https://issuer.test:first');
    expect(session?.workspaceId).toBe('workspace');
    const page = await (
      await fetchSecond(
        new Request('https://app.test/private', { headers: { cookie: sessionCookie } }),
      )
    ).text();
    expect(JSON.parse(page)).toEqual({
      subjectId: 'https://issuer.test:first',
      workspaceId: 'workspace',
    });
    expect(page).not.toContain(sessionCookie.split('=')[1]!);
    expect(page).not.toContain('upstream-secret');
    const binding = await second.consentBinding(
      new Request('https://app.test/', { headers: { cookie: sessionCookie } }),
    );
    expect(binding).toBeTruthy();
    expect(binding).not.toBe(sessionCookie.split('=')[1]);
    expect(page).not.toContain(binding!);
    expect((await finish(one)).status).toBe(400);
    subject = 'second';
    const secondResponse = await finish(two);
    expect(secondResponse.status).toBe(303);
    expect((await finish(two)).status).toBe(400);
    const secondCookie = secondResponse.headers.getSetCookie()[0]!.split(';')[0]!;
    expect(
      (
        await first.currentSession(
          new Request('https://app.test/', { headers: { cookie: secondCookie } }),
        )
      )?.subjectId,
    ).not.toBe(session?.subjectId);
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
      expect((await finish(attempt)).status).toBe(400);
      expect(await sessionCount()).toBe(2);
    }
    fault = '';
    const attempt = await start('https://evil.test/');
    expect((await finish(attempt, 'invalid_state_that_is_long_enough')).status).toBe(400);
    expect(await sessionCount()).toBe(2);
    expect((await finish(attempt)).headers.get('location')).toBe('https://app.test/');
    const write = (origin: string, csrf: string) =>
      new Request('https://app.test/auth/sign-out', {
        method: 'POST',
        headers: { cookie: sessionCookie, origin, 'x-csrf-token': csrf },
      });
    expect((await fetchSecond(write('https://evil.test', session!.csrfToken))).status).toBe(403);
    expect((await fetchSecond(write('https://app.test', 'wrong'))).status).toBe(403);
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
    active = false;
    expect(
      (await fetchFirst(new Request('https://app.test/api', { headers: { cookie: secondCookie } })))
        .status,
    ).toBe(401);
    expect(
      await second.currentSession(
        new Request('https://app.test/', { headers: { cookie: secondCookie } }),
      ),
    ).toBeNull();
    expect(
      (
        await fetchSecond(
          new Request('https://app.test/api', { headers: { cookie: secondCookie } }),
        )
      ).status,
    ).toBe(401);
    for await (const [key, value] of storage.scan('browser-sign-in:')) {
      const record = key + new TextDecoder().decode(value);
      expect(record).not.toContain(secondCookie.split('=')[1]!);
      expect(record).not.toContain('upstream-secret');
    }
  });
}
