import {
  createAuthenticator,
  validateAuthConfig,
  type AuthConfig,
  type AuthContext,
} from '../authentication.ts';
import {
  createAdditionalScopeSet,
  type PackageAuthorizationScope,
} from '../authorization-scope.ts';
import { authContextFromAuthResult, unauthorizedResponse } from '../runtime/request-gate.ts';

/**
 * Resolves the caller of one request for `createOperationHandler`. Resolve to
 * an {@link AuthContext} to admit the request, or to a `Response` (usually a
 * 401) to refuse it; a `Response` is returned to the caller as-is.
 */
export type OperationHandlerAuthenticate = (request: Request) => Promise<AuthContext | Response>;

export type OperationHandlerAuthenticatorOptions = {
  /**
   * Package scopes the handler's operations require beyond Weft's built-in
   * vocabulary, such as `bureau.tasks:read`. The authenticator retains them
   * from JWT `scope`, `scp`, and `permissions` claims, from
   * `defaultApiKeyScopes`, and from the principal `resolveApiKeyPrincipal`
   * returns; any other unknown scope is dropped. They belong to this
   * authenticator alone. Same rules and the same validation as
   * `serve({ additionalScopes })`.
   */
  readonly additionalScopes?: readonly PackageAuthorizationScope[];
};

/**
 * Build the `authenticate` hook for `createOperationHandler` from Weft's
 * API-key, JWT, and mTLS schemes.
 *
 * It admits and refuses exactly as `serve({ auth })` does: the same
 * `createAuthenticator` underneath, the same forwarded principal, and the same
 * 401 (body and `WWW-Authenticate` challenge) for a rejected credential. A bad
 * `config` or `additionalScopes` entry throws here, synchronously, before the
 * handler serves a request.
 *
 * mTLS is admitted only on positive evidence of a verified client certificate,
 * and a fetch handler has no transport to supply it, so a request there is
 * never admitted by `mtls`.
 *
 * @example
 * ```ts
 * import { createOperationHandler, createOperationHandlerAuthenticator } from '@lostgradient/weft';
 *
 * const handler = createOperationHandler({
 *   operations: [],
 *   host: {},
 *   authenticate: createOperationHandlerAuthenticator(
 *     { apiKeys: ['s3cr3t'] },
 *     { additionalScopes: ['bureau.tasks:read'] },
 *   ),
 * });
 * void handler;
 * ```
 */
export function createOperationHandlerAuthenticator(
  config: AuthConfig,
  options: OperationHandlerAuthenticatorOptions = {},
): OperationHandlerAuthenticate {
  validateAuthConfig(config);
  createAdditionalScopeSet(options.additionalScopes);
  const authenticatorPromise = createAuthenticator(
    config,
    options.additionalScopes === undefined ? {} : { additionalScopes: options.additionalScopes },
  );
  // A key that fails to import rejects here. The first request surfaces it;
  // this keeps the rejection from being reported as unhandled meanwhile.
  authenticatorPromise.catch(() => undefined);

  return async (request) => {
    const authenticate = await authenticatorPromise;
    const result = await authenticate(request);
    if (!result.authenticated) return unauthorizedResponse(result.error);
    return authContextFromAuthResult(result);
  };
}
