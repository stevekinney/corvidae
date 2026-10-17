/**
 * AuthenticatedPrincipal construction and the Principal discriminated union.
 *
 * Principals are the transport-neutral representation of "who made this call."
 * Every transport edge (REST, JSON-RPC HTTP, JSON-RPC WS upgrade, stdio
 * admission) validates credentials and produces exactly one of these shapes
 * before any operation pipeline runs.
 *
 * Credential *validation* (signature verification, expiry, revocation, format
 * checks) is the transport edge's responsibility — these factories assume the
 * inputs they receive describe a credential that has already been accepted.
 * This stable principal model ensures consistent authentication across all
 * transport layers.
 *
 * The discriminator string for API keys is `'api-key'` (kebab-case) to match
 * the existing `AuthMethod` literal in `authentication.ts`. Keep them aligned;
 * the bridge from `AuthResult` to `Principal` relies on byte-identical strings.
 */

import {
  AUTHORIZATION_SCOPES,
  extractScopesFromClaims,
  type AdditionalScopeSet,
  type AuthorizationScope,
} from './authorization-scope.ts';

/**
 * Raw JWT payload — intentionally loose; individual claim access is
 * type-guarded at read sites. **Non-authoritative for authorization
 * decisions.** Use `principal.subject` and `principal.scopes` (both
 * derived and normalized at construction time) instead. The `claims`
 * bag is preserved for debugging and pass-through.
 *
 * @example
 * ```ts
 * import { principalFromJwtClaims, type JwtClaims } from '@lostgradient/weft';
 *
 * const claims: JwtClaims = {
 *   sub: 'user-123',
 *   scope: 'workflows:read',
 * };
 * const principal = principalFromJwtClaims(claims);
 * console.log(principal.subject);
 * ```
 */
export type JwtClaims = Record<string, unknown>;

/**
 * An authenticated caller — JWT, API key, or mTLS. Carries the granted scope
 * set and a `hasScope` accessor; downstream code should narrow to this shape
 * via `isAuthenticated` before calling `hasScope`.
 *
 * The privileged `'stdio-local'` principal is for local stdio admission and
 * carries the full local-admin scope set. It is exported for embedders that
 * implement their own local admission gate; public transports should not mint
 * it for remote callers.
 *
 * The `'unauthenticated-local'` principal is what a `serve()` with no
 * authentication gives every request: nobody is identified, so it is the
 * single-user model, and it holds every built-in scope.
 *
 * @example
 * ```ts
 * import { principalFromApiKey, type AuthenticatedPrincipal } from '@lostgradient/weft';
 *
 * const principal: AuthenticatedPrincipal = principalFromApiKey({
 *   subject: 'local-tool',
 *   scopes: ['workflows:read'],
 * });
 * console.log(principal.method);
 * ```
 */
export type AuthenticatedPrincipal = {
  readonly method: 'jwt' | 'api-key' | 'mtls' | 'stdio-local' | 'unauthenticated-local';
  readonly scopes: ReadonlySet<AuthorizationScope>;
  readonly claims: JwtClaims | undefined;
  readonly subject: string | undefined;
  hasScope(scope: AuthorizationScope): boolean;
};

/**
 * An unauthenticated caller. Has no scopes and no `hasScope` method —
 * deliberate, so callers MUST narrow via `isAuthenticated` before any
 * scope-bearing access.
 *
 * @example
 * ```ts
 * import { anonymousPrincipal, type UnauthenticatedPrincipal } from '@lostgradient/weft';
 *
 * const principal: UnauthenticatedPrincipal = anonymousPrincipal();
 * console.log(principal.method);
 * ```
 */
export type UnauthenticatedPrincipal = {
  readonly method: 'unauthenticated';
};

/**
 * The full principal union used everywhere below the transport edge.
 *
 * @example
 * ```ts
 * import { anonymousPrincipal, type Principal } from '@lostgradient/weft';
 *
 * const principal: Principal = anonymousPrincipal();
 * console.log(principal.method);
 * ```
 */
export type Principal = AuthenticatedPrincipal | UnauthenticatedPrincipal;

/**
 * Build an `AuthenticatedPrincipal` from a JWT claims payload. Scopes come
 * from the `scope`, `scp`, and `permissions` claims; only built-in scopes and
 * those in `options.additionalScopes` (the package scopes the admitting
 * handler registered) are kept.
 *
 * @example
 * ```ts
 * import { principalFromJwtClaims } from '@lostgradient/weft';
 *
 * const principal = principalFromJwtClaims({
 *   sub: 'user-123',
 *   scope: 'workflows:read workflows:write',
 * });
 * console.log(principal.hasScope('workflows:read'));
 * ```
 */
export function principalFromJwtClaims(
  claims: JwtClaims,
  options: { readonly additionalScopes?: AdditionalScopeSet } = {},
): AuthenticatedPrincipal {
  const scopes = extractScopesFromClaims(claims, options.additionalScopes);
  const subject = typeof claims['sub'] === 'string' ? claims['sub'] : undefined;

  return {
    method: 'jwt',
    scopes,
    claims,
    subject,
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

/**
 * Build an `AuthenticatedPrincipal` from an API-key admission result.
 *
 * @example
 * ```ts
 * import { principalFromApiKey } from '@lostgradient/weft';
 *
 * const principal = principalFromApiKey({
 *   subject: 'automation',
 *   scopes: ['workflows:read'],
 * });
 * console.log(principal.subject);
 * ```
 */
export function principalFromApiKey(options: {
  subject: string;
  scopes: ReadonlyArray<AuthorizationScope>;
}): AuthenticatedPrincipal {
  const scopes = new Set<AuthorizationScope>(options.scopes);
  return {
    method: 'api-key',
    scopes,
    claims: undefined,
    subject: options.subject,
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

/**
 * Build an `AuthenticatedPrincipal` from an mTLS admission result.
 *
 * @example
 * ```ts
 * import { principalFromMutualTls } from '@lostgradient/weft';
 *
 * const principal = principalFromMutualTls({
 *   subject: 'client-cert-subject',
 *   scopes: ['system:read'],
 * });
 * console.log(principal.method);
 * ```
 */
export function principalFromMutualTls(options: {
  subject: string;
  scopes: ReadonlyArray<AuthorizationScope>;
}): AuthenticatedPrincipal {
  const scopes = new Set<AuthorizationScope>(options.scopes);
  return {
    method: 'mtls',
    scopes,
    claims: undefined,
    subject: options.subject,
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

/**
 * The single unauthenticated principal.
 *
 * @example
 * ```ts
 * import { anonymousPrincipal } from '@lostgradient/weft';
 *
 * const principal = anonymousPrincipal();
 * console.log(principal.method);
 * ```
 */
export function anonymousPrincipal(): UnauthenticatedPrincipal {
  return ANONYMOUS;
}

/**
 * Build the privileged `stdio-local` principal for the Phase 13
 * runtime stdio subcommand. Admission is gated at the CLI boundary
 * (`--startup-token <hex>` or `--allow-unauthenticated-local-admin`);
 * once admitted, the session has every built-in scope because it's
 * running as a local process that can already invoke the binary directly.
 * It holds no package scope: no handler's `additionalScopes` reach it, so
 * an operation that requires a package scope is `Forbidden` to it.
 *
 * @example
 * ```ts
 * import { principalFromStdioLocal } from '@lostgradient/weft';
 *
 * const principal = principalFromStdioLocal();
 * console.log(principal.hasScope('workflows:write'));
 * ```
 */
export function principalFromStdioLocal(): AuthenticatedPrincipal {
  const scopes = new Set<AuthorizationScope>(AUTHORIZATION_SCOPES);
  return {
    method: 'stdio-local',
    scopes,
    claims: undefined,
    subject: 'stdio-local',
    hasScope(scope) {
      return scopes.has(scope);
    },
  };
}

/**
 * Build the principal a `serve()` with no authentication gives every request.
 * The server identifies no caller, so every caller is the one local user and
 * holds every built-in scope (`AUTHORIZATION_SCOPES`), so every built-in
 * operation is reachable. It holds no package scope, as with `stdio-local`, so
 * an operation that needs a scope registered through `additionalScopes` still
 * needs a credential holding it. The same instance is returned every time, so
 * two requests compare as the same owner.
 *
 * @example
 * ```ts
 * import { principalFromUnauthenticatedLocal } from '@lostgradient/weft';
 *
 * const principal = principalFromUnauthenticatedLocal();
 * console.log(principal.method); // 'unauthenticated-local'
 * console.log(principal.hasScope('workflows:write')); // true
 * ```
 */
export function principalFromUnauthenticatedLocal(): AuthenticatedPrincipal {
  return UNAUTHENTICATED_LOCAL;
}

const ANONYMOUS: UnauthenticatedPrincipal = { method: 'unauthenticated' };

/**
 * Whether a principal was rebuilt from a credential the caller presented on
 * this request and names that caller distinctly (`jwt`, `api-key`, or `mtls`
 * with a subject of its own). Only such a principal separates one caller from
 * another by itself.
 *
 * `stdio-local` and `unauthenticated-local` are minted by the host and shared
 * by every caller it serves, an anonymous principal is a shared singleton, and
 * the shared fallback subjects ({@link SHARED_API_KEY_SUBJECT},
 * {@link SHARED_MUTUAL_TLS_SUBJECT}) are common to every static key or mTLS
 * caller, so none of them is credential-backed: a session bound to one needs a
 * per-session secret of its own to be isolated from other callers.
 */
export function isCredentialBacked(principal: Principal): boolean {
  if (!CREDENTIAL_BACKED_METHODS.has(principal.method)) return false;
  if (!isAuthenticated(principal)) return false;
  // Every static API key, and every mTLS caller admitted without a distinct
  // identity, maps to one shared fallback subject, so two such callers present
  // the same principal. Presenting a credential does not separate them.
  // A credential with no subject names nobody, so it separates nobody either.
  return principal.subject !== undefined && !SHARED_FALLBACK_SUBJECTS.has(principal.subject);
}

/**
 * An allowlist, so a principal method added later is treated as host-minted
 * (and its sessions keep needing a token) until someone decides otherwise.
 */
const CREDENTIAL_BACKED_METHODS: ReadonlySet<Principal['method']> = new Set([
  'jwt',
  'api-key',
  'mtls',
]);

/** The subject every statically configured API key is admitted under. */
export const SHARED_API_KEY_SUBJECT = 'api-key-caller';

/** The subject an mTLS caller is admitted under when it carries no identity of its own. */
export const SHARED_MUTUAL_TLS_SUBJECT = 'mtls-caller';

const SHARED_FALLBACK_SUBJECTS: ReadonlySet<string> = new Set([
  SHARED_API_KEY_SUBJECT,
  SHARED_MUTUAL_TLS_SUBJECT,
]);

/** Type guard separating authenticated from unauthenticated principals. */
export function isAuthenticated(principal: Principal): principal is AuthenticatedPrincipal {
  return principal.method !== 'unauthenticated';
}

/**
 * A scope set that refuses to change. `Object.freeze` cannot freeze a `Set`'s
 * contents, and the local principal is one shared instance whose `scopes` are
 * public, so a caller that widened or emptied the set would change what every
 * request is allowed to do.
 */
class ImmutableScopeSet extends Set<AuthorizationScope> {
  constructor(scopes: Iterable<AuthorizationScope>) {
    super();
    for (const scope of scopes) super.add(scope);
  }

  override add(): never {
    throw new TypeError('The scopes of the unauthenticated-local principal are immutable');
  }

  override delete(): never {
    throw new TypeError('The scopes of the unauthenticated-local principal are immutable');
  }

  override clear(): never {
    throw new TypeError('The scopes of the unauthenticated-local principal are immutable');
  }
}

const UNAUTHENTICATED_LOCAL: AuthenticatedPrincipal = (() => {
  const scopes = new ImmutableScopeSet(AUTHORIZATION_SCOPES);
  return Object.freeze({
    method: 'unauthenticated-local' as const,
    scopes,
    claims: undefined,
    subject: 'unauthenticated-local',
    hasScope(scope: AuthorizationScope) {
      return scopes.has(scope);
    },
  });
})();
