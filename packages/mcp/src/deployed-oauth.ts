import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHash, randomBytes } from 'node:crypto';
import {
  parseProbeConfiguration,
  type ProbeConfiguration,
  type ProbeFetch,
} from './deployed-smoke';

export async function initializeMcp(resource: string, token: string, request: ProbeFetch = fetch) {
  const client = new Client({ name: 'deployed-oauth-probe', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return request(input instanceof Request ? input.url : input, { ...init, headers });
    },
  });
  try {
    await client.connect(transport);
  } finally {
    await client.close();
  }
}

export async function prepareOAuth(
  configuration: ProbeConfiguration,
  redirectUri: string,
  identityOrigin: string,
  request: ProbeFetch = fetch,
) {
  configuration = { ...configuration, scopes: [...configuration.scopes] };
  const resource = configuration.origin + configuration.path;
  const metadataResponse = await request(
    `${configuration.origin}/.well-known/oauth-authorization-server`,
    { redirect: 'manual' },
  );
  if (!metadataResponse.ok) throw new Error('Authorization server metadata unavailable');
  const metadata = (await metadataResponse.json()) as Record<string, unknown>;
  if (metadata['issuer'] !== configuration.origin) throw new Error('Issuer mismatch');
  const endpoint = (name: string): string => {
    if (!Object.hasOwn(metadata, name)) throw new Error(`Missing ${name}`);
    const value = metadata[name];
    if (typeof value !== 'string' || new URL(value).origin !== configuration.origin)
      throw new Error(`Invalid ${name}`);
    return value;
  };
  const registrationEndpoint = endpoint('registration_endpoint');
  const authorizationEndpoint = endpoint('authorization_endpoint');
  const tokenEndpoint = endpoint('token_endpoint');
  const revocationEndpoint = endpoint('revocation_endpoint');
  const registration = await request(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Corvidae deployed OAuth probe',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (registration.status !== 201)
    throw new Error(`Dynamic registration returned HTTP ${registration.status}`);
  const body = (await registration.json()) as { client_id?: unknown };
  if (typeof body.client_id !== 'string' || !body.client_id)
    throw new Error('Registration did not return a client ID');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const parameters = new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'invalid-probe-code',
    redirect_uri: redirectUri,
    client_id: body.client_id,
    code_verifier: verifier,
    resource,
  });
  const invalid = await request(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: parameters,
  });
  const invalidBody = (await invalid.json().catch(() => ({}))) as { error?: unknown };
  if (invalid.status < 400 || invalid.status >= 500 || invalidBody.error !== 'invalid_grant')
    throw new Error('Token endpoint did not reject an invalid grant');
  const authorization = new URL(authorizationEndpoint);
  authorization.search = new URLSearchParams({
    response_type: 'code',
    client_id: body.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
    scope: configuration.scopes.join(' '),
    state,
  }).toString();
  const response = await request(authorization, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (
    response.status < 300 ||
    response.status >= 400 ||
    !location ||
    new URL(location, authorization).origin !== identityOrigin
  )
    throw new Error(
      `Unauthenticated authorization did not redirect to the expected identity provider (HTTP ${response.status})`,
    );
  return {
    authorization,
    clientId: body.client_id,
    verifier,
    state,
    resource,
    tokenEndpoint,
    revocationEndpoint,
  };
}

if (import.meta.main) {
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const parameters = process.argv.slice(2);
    const prepareOnly = parameters.includes('--prepare-only');
    const identityIndex = parameters.indexOf('--identity-origin');
    if (identityIndex < 0 || !parameters[identityIndex + 1])
      throw new Error('Provide --identity-origin <https-origin>');
    const identityOrigin = parameters[identityIndex + 1]!;
    if (new URL(identityOrigin).origin !== identityOrigin || !identityOrigin.startsWith('https://'))
      throw new Error('Expected an HTTPS identity-provider origin');
    parameters.splice(identityIndex, 2);
    const configuration = parseProbeConfiguration(
      parameters.filter((argument) => argument !== '--prepare-only'),
    );
    let authorization: URL | undefined;
    const callback = Promise.withResolvers<URL>();
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/start' && authorization) return Response.redirect(authorization);
        if (url.pathname === '/callback') {
          callback.resolve(url);
          return new Response('Return to the terminal.');
        }
        return new Response(null, { status: 404 });
      },
    });
    const redirectUri = new URL('/callback', server.url).href;
    const prepared = await prepareOAuth(configuration, redirectUri, identityOrigin);
    authorization = prepared.authorization;
    console.info(
      `OAuth discovery, registration, invalid-grant and sign-in redirect passed for ${prepared.resource}.`,
    );
    console.info('Dynamic registration creates a persistent probe client on the issuer.');
    if (prepareOnly) {
      console.info(
        'Interactive continuation required: rerun without --prepare-only, then sign in and approve consent in the browser.',
      );
    } else {
      console.info(
        `Open ${new URL('/start', server.url).href} and complete sign-in and consent with the synthetic test identity.`,
      );
      const returned = await callback.promise;
      if (
        returned.searchParams.get('state') !== prepared.state ||
        !returned.searchParams.get('code')
      )
        throw new Error('Invalid authorization callback');
      const tokenResponse = await fetch(prepared.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: returned.searchParams.get('code')!,
          redirect_uri: redirectUri,
          client_id: prepared.clientId,
          code_verifier: prepared.verifier,
          resource: prepared.resource,
        }),
      });
      if (!tokenResponse.ok)
        throw new Error(`Token exchange returned HTTP ${tokenResponse.status}`);
      const token = (await tokenResponse.json()) as { access_token?: unknown };
      if (typeof token.access_token !== 'string')
        throw new Error('Token exchange did not return an access token');
      let accessFailure: unknown;
      try {
        await initializeMcp(prepared.resource, token.access_token);
      } catch (error) {
        accessFailure = error;
      }
      const revoked = await fetch(prepared.revocationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: token.access_token, client_id: prepared.clientId }),
      });
      if (!revoked.ok) throw new Error(`Revocation returned HTTP ${revoked.status}`);
      if (accessFailure) throw accessFailure;
      console.info('Token exchange, authenticated initialization and revocation passed.');
    }
  } catch (error) {
    console.error(`OAuth probe failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await server?.stop(true);
  }
}
