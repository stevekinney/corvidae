import type { PackageAuthorizationScope } from '@lostgradient/weft';

/**
 * Every authorization scope Bureau's catalog operations declare, in one list.
 *
 * `createBureauHandler` passes this list verbatim as `additionalScopes` to
 * Weft's operation-handler authenticator, so a credential's scope claims for
 * these names are retained and the operations' access policies can match them.
 * Later issues append their scopes here rather than keeping a second list.
 */
export const BUREAU_SCOPES = [
  'bureau.reviews:read',
  'bureau.reviews:resolve',
] as const satisfies readonly PackageAuthorizationScope[];

/** One of the scopes in {@link BUREAU_SCOPES}. */
export type BureauScope = (typeof BUREAU_SCOPES)[number];
