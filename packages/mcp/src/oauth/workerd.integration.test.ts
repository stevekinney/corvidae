import { withWorker } from '@lostgradient/workerd-testing';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

const entry = new URL('./workerd-fixture.ts', import.meta.url).pathname;
const issuer = 'https://issuer.test';
const callback = 'https://issuer.test/callback';

test('runs the hosted OAuth issuer in workerd with an injected DNS lookup', async () => {
  await withWorker({ entry }, async ({ dispatchFetch }) => {
    const request = (path: string, init?: Parameters<typeof dispatchFetch>[1]) =>
      dispatchFetch(`${issuer}${path}`, init);
    const registration = await request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Dynamic client',
        redirect_uris: [callback],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };
    const verifier = 'a'.repeat(43);
    const authorize = async (clientId = client.client_id) => {
      const parameters = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callback,
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: `${issuer}/protected`,
      });
      return request(`/oauth/authorize?${parameters}`);
    };
    const page = await authorize();
    expect(page.status).toBe(200);
    const html = await page.text();
    const transaction = /name="transaction" value="([^"]+)"/.exec(html)?.[1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(transaction).toBeTruthy();
    expect(csrf).toBeTruthy();
    const approval = await request('/oauth/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        transaction: transaction!,
        csrf: csrf!,
        client_id: client.client_id,
        decision: 'approve',
      }),
    });
    const code = new URL(approval.headers.get('location')!).searchParams.get('code');
    expect(code).toBeTruthy();
    const token = await request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: code!,
        redirect_uri: callback,
        code_verifier: verifier,
        resource: `${issuer}/protected`,
      }),
    });
    expect(token.status).toBe(200);
    const credentials = (await token.json()) as { access_token: string; refresh_token: string };
    const refreshed = await request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: credentials.refresh_token,
        resource: `${issuer}/protected`,
      }),
    });
    expect(refreshed.status).toBe(200);
    const replay = await request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: credentials.refresh_token,
        resource: `${issuer}/protected`,
      }),
    });
    expect(replay.status).toBe(400);
    const revocation = await request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        token: credentials.access_token,
      }),
    });
    expect(revocation.status).toBe(200);
    const protectedResponse = await request('/protected', {
      headers: { authorization: `Bearer ${credentials.access_token}` },
    });
    expect(protectedResponse.status).toBe(401);

    const metadataAuthorization = await authorize('https://upstream.test/metadata');
    expect(metadataAuthorization.status).toBe(200);
    const lookupState = (await request('/dns-lookup-calls').then((response) =>
      response.json(),
    )) as {
      lookupCalls: number;
    };
    expect(lookupState.lookupCalls).toBe(1);
  });
});
