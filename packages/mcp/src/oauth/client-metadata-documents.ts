import { z } from 'zod';
import {
  ClientMetadataDocumentFetchError,
  safeFetchPublicHttpsUrl,
  type DnsLookupAllFunction,
} from './safe-public-https-fetch.ts';
import { isExactContentType, isValidClientName, isValidRedirectUri } from './security-utilities.ts';

export {
  ClientMetadataDocumentFetchError,
  resetDnsLookupConcurrencyLimiterForTests,
  safeFetchPublicHttpsUrl,
} from './safe-public-https-fetch.ts';
export type {
  DnsLookupAllFunction,
  SafePublicHttpsFetchOptions,
} from './safe-public-https-fetch.ts';

const cimdMaxResponseBytes = 16 * 1024;
const cimdCacheTtlMs = 10 * 60 * 1_000;
const cimdCacheMaxEntries = 1_000;
const oauthMaxClientNameLength = 200;
const oauthMaxGrantTypeCount = 5;
const oauthMaxRedirectUriCount = 10;
const oauthMaxRedirectUriLength = 2_048;
const oauthMaxResponseTypeCount = 5;

export type ClientMetadataDocumentFetchDependencies = {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  lookupImpl?: DnsLookupAllFunction;
  now?: () => number;
  /**
   * Deadline for the DNS-resolution phase of `assertHostnameIsPubliclyRoutable`, in
   * milliseconds. Defaults to the safe fetch's five-second budget -- the same bound already
   * applied to the HTTP fetch that follows, so the whole preflight (resolve + connect) has one
   * consistent time budget rather than an unbounded resolve step ahead of a bounded fetch.
   * Overridable so tests can exercise the timeout path without a 5-second wait.
   */
  dnsTimeoutMs?: number;
};

/**
 * A `client_id` is a Client ID Metadata Document identifier only if it is
 * an HTTPS URL with a non-root path component (the MCP spec's own
 * requirement, matching the CIMD draft: `https://example.com/client.json`,
 * never bare `https://example.com`), no fragment, and no embedded userinfo.
 * A DCR `client_id` is always a `randomUUID()`, so this never collides with
 * one.
 */
export function isClientIdMetadataDocumentUrl(clientId: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.pathname === '' || parsed.pathname === '/') return false;

  return true;
}

const applicationTypes = ['web', 'native'] as const;

/**
 * `application_type` is DCR/OIDC vocabulary (SEP-837), not part of the
 * CIMD draft itself, but a document may still declare it and this server
 * honors the same web/native redirect-URI distinction either way: a
 * `web` document's `redirect_uris` must all be HTTPS (no loopback).
 */
function documentRedirectUrisMatchApplicationType(
  redirectUris: string[],
  applicationType: (typeof applicationTypes)[number] | undefined,
): boolean {
  if (applicationType !== 'web') return true;
  return redirectUris.every((uri) => new URL(uri).protocol === 'https:');
}

const clientMetadataDocumentSchema = z
  .object({
    client_id: z.string().url(),
    client_name: z
      .string()
      .min(1)
      .max(oauthMaxClientNameLength)
      .refine(isValidClientName, 'client_name must not contain control or confusable characters'),
    redirect_uris: z
      .array(z.string().url().max(oauthMaxRedirectUriLength))
      .min(1, 'At least one redirect URI is required')
      .max(oauthMaxRedirectUriCount)
      .refine(
        (uris) => uris.every(isValidRedirectUri),
        'Redirect URIs must use HTTPS (or http://localhost for development)',
      ),
    grant_types: z
      // Client metadata may advertise grants this server does not implement.
      // The token endpoint still accepts only authorization_code and refresh_token.
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[\x21-\x7e]+$/),
      )
      .max(oauthMaxGrantTypeCount)
      .default(['authorization_code', 'refresh_token']),
    response_types: z
      .array(z.enum(['code']))
      .max(oauthMaxResponseTypeCount)
      .default(['code']),
    // A CIMD identifier is a self-hosted, publicly readable document with
    // no mechanism for conveying or verifying a client secret. Only
    // `none` (PKCE-only, public client) is trustworthy here; anything
    // else this server cannot verify, so it is rejected rather than
    // silently defaulted or trusted.
    token_endpoint_auth_method: z.literal('none').default('none'),
    application_type: z.enum(applicationTypes).optional(),
  })
  .superRefine((data, ctx) => {
    if (!documentRedirectUrisMatchApplicationType(data.redirect_uris, data.application_type)) {
      ctx.addIssue({
        code: 'custom',
        message: 'application_type "web" requires every redirect_uri to use HTTPS.',
        path: ['redirect_uris'],
      });
    }
  });

export type ClientIdMetadataDocument = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  applicationType: 'web' | 'native' | null;
};

type CacheEntry = { document: ClientIdMetadataDocument; expiresAt: number };

/**
 * Bounded, in-memory, process-local cache — not Redis. A stale or evicted
 * entry only costs one extra fetch to the client's own endpoint on the
 * next authorization request; it is never a correctness hazard, so a
 * process-local cache (simpler, no new infrastructure dependency) is
 * sufficient. Insertion-order eviction (delete the oldest key once the cap
 * is hit) keeps this bounded without needing a full LRU.
 */
const documentCache = new Map<string, CacheEntry>();

function cacheDocument(document: ClientIdMetadataDocument, expiresAt: number): void {
  documentCache.delete(document.clientId);
  documentCache.set(document.clientId, { document, expiresAt });
  while (documentCache.size > cimdCacheMaxEntries) {
    const oldestKey = documentCache.keys().next().value;
    if (oldestKey === undefined) break;
    documentCache.delete(oldestKey);
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const declaredBytes = Number(declaredLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new ClientMetadataDocumentFetchError('response_too_large');
    }
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel(new Error('response too large')).catch(() => {});
      throw new ClientMetadataDocumentFetchError('response_too_large');
    }

    chunks.push(value);
  }

  const combined = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch {
    throw new ClientMetadataDocumentFetchError('invalid_encoding');
  }
}

/**
 * Fetches, validates, and caches the Client ID Metadata Document at
 * `clientId`. Returns `null` for every failure mode (not publicly
 * routable, unreachable, wrong content type, oversized, malformed JSON,
 * schema violation, a `client_id` field that does not exactly match this
 * URL) rather than throwing, so every caller has exactly one branch to
 * handle: "no usable document" — never a distinguishable error a caller
 * could use to probe internal network shape.
 */
export async function fetchClientIdMetadataDocument(
  clientId: string,
  dependencies: ClientMetadataDocumentFetchDependencies = {},
): Promise<ClientIdMetadataDocument | null> {
  if (!isClientIdMetadataDocumentUrl(clientId)) return null;

  const now = dependencies.now ?? Date.now;
  const cached = documentCache.get(clientId);
  if (cached && cached.expiresAt > now()) {
    return cached.document;
  }

  const url = new URL(clientId);

  let response: Response;
  try {
    response = await safeFetchPublicHttpsUrl(url, {
      fetchImpl: dependencies.fetchImpl,
      lookupImpl: dependencies.lookupImpl,
      dnsTimeoutMs: dependencies.dnsTimeoutMs,
      headers: { accept: 'application/json' },
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;
  if (!isExactContentType(response.headers.get('content-type'), 'application/json')) return null;

  let bodyText: string;
  try {
    bodyText = await readBoundedResponseText(response, cimdMaxResponseBytes);
  } catch {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText);
  } catch {
    return null;
  }

  const parsed = clientMetadataDocumentSchema.safeParse(parsedJson);
  if (!parsed.success) return null;

  // draft-ietf-oauth-client-id-metadata-document-00 §2: the authorization
  // server MUST validate the document's own `client_id` field matches the
  // URL it was fetched from exactly — otherwise a document could be
  // hosted at one URL and claim to speak for another.
  if (parsed.data.client_id !== clientId) return null;

  const document: ClientIdMetadataDocument = {
    clientId,
    clientName: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
    grantTypes: parsed.data.grant_types,
    responseTypes: parsed.data.response_types,
    applicationType: parsed.data.application_type ?? null,
  };

  cacheDocument(document, now() + cimdCacheTtlMs);
  return document;
}

/** Test-only: clears the module-local cache so tests don't leak state across files/cases. */
export function clearClientIdMetadataDocumentCacheForTests(): void {
  documentCache.clear();
}

/**
 * Test-only: resets the DNS lookup concurrency limiter's process-global
 * state. `outstandingDnsLookupCount` and `inFlightDnsLookupsByHostname` are
 * shared across every test file in the same process -- without this, a test
 * that saturates the limiter (or leaves a lookup in flight past its own
 * test's lifetime) would leak that state into the next test file's run.
 */
