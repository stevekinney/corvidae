import type { PackageAuthorizationScope } from '@lostgradient/weft';

/**
 * Every authorization scope Bureau's catalog operations declare, in one list.
 *
 * `createBureauHandler` passes this list verbatim as `additionalScopes` to
 * Weft's operation-handler authenticator, so a credential's scope claims for
 * these names are retained and the operations' access policies can match them.
 * Later issues append their scopes here rather than keeping a second list.
 *
 * These are operator scopes (`documentation/external-control-plane.md`,
 * "The predicate per action"): an authenticated principal reaches its own
 * resources without any of them, and a kind's scope grants cross-owner access
 * to that kind. A write scope does not imply its read scope.
 * `bureau.events:observe-all` is the fleet-wide feed and is not implied by
 * `bureau.tasks:read`. The `bureau.deliveries:*` scopes are not registered.
 */
export const BUREAU_SCOPES = [
  'bureau.tasks:read',
  'bureau.tasks:write',
  'bureau.reviews:read',
  'bureau.reviews:resolve',
  'bureau.audit:read',
  'bureau.schedules:read',
  'bureau.schedules:write',
  'bureau.goals:read',
  'bureau.goals:write',
  'bureau.contexts:read',
  'bureau.contexts:write',
  'bureau.workflows:read',
  'bureau.workflows:write',
  'bureau.events:observe-all',
] as const satisfies readonly PackageAuthorizationScope[];

/** One of the scopes in {@link BUREAU_SCOPES}. */
export type BureauScope = (typeof BUREAU_SCOPES)[number];
