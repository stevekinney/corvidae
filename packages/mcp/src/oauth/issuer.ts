import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { OAuthStore, type OAuthClient } from '../oauth-store.ts';
import { fetchClientIdMetadataDocument } from './client-metadata-documents.ts';
import { isValidClientName, isValidRedirectUri } from './security-utilities.ts';

type Identity = { subject: string; tenant: string; binding: string };
type Options = {
  issuer: string;
  resource: string;
  scopes: string[];
  startingScopes: string[];
  scopeDescriptions: Record<string, string>;
  store: OAuthStore;
  identity: {
    session(request: Request): Promise<Identity | null>;
    signIn(request: Request): Promise<Response>;
    principalForGrant(identity: {
      subject: string;
      tenant: string;
    }): Promise<{ delegableScopes: string[] } | null>;
  };
};
const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const escape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const json = (payload: unknown, status = 200) =>
  Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
const error = (name: string, status = 400) => json({ error: name }, status);
const registration = z.object({
  client_name: z.string().min(1).max(200).refine(isValidClientName).default('Unknown Client'),
  redirect_uris: z.array(z.string().max(2048).refine(isValidRedirectUri)).min(1).max(10),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .max(5)
    .default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).max(5).default(['code']),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post']).default('client_secret_post'),
  application_type: z.enum(['web', 'native']).optional(),
});

async function body(request: Request, type: string): Promise<string | null> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== type)
    return null;
  if (Number(request.headers.get('content-length')) > 16384 || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 16384) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parameters(value: string): URLSearchParams | null {
  const result = new URLSearchParams(value);
  for (const name of result.keys()) if (result.getAll(name).length !== 1) return null;
  return result;
}

export function hostedOAuth(configuration: Options) {
  const options = {
    ...configuration,
    scopes: [...configuration.scopes],
    startingScopes: [...configuration.startingScopes],
    scopeDescriptions: { ...configuration.scopeDescriptions },
  };
  const issuer = new URL(options.issuer);
  const resource = new URL(options.resource);
  const prefix = issuer.pathname === '/' ? '' : issuer.pathname;
  if (
    issuer.protocol !== 'https:' ||
    issuer.href.replace(/\/$/, '') !== options.issuer ||
    issuer.search ||
    issuer.hash ||
    issuer.username ||
    issuer.password ||
    resource.protocol !== 'https:' ||
    resource.username ||
    resource.password ||
    resource.hash ||
    options.scopes.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)) ||
    options.startingScopes.some((scope) => !options.scopes.includes(scope))
  )
    throw new TypeError('Invalid OAuth configuration');
  const clientFor = async (id: string): Promise<OAuthClient | null> => {
    const saved = await options.store.getClient(id);
    if (saved) return saved.issuer === options.issuer ? saved : null;
    const document = await fetchClientIdMetadataDocument(id);
    return document
      ? {
          issuer: options.issuer,
          clientId: document.clientId,
          name: document.clientName,
          redirectUris: document.redirectUris,
          grantTypes: document.grantTypes,
          authentication: 'none',
          secretHash: null,
        }
      : null;
  };
  const authenticate = async (form: URLSearchParams): Promise<OAuthClient | null> => {
    const client = await clientFor(form.get('client_id') ?? '');
    if (!client) return null;
    const secret = form.get('client_secret');
    if (client.authentication === 'none') return secret === null ? client : null;
    if (!secret || !client.secretHash) return null;
    const actual = Buffer.from(digest(secret), 'hex');
    const expected = Buffer.from(client.secretHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? client : null;
  };
  const authority = (identity: { subject: string; tenant: string }) =>
    options.identity.principalForGrant(identity);
  const register = async (request: Request) => {
    const text = await body(request, 'application/json');
    if (text === null) return error('invalid_request');
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return error('invalid_request');
    }
    const parsed = registration.safeParse(input);
    if (
      !parsed.success ||
      (parsed.data.application_type === 'web' &&
        parsed.data.redirect_uris.some((uri) => new URL(uri).protocol !== 'https:'))
    )
      return error('invalid_client_metadata');
    const data = parsed.data;
    const clientId = randomUUID();
    const secret = data.token_endpoint_auth_method === 'client_secret_post' ? random() : null;
    const registered = await options.store.registerClient({
      issuer: options.issuer,
      clientId,
      name: data.client_name,
      redirectUris: data.redirect_uris,
      grantTypes: data.grant_types,
      authentication: data.token_endpoint_auth_method,
      secretHash: secret ? digest(secret) : null,
    });
    if (!registered) return error('server_error', 500);
    return json(
      {
        ...data,
        client_id: clientId,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      },
      201,
    );
  };
  const authorize = async (request: Request) => {
    const form = parameters(new URL(request.url).search.slice(1));
    if (!form) return error('invalid_request');
    const client = await clientFor(form.get('client_id') ?? '');
    const redirect = form.get('redirect_uri') ?? '';
    const challenge = form.get('code_challenge') ?? '';
    if (
      !client ||
      !client.redirectUris.includes(redirect) ||
      form.get('response_type') !== 'code' ||
      !client.grantTypes.includes('authorization_code') ||
      form.get('code_challenge_method') !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
      form.get('resource') !== options.resource
    )
      return error('invalid_request');
    const identity = await options.identity.session(request);
    if (!identity) return options.identity.signIn(request);
    const principal = await authority(identity);
    if (!principal) return error('access_denied', 403);
    const requested = form.get('scope');
    const scopes = [
      ...new Set(
        requested === null
          ? options.startingScopes.filter((scope) => principal.delegableScopes.includes(scope))
          : requested.split(' ').filter(Boolean),
      ),
    ].toSorted();
    if (
      !scopes.length ||
      scopes.some(
        (scope) => !options.scopes.includes(scope) || !principal.delegableScopes.includes(scope),
      )
    )
      return error('invalid_scope');
    const transaction = random();
    const csrf = random();
    const created = await options.store.createConsent(transaction, {
      issuer: options.issuer,
      client: client.clientId,
      redirect,
      csrf,
      binding: identity.binding,
      subject: identity.subject,
      tenant: identity.tenant,
      challenge,
      resource: options.resource,
      scopes,
      state: form.get('state') ?? '',
      expiresAt: Date.now() + 600_000,
    });
    if (!created) return error('server_error', 500);
    const fields = [
      ['transaction', transaction],
      ['csrf', csrf],
      ['client_id', client.clientId],
    ]
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(value!)}">`)
      .join('');
    return new Response(
      `<!doctype html><html><body><h1>Authorize ${escape(client.name)}</h1><p>${escape(identity.subject)} ${escape(identity.tenant)}</p><p>${escape(options.resource)}</p><ul>${scopes.map((scope) => `<li>${escape(Object.hasOwn(options.scopeDescriptions, scope) ? options.scopeDescriptions[scope]! : scope)}</li>`).join('')}</ul><form method="post">${fields}<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form></body></html>`,
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'",
          'x-content-type-options': 'nosniff',
        },
      },
    );
  };
  const consent = async (request: Request) => {
    const text = await body(request, 'application/x-www-form-urlencoded');
    const form = text === null ? null : parameters(text);
    const identity = await options.identity.session(request);
    if (!form || !identity) return error('invalid_request');
    const transaction = form.get('transaction') ?? '';
    const binding = {
      issuer: options.issuer,
      client: form.get('client_id') ?? '',
      csrf: form.get('csrf') ?? '',
      binding: identity.binding,
      subject: identity.subject,
    };
    const pending = await options.store.getConsent(transaction, binding);
    if (!pending || pending.tenant !== identity.tenant || !pending.resource || !pending.scopes)
      return error('invalid_request');
    const decision = form.get('decision');
    const destination = new URL(pending.redirect);
    if (pending.state) destination.searchParams.set('state', pending.state);
    destination.searchParams.set('iss', options.issuer);
    if (decision === 'deny') {
      if (!(await options.store.denyConsent(transaction, binding))) return error('invalid_request');
      destination.searchParams.set('error', 'access_denied');
    } else if (decision === 'approve') {
      const principal = await authority(identity);
      if (!principal || pending.scopes.some((scope) => !principal.delegableScopes.includes(scope)))
        return error('access_denied', 403);
      const code = random();
      if (
        !(await options.store.approveConsent(transaction, binding, {
          grantId: randomUUID(),
          code,
          subject: identity.subject,
          tenant: identity.tenant,
          resource: pending.resource,
          scopes: pending.scopes,
        }))
      )
        return error('invalid_request');
      destination.searchParams.set('code', code);
    } else return error('invalid_request');
    return new Response(null, {
      status: 302,
      headers: { location: destination.href, 'cache-control': 'no-store' },
    });
  };
  const token = async (request: Request) => {
    const text = await body(request, 'application/x-www-form-urlencoded');
    const form = text === null ? null : parameters(text);
    if (!form) return error('invalid_request');
    const client = await authenticate(form);
    if (!client) return error('invalid_client', 401);
    const type = form.get('grant_type') ?? '';
    if (type !== 'authorization_code' && type !== 'refresh_token')
      return error('unsupported_grant_type');
    if (!client.grantTypes.includes(type)) return error('unauthorized_client');
    const access = random();
    const refresh = random();
    const expiresAt = Date.now() + 3600_000;
    if (type === 'authorization_code') {
      const code = await options.store.getCode(form.get('code') ?? '');
      const grant = code ? await options.store.getGrant(code.grantId) : null;
      const principal = grant ? await authority(grant) : null;
      if (
        !grant ||
        grant.issuer !== options.issuer ||
        !principal ||
        grant.scopes.some((scope) => !principal.delegableScopes.includes(scope))
      )
        return error('invalid_grant');
      const valid = await options.store.exchange({
        issuer: options.issuer,
        code: form.get('code') ?? '',
        client: client.clientId,
        redirect: form.get('redirect_uri') ?? '',
        verifier: form.get('code_verifier') ?? '',
        resource: form.get('resource') ?? '',
        access,
        refresh: client.grantTypes.includes('refresh_token') ? refresh : null,
        expiresAt,
      });
      if (!valid) return error('invalid_grant');
    } else if (type === 'refresh_token') {
      const prior = form.get('refresh_token') ?? '';
      const grant = await options.store.getRefreshGrant(prior);
      if (
        !grant ||
        grant.issuer !== options.issuer ||
        grant.client !== client.clientId ||
        grant.resource !== form.get('resource')
      )
        return error('invalid_grant');
      const principal = await authority(grant);
      if (!principal) return error('invalid_grant');
      const scopes = form.has('scope')
        ? (form.get('scope') ?? '').split(' ').filter(Boolean)
        : grant.scopes.filter((scope) => principal.delegableScopes.includes(scope));
      if (!scopes.length || scopes.some((scope) => !principal.delegableScopes.includes(scope)))
        return error('invalid_scope');
      const result = await options.store.rotate({
        issuer: options.issuer,
        refresh: prior,
        client: client.clientId,
        resource: form.get('resource') ?? '',
        access,
        nextRefresh: refresh,
        expiresAt,
        scopes,
      });
      if (result !== 'rotated')
        return error(result === 'scope_rejected' ? 'invalid_scope' : 'invalid_grant');
    } else return error('unsupported_grant_type');
    const grant = await options.store.getAccess(access);
    if (!grant) return error('invalid_grant');
    return json({
      access_token: access,
      ...(client.grantTypes.includes('refresh_token') ? { refresh_token: refresh } : {}),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: grant.scopes.join(' '),
    });
  };
  const handle = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (request.url.length > 8192) return error('invalid_request');
      if (
        url.pathname === `/.well-known/oauth-authorization-server${prefix}` &&
        request.method === 'GET'
      )
        return json({
          issuer: options.issuer,
          authorization_endpoint: `${options.issuer}/oauth/authorize`,
          token_endpoint: `${options.issuer}/oauth/token`,
          registration_endpoint: `${options.issuer}/oauth/register`,
          revocation_endpoint: `${options.issuer}/oauth/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
          scopes_supported: options.scopes,
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
      if (url.pathname === `${prefix}/oauth/register` && request.method === 'POST')
        return await register(request);
      if (url.pathname === `${prefix}/oauth/authorize` && request.method === 'GET')
        return await authorize(request);
      if (url.pathname === `${prefix}/oauth/authorize` && request.method === 'POST')
        return await consent(request);
      if (url.pathname === `${prefix}/oauth/token` && request.method === 'POST')
        return await token(request);
      if (url.pathname === `${prefix}/oauth/revoke` && request.method === 'POST') {
        const text = await body(request, 'application/x-www-form-urlencoded');
        const form = text === null ? null : parameters(text);
        if (!form) return error('invalid_request');
        const client = await authenticate(form);
        if (!client) return error('invalid_client', 401);
        await options.store.revokeToken(form.get('token') ?? '', options.issuer, client.clientId);
        return json({});
      }
      return new Response(null, { status: 404 });
    } catch {
      return error('server_error', 500);
    }
  };
  const verifyAccessToken = async (credential: string) => {
    const grant = await options.store.getAccess(credential);
    if (!grant || grant.issuer !== options.issuer) return null;
    const principal = await authority(grant);
    if (!principal || grant.scopes.some((scope) => !principal.delegableScopes.includes(scope)))
      return null;
    const current = await options.store.getAccess(credential);
    if (
      !current ||
      current.issuer !== grant.issuer ||
      current.grantId !== grant.grantId ||
      current.subject !== grant.subject ||
      current.tenant !== grant.tenant ||
      current.client !== grant.client ||
      current.resource !== grant.resource ||
      current.expiresAt !== grant.expiresAt ||
      current.scopes.length !== grant.scopes.length ||
      current.scopes.some((scope, index) => scope !== grant.scopes[index])
    )
      return null;
    return {
      issuer: options.issuer,
      audience: grant.resource,
      expiresAt: grant.expiresAt,
      subject: grant.subject,
      scopes: grant.scopes,
    };
  };
  return { handle, verifyAccessToken };
}
