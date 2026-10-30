/**
 * Who an A2A caller is on the Interborough host (COR-1904).
 *
 * An operator who wants A2A reachable from elsewhere stores a key as the Bungalow secret
 * `a2a-api-key`: `secrets/a2a-api-key` under the home locally, `INTERBOROUGH_SECRET_A2A_API_KEY`
 * in remote mode. The host never makes one up and never writes, logs, or reports it. With a key,
 * the Bureau handler authenticates every request that carries an `X-API-Key` or `Authorization`
 * header against it, answering 401 to any other key, and A2A's JSON-RPC routes require it, on
 * loopback as anywhere; a request with neither header off A2A is still the local owner, which is
 * how the host's own pages reach the Bureau.
 *
 * The key stands for one principal, `api-key:a2a`, holding the asset scopes an A2A file part needs
 * and no operator scope. Without `bureau.agents:read` (which would also read every agent file's
 * text) it sees and can name only the agents that opt into A2A, and `bureau.deployment.get` refuses
 * it. Every caller that holds the key owns its tasks as that one principal.
 *
 * The public origin (`INTERBOROUGH_A2A_PUBLIC_ORIGIN`, `environment-configuration.ts`) lets a
 * reverse proxy's `Host` through the request guard for `/bureau/a2a/*` and, with a credential,
 * `/bureau/assets/*` only, and needs the key: a public origin without one would hand A2A to anyone
 * as the owner, so the host does not start.
 *
 * @module a2a-authentication
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { type Bungalow } from '@lostgradient/bungalow';
import { principalFromApiKey, type AuthConfig } from '@lostgradient/weft';

import { A2A_PUBLIC_ORIGIN_VARIABLE } from './environment-configuration.ts';

/** The Bungalow secret that holds the operator's A2A key. */
export const A2A_API_KEY_SECRET_KEY = 'a2a-api-key';

/** The subject the A2A key authenticates as; Bureau owns its tasks as `api-key:a2a`. */
export const A2A_SUBJECT = 'a2a';

/**
 * The scopes the A2A key holds: a file part's asset, read and admitted as the caller's own. No
 * operator scope, `bureau.agents:read` above all, so the narrowed view applies.
 */
export const A2A_SCOPES = ['bureau.assets:read', 'bureau.assets:write'] as const;

/** How the host exposes A2A: the handler's authentication, and the public origin, when set. */
export type A2aExposure = {
  /** The Bureau handler's `authentication`, present only when the operator stored a key. */
  readonly authentication?: AuthConfig;
  /** The origin a reverse proxy serves A2A at, present only beside a key. */
  readonly publicOrigin?: URL;
};

/**
 * Reads the operator's key, beside the public origin `resolveA2aPublicOrigin` read. A key that is blank once trimmed, and a public
 * origin without a key, stop the host: either would leave A2A open where the operator meant to close
 * it. Refusals are reported through `warn`, without the key or anything derived from it.
 */
export function resolveA2aExposure(
  bungalow: Bungalow,
  publicOrigin: URL | undefined,
  warn: (message: string) => void,
): A2aExposure {
  const stored = bungalow.readSecret(A2A_API_KEY_SECRET_KEY);
  const key = stored?.trim();
  if (key === '') {
    throw new Error(
      `${bungalow.secretLocation(A2A_API_KEY_SECRET_KEY)} is empty. Store the A2A key there, or remove it to keep A2A on loopback without one.`,
    );
  }
  if (key === undefined) {
    if (publicOrigin !== undefined) {
      throw new Error(
        `${A2A_PUBLIC_ORIGIN_VARIABLE} is set but ${bungalow.secretLocation(A2A_API_KEY_SECRET_KEY)} is not. A public origin needs the A2A key every remote caller presents.`,
      );
    }
    return {};
  }
  return {
    authentication: createA2aAuthentication(key, warn),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
  };
}

/** A fixed-length digest, so the comparison takes the same time whatever the presented key's length. */
function digestOf(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * The Bureau handler's authentication for one key: the presented key is compared in constant time,
 * and only that key resolves to the A2A principal. Refusals reach `warn` with the path and reason
 * Weft gives, never the presented credential or its fingerprint; admissions are not reported, as
 * every A2A call would otherwise write a line.
 */
export function createA2aAuthentication(key: string, warn: (message: string) => void): AuthConfig {
  const expected = digestOf(key);
  return {
    auditSink: (event) => {
      if (event.outcome !== 'failure') return;
      warn(
        `A2A authentication refused ${event.httpMethod} ${event.path}: ${event.reason ?? 'unauthenticated'}.`,
      );
    },
    resolveApiKeyPrincipal: async (presented) =>
      timingSafeEqual(digestOf(presented), expected)
        ? principalFromApiKey({ subject: A2A_SUBJECT, scopes: [...A2A_SCOPES] })
        : null,
  };
}
