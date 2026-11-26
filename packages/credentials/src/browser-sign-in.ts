import { storageConditionalBatch, type Storage } from '@lostgradient/storage';
import * as client from 'openid-client';

type Identity = { issuer: string; subject: string };
type Membership = { workspaceId: string; [key: string]: unknown };
type Transaction = {
  verifier: string;
  nonce: string;
  binding: string;
  returnTo: string;
  expires: number;
};
type Session = { subjectId: string; workspaceId: string; expires: number; consentBinding: string };

export type BrowserSignInOptions = {
  publicOrigin: string;
  storage: Storage;
  workspaceId: string;
  cookieName: string;
  provider: Promise<client.Configuration> | (() => Promise<client.Configuration>);
  resolveAccount: (identity: Identity) => Promise<string | null>;
  resolveMembership: (identity: {
    subjectId: string;
    workspaceId: string;
  }) => Promise<Membership | null>;
};

/** Discover a trusted OIDC issuer and require ID token signature verification. */
export function oidc(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetch?: client.CustomFetch;
}): () => Promise<client.Configuration> {
  return () =>
    client.discovery(
      new URL(options.issuer),
      options.clientId,
      { client_secret: options.clientSecret, [client.clockTolerance]: 0 },
      undefined,
      {
        execute: [client.enableNonRepudiationChecks],
        ...(options.fetch === undefined ? {} : { [client.customFetch]: options.fetch }),
      },
    );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));
const token = () => client.randomState();
const digest = async (value: string) => {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
const cookie = (request: Request, name: string) => {
  const parts = (request.headers.get('cookie') ?? '').split(';');
  const matches = parts.map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
};
const header = (name: string, value: string, maxAge: number, secure: boolean) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
const redirect = (location: string, cookies: string[]) => {
  const headers = new Headers({ location, 'cache-control': 'private, no-store' });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
};

/** Create a Fetch service backed by shared, atomic storage and app-owned identity policy. */
export function createBrowserSignIn(options: BrowserSignInOptions) {
  options = { ...options };
  const origin = new URL(options.publicOrigin);
  if (
    origin.origin !== options.publicOrigin ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      ))
  )
    throw new TypeError('publicOrigin must be a secure origin or loopback');
  if (!/^[a-zA-Z0-9_-]+$/.test(options.cookieName)) throw new TypeError('Invalid cookie name');
  if (!options.storage.capabilities().conditionalBatch || !options.storage.conditionalBatch)
    throw new TypeError('Atomic conditional storage is required');
  const secure = origin.protocol === 'https:';
  let configuredProvider: Promise<client.Configuration> | undefined;
  const provider = () =>
    (configuredProvider ??= Promise.resolve(
      typeof options.provider === 'function' ? options.provider() : options.provider,
    ).then((configuration) => {
      client.enableNonRepudiationChecks(configuration);
      return configuration;
    }));
  const prefix = `browser-sign-in:${options.cookieName}:`;
  const sessionKey = async (credential: string) => `${prefix}session:${await digest(credential)}`;
  const transactionKey = (state: string) => `${prefix}transaction:${state}`;
  const transactionCookie = (state: string) => `${options.cookieName}_login_${state}`;
  const csrfFor = (credential: string) => digest(`csrf:${credential}`);

  async function resolveSession(request: Request) {
    const credential = cookie(request, options.cookieName);
    if (!credential) return null;
    const key = await sessionKey(credential);
    const raw = await options.storage.get(key);
    if (!raw) return null;
    const session = JSON.parse(decoder.decode(raw)) as Session;
    if (session.expires <= Date.now()) return null;
    const membership = await options.resolveMembership({
      subjectId: session.subjectId,
      workspaceId: session.workspaceId,
    });
    if (!membership || membership.workspaceId !== session.workspaceId) return null;
    return { session, membership, credential, key, raw };
  }

  async function currentSession(request: Request) {
    const resolved = await resolveSession(request);
    if (!resolved) return null;
    const { session, membership, credential } = resolved;
    return {
      subjectId: session.subjectId,
      workspaceId: session.workspaceId,
      membership,
      csrfToken: await csrfFor(credential),
    };
  }

  async function validWrite(request: Request) {
    request = new Request(request);
    if (request.headers.get('origin') !== origin.origin) return false;
    const credential = cookie(request, options.cookieName);
    if (!credential || !(await currentSession(request))) return false;
    return request.headers.get('x-csrf-token') === (await csrfFor(credential));
  }

  async function startSignIn(
    request: Request,
    returnTo = new URL(request.url).pathname + new URL(request.url).search,
  ) {
    let destination = new URL('/', origin);
    try {
      const candidate = new URL(returnTo, origin);
      if (candidate.origin === origin.origin) destination = candidate;
    } catch {
      /* Use the safe default. */
    }
    const state = token(),
      binding = token(),
      nonce = token(),
      verifier = client.randomPKCECodeVerifier();
    const transaction: Transaction = {
      verifier,
      nonce,
      binding: await digest(binding),
      returnTo: destination.href,
      expires: Date.now() + 600_000,
    };
    const key = transactionKey(state);
    if (
      !(await storageConditionalBatch(
        options.storage,
        [{ key, expectedValue: null }],
        [{ type: 'put', key, value: encode(transaction) }],
      ))
    )
      throw new Error('Transaction collision');
    const configuration = await provider();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: new URL('/auth/callback', origin).href,
      scope: 'openid',
      response_type: 'code',
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    return redirect(url.href, [header(transactionCookie(state), binding, 600, secure)]);
  }

  async function callback(request: Request) {
    const url = new URL(request.url);
    // Mounts remove their prefix; the issuer must receive the registered public callback URI.
    url.pathname = '/auth/callback';
    const state = url.searchParams.get('state');
    if (!state || !/^[a-zA-Z0-9_-]{20,100}$/.test(state))
      return new Response('Invalid sign-in', { status: 400 });
    const binding = cookie(request, transactionCookie(state));
    const key = transactionKey(state);
    const raw = await options.storage.get(key);
    if (!binding || !raw) return new Response('Invalid sign-in', { status: 400 });
    const transaction = JSON.parse(decoder.decode(raw)) as Transaction;
    if (transaction.expires <= Date.now() || transaction.binding !== (await digest(binding)))
      return new Response('Invalid sign-in', { status: 400 });
    if (
      !(await storageConditionalBatch(
        options.storage,
        [{ key, expectedValue: raw }],
        [{ type: 'delete', key }],
      ))
    )
      return new Response('Invalid sign-in', { status: 400 });
    try {
      const configuration = await provider();
      const result = await client.authorizationCodeGrant(configuration, url, {
        expectedState: state,
        expectedNonce: transaction.nonce,
        pkceCodeVerifier: transaction.verifier,
      });
      const claims = result.claims();
      if (
        !claims ||
        typeof claims.sub !== 'string' ||
        !claims.sub ||
        typeof claims.iss !== 'string'
      )
        throw new Error('Invalid identity');
      const subjectId = await options.resolveAccount({ issuer: claims.iss, subject: claims.sub });
      const membership =
        subjectId &&
        (await options.resolveMembership({ subjectId, workspaceId: options.workspaceId }));
      if (!subjectId || !membership || membership.workspaceId !== options.workspaceId)
        throw new Error('No membership');
      const credential = token();
      const session: Session = {
        subjectId,
        workspaceId: options.workspaceId,
        expires: Date.now() + 86_400_000,
        consentBinding: token(),
      };
      const sessionStorageKey = await sessionKey(credential);
      if (
        !(await storageConditionalBatch(
          options.storage,
          [{ key: sessionStorageKey, expectedValue: null }],
          [{ type: 'put', key: sessionStorageKey, value: encode(session) }],
        ))
      )
        throw new Error('Session collision');
      return redirect(transaction.returnTo, [
        header(options.cookieName, credential, 86400, secure),
        header(transactionCookie(state), '', 0, secure),
      ]);
    } catch {
      return new Response('Invalid sign-in', {
        status: 400,
        headers: {
          'cache-control': 'private, no-store',
          'set-cookie': header(transactionCookie(state), '', 0, secure),
        },
      });
    }
  }

  async function fetch(request: Request) {
    request = new Request(request);
    const url = new URL(request.url);
    if (url.origin !== origin.origin) return new Response('Invalid origin', { status: 400 });
    const path = url.pathname.startsWith('/auth/')
      ? url.pathname.slice('/auth'.length)
      : url.pathname;
    if (path === '/sign-in' && request.method === 'GET')
      return startSignIn(request, url.searchParams.get('returnTo') ?? '/');
    if (path === '/callback' && request.method === 'GET') return callback(request);
    if (path === '/sign-out' && request.method === 'POST') {
      const credential = cookie(request, options.cookieName);
      if (!(await validWrite(request))) return new Response('Forbidden', { status: 403 });
      await options.storage.delete(await sessionKey(credential!));
      return redirect('/', [header(options.cookieName, '', 0, secure)]);
    }
    return new Response('Not Found', { status: 404 });
  }
  return {
    fetch,
    currentSession,
    startSignIn,
    validWrite,
    consentBinding: async (request: Request) => {
      const resolved = await resolveSession(request);
      return resolved?.session.consentBinding ?? null;
    },
    oauthIdentity: (
      store: { usesStorage(storage: Storage): boolean },
      principalForGrant: (identity: {
        subject: string;
        tenant: string;
      }) => Promise<{ delegableScopes: string[] } | null>,
    ) => {
      if (!options.storage.capabilities().conditionalBatchDeadline)
        throw new TypeError('Browser consent requires transaction deadline support');
      if (!store.usesStorage(options.storage))
        throw new TypeError('Browser and OAuth must use the same atomic storage namespace');
      return {
        assertStore: (candidate: { usesStorage(storage: Storage): boolean }) => {
          if (candidate !== store)
            throw new TypeError('Browser and OAuth must use the same atomic storage namespace');
        },
        session: async (request: Request) => {
          const resolved = await resolveSession(request);
          if (!resolved) return null;
          return {
            subject: resolved.session.subjectId,
            tenant: resolved.session.workspaceId,
            binding: resolved.session.consentBinding,
            sessionCondition: {
              key: resolved.key,
              expectedValue: resolved.raw,
              deadline: resolved.session.expires,
            },
          };
        },
        signIn: startSignIn,
        principalForGrant,
      };
    },
  };
}
