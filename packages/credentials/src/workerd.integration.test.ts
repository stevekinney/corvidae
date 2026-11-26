import { expect, test } from 'bun:test';
import * as client from 'openid-client';

type WorkerBindings = {
  dispatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};
type WithWorker = <T>(
  options: { entry: string; outboundService: (request: Request) => Promise<Response> },
  callback: (bindings: WorkerBindings) => Promise<T>,
) => Promise<T>;

const workerdTestingPackage = '@lostgradient/workerd-testing';
const { withWorker } = (await import(workerdTestingPackage)) as {
  withWorker: WithWorker;
};
const entry = new URL('./workerd-fixture.ts', import.meta.url).pathname;
const encoder = new TextEncoder();
const base64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const json = (value: unknown) => base64(encoder.encode(JSON.stringify(value)));
const cookie = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(';', 1)[0];

test('runs API keys and browser sign-in in workerd', async () => {
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
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string }>();
  const requests = new Set<string>();
  const outboundService = async (request: Request) => {
    const url = new URL(request.url);
    if (url.origin !== 'https://identity.test') return new Response('Not Found', { status: 404 });
    requests.add(url.pathname);
    if (url.pathname === '/.well-known/openid-configuration')
      return Response.json({
        issuer: 'https://identity.test',
        authorization_endpoint: 'https://identity.test/authorize',
        token_endpoint: 'https://identity.test/token',
        jwks_uri: 'https://identity.test/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/jwks')
      return Response.json({ keys: [{ ...jwk, kid: 'identity-key', alg: 'RS256', use: 'sig' }] });
    if (url.pathname === '/authorize') {
      const code = crypto.randomUUID();
      const redirect = url.searchParams.get('redirect_uri')!;
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge')!,
        nonce: url.searchParams.get('nonce')!,
        redirect,
      });
      const callback = new URL(redirect);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      return Response.redirect(callback, 302);
    }
    if (url.pathname !== '/token') return new Response('Not Found', { status: 404 });
    const form = new URLSearchParams(await request.text());
    const grant = codes.get(form.get('code') ?? '');
    if (
      !grant ||
      form.get('redirect_uri') !== grant.redirect ||
      (await client.calculatePKCECodeChallenge(form.get('code_verifier') ?? '')) !== grant.challenge
    )
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    const now = Math.floor(Date.now() / 1000);
    const payload = `${json({ alg: 'RS256', kid: 'identity-key' })}.${json({
      iss: 'https://identity.test',
      sub: 'person',
      aud: 'credentials',
      iat: now,
      exp: now + 600,
      nonce: grant.nonce,
    })}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      keys.privateKey,
      encoder.encode(payload),
    );
    return Response.json({
      access_token: 'provider-token',
      token_type: 'Bearer',
      id_token: `${payload}.${base64(new Uint8Array(signature))}`,
    });
  };

  await withWorker({ entry, outboundService }, async ({ dispatchFetch }) => {
    const issuedResponse = await dispatchFetch('https://credentials.test/keys/issue', {
      method: 'POST',
    });
    const issued = (await issuedResponse.json()) as {
      id: string;
      secret: string;
    };
    const verified = await dispatchFetch('https://credentials.test/protected', {
      headers: { 'x-api-key': issued.secret },
    });
    expect(verified.status).toBe(200);
    const revoked = await dispatchFetch(`https://credentials.test/keys/revoke?id=${issued.id}`, {
      method: 'POST',
    });
    expect(revoked.status).toBe(204);
    const rejected = await dispatchFetch('https://credentials.test/protected', {
      headers: { 'x-api-key': issued.secret },
    });
    expect(rejected.status).toBe(401);

    const signIn = await dispatchFetch(
      'https://credentials.test/auth/sign-in?returnTo=/protected',
      {
        redirect: 'manual',
      },
    );
    expect(signIn.status, await signIn.text()).toBe(303);
    const transactionCookie = signIn.headers.getSetCookie()[0].split(';', 1)[0];
    if (!transactionCookie) throw new Error('Missing sign-in transaction cookie');
    const authorization = await outboundService(new Request(signIn.headers.get('location')!));
    expect(authorization.status).toBe(302);
    const callback = authorization.headers.get('location')!;
    const signedIn = await dispatchFetch(callback, {
      headers: { cookie: transactionCookie },
      redirect: 'manual',
    });
    expect(signedIn.status).toBe(303);
    const sessionCookie = cookie(signedIn, 'credentials_session')!;
    const authenticated = await dispatchFetch('https://credentials.test/protected', {
      headers: { cookie: sessionCookie },
    });
    expect(authenticated.status).toBe(200);
    expect(requests).toEqual(
      new Set(['/.well-known/openid-configuration', '/authorize', '/token', '/jwks']),
    );
  });
});
