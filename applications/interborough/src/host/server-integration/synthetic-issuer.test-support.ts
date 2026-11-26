import * as client from 'openid-client';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function createSyntheticIssuer() {
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
  return {
    issuer,
    provider,
    setSubject(value: string) {
      subject = value;
    },
  };
}
