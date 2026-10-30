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
 * to that kind. A write scope does not imply its read scope. The two `bureau.assets` scopes are
 * the exception: they gate who may upload and read assets and grant nothing across owners,
 * because `AssetService` authorizes by an asset's owner and readers alone.
 * `bureau.events:observe-all` is the fleet-wide feed and is not implied by
 * `bureau.tasks:read`. The `bureau.deliveries:*` scopes are not registered.
 *
 * The two `bureau.deployments` scopes (COR-1813) gate the worker rollout operations: the worker
 * deployments belong to the deployment's owner of record, who reaches them without a scope, and the
 * scopes let another caller read (`get`) or move (`ramp`, `promote`, `rollback`) them. Neither
 * implies the other.
 *
 * The two `bureau.hooks` scopes (COR-1939) follow the rule: a hook belongs to its owner, who
 * reaches it without a scope, and `read` (`list`, `get`, `deliveries`) and `write` (`update`,
 * `delete`, `test`) grant any owner's hooks to another caller; neither implies the other. Creating
 * a hook, or changing its events, also needs `bureau.events:observe-all`, because a hook observes
 * the whole Bureau's events.
 *
 * The three memory scopes are the exception to the rule above (COR-1546, COR-1809).
 * `bureau.memory:read`, `bureau.memory:write` and `bureau.memory:govern` do not grant cross-owner
 * access: a caller reaches `bureau.memory.*` only with the scope its operation needs, and then only
 * its own memory. `govern` serves the legal hold alone, and no other memory scope implies it. Memory is the one kind a
 * principal may not reach by owning it, because what an agent remembers is not something a
 * credential may be handed by default.
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
  'bureau.agents:read',
  'bureau.agents:write',
  'bureau.workflows:read',
  'bureau.workflows:write',
  'bureau.memory:read',
  'bureau.memory:write',
  'bureau.assets:read',
  'bureau.assets:write',
  'bureau.events:observe-all',
  'bureau.decisions:write',
  'bureau.settings:read',
  'bureau.settings:write',
  'bureau.diagnostics:read',
  'bureau.memory:govern',
  'bureau.deployments:read',
  'bureau.deployments:write',
  'bureau.hooks:read',
  'bureau.hooks:write',
] as const satisfies readonly PackageAuthorizationScope[];

/** One of the scopes in {@link BUREAU_SCOPES}. */
export type BureauScope = (typeof BUREAU_SCOPES)[number];
