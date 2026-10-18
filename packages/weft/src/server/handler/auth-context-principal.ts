import type { AuthContext } from '../authentication.ts';
import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  principalFromUnauthenticatedLocal,
  SHARED_API_KEY_SUBJECT,
  SHARED_MUTUAL_TLS_SUBJECT,
  type Principal,
} from '../principal.ts';

/**
 * Convert the REST transport's `authContext` into a `Principal`. The
 * authenticator (`serve()`) reports method + optional claims; this maps
 * that transport authentication result into the `Principal` used by the
 * operation pipeline.
 * Returns `anonymousPrincipal()` when no context is provided (public
 * request). A forwarded `principal` is used verbatim; without one, a `jwt`
 * context is rebuilt from its claims with built-in scopes only, because the
 * package scopes a handler registered are known only to its authenticator.
 * Forward the authenticator's `principal` to keep them.
 *
 * @example
 * ```ts
 * import { authContextToPrincipal } from '@lostgradient/weft';
 *
 * const principal = authContextToPrincipal({ method: 'api-key' });
 * console.log(principal.method); // 'api-key'
 * ```
 */
export function authContextToPrincipal(authContext: AuthContext | undefined): Principal {
  if (authContext === undefined) return anonymousPrincipal();
  if (authContext.principal !== undefined) return authContext.principal;
  switch (authContext.method) {
    case 'jwt': {
      if (authContext.claims === undefined) {
        throw new Error(
          'authContextToPrincipal: jwt authContext reached the pipeline without claims — ' +
            'authenticator contract violation',
        );
      }
      return principalFromJwtClaims(authContext.claims);
    }
    case 'api-key':
      return principalFromApiKey({ subject: SHARED_API_KEY_SUBJECT, scopes: [] });
    case 'mtls':
      return principalFromMutualTls({ subject: SHARED_MUTUAL_TLS_SUBJECT, scopes: [] });
    case 'unauthenticated-local':
      return principalFromUnauthenticatedLocal();
    case 'public':
      return anonymousPrincipal();
    default: {
      const exhaustiveCheck: never = authContext.method;
      throw new Error(`Unknown auth context method: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

const UNAUTHENTICATED_LOCAL_AUTH_CONTEXT: AuthContext = Object.freeze({
  method: 'unauthenticated-local',
  principal: principalFromUnauthenticatedLocal(),
});

/**
 * The context a host with exactly one caller attaches to every request: the
 * `unauthenticated-local` principal, which holds every built-in scope.
 *
 * `serve()` with no `auth` attaches it for you, and `setupServiceWorker()`
 * defaults to it. Use it as the recipe for any other single-user host, for
 * example `createOperationHandler({ authenticate: async () =>
 * unauthenticatedLocalAuthContext() })`. It identifies nobody and refuses no
 * built-in operation, so never attach it to requests from callers you do not
 * trust. It holds no package scope, so an operation that needs one registered
 * through `additionalScopes` still needs a credential that holds it.
 *
 * @example
 * ```ts
 * import { authContextToPrincipal, unauthenticatedLocalAuthContext } from '@lostgradient/weft';
 *
 * const principal = authContextToPrincipal(unauthenticatedLocalAuthContext());
 * console.log(principal.method); // 'unauthenticated-local'
 * ```
 */
export function unauthenticatedLocalAuthContext(): AuthContext {
  return UNAUTHENTICATED_LOCAL_AUTH_CONTEXT;
}
