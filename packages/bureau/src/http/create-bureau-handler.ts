/**
 * `createBureauHandler`: a Bureau, served as a fetch handler.
 *
 * Built on Weft's `createOperationHandler`, so it speaks the catalog's
 * transports (JSON-RPC over HTTP, and Server-Sent Events for subscriptions) and
 * generates its own OpenAPI, OpenRPC, and AsyncAPI documents from the operations
 * below and nothing else. It serves Bureau's two event feeds and the review
 * queue. It does not serve `bureau.run`, `getRun`, or `abortRun`: those reach
 * outside callers through protocol adapters mounted with `mounts`.
 *
 * Access follows the decision document's owner of record plus operator scopes
 * (`documentation/external-control-plane.md`, "The predicate per action"). An
 * authenticated principal reaches the resources it owns without any Bureau scope;
 * a kind's operator scope grants cross-owner access; a caller who may not see a
 * resource is answered as if it did not exist. The owner comes from the caller's
 * credential and never from a payload.
 *
 * @module create-bureau-handler
 */

import {
  type AuthConfig,
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
  createOperationHandler,
  createOperationHandlerAuthenticator,
  type OperationHandler,
  type OperationHandlerAuthenticate,
  type OperationHandlerMount,
  type AuthenticatedPrincipal,
  unauthenticatedLocalAuthContext,
} from '@lostgradient/weft';
import type { RunEventsOperationHost } from '@lostgradient/operative';

import {
  type BureauEventsOperationHost,
  defineBureauEventsSubscriptionOperation,
} from '../bureau-events-operation.ts';
import { isReservedOwnerSubject } from '../owner-of-record.ts';
import type { Bureau } from '../types.ts';
import { bureauReviewsOperations } from './bureau-reviews-operations.ts';
import { bureauRunEventsSubscriptionOperation } from './bureau-run-events-operation.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { type BureauOwnershipHost, mayAccessOwnedResource } from './owner-predicate.ts';
import type { BureauReviewsOperationHost } from './bureau-reviews-operations.ts';

/**
 * The part of a {@link Bureau} the handler reads. A structural type rather than
 * `Bureau`, because `Bureau<D>` is invariant in its agent definitions and a
 * Bureau built with named agents would not otherwise be accepted.
 */
export type BureauHandlerSource = Pick<
  Bureau,
  | 'id'
  | 'hasExplicitId'
  | 'kv'
  | 'eventFeed'
  | 'runEventFeeds'
  | 'listPendingReviews'
  | 'getReview'
  | 'resolveReview'
  | 'getOwner'
> & { readonly agents: { has(name: string): boolean } };

/** What every operation `createBureauHandler` serves reads from `host`. */
export type BureauHandlerHost = BureauEventsOperationHost &
  RunEventsOperationHost &
  BureauReviewsOperationHost &
  BureauOwnershipHost;

export type BureauHandlerOptions = {
  /**
   * Names of the agents this handler publishes. Every name must exist in the
   * Bureau's agent catalog and match {@link PUBLISHED_AGENT_NAME_PATTERN}, because a
   * published name becomes a URL path segment. Omitted publishes nothing.
   *
   * The names are validated and kept here; the adapters that consume them (A2A)
   * mount later, so no operation served today reads them.
   */
  readonly publish?: readonly string[];
  /**
   * How a caller proves who it is. API-key authentication only in v1, and only
   * through `resolveApiKeyPrincipal`: a `jwt` or `mtls` configuration throws at
   * construction, and so does a static `apiKeys` list, because every static key
   * authenticates as one shared caller and so would own every resource together.
   * `resolveApiKeyPrincipal` returns the principal a key stands for; its `subject`
   * is the owner (`api-key:<encodeURIComponent(subject)>`), so keys share an owner
   * only by returning the same subject. A subject in the reserved `system:` or
   * `anonymous:` namespace is refused with 401. Required unless
   * `unauthenticatedAccess` is `'allow'`, and refused with it.
   */
  readonly authentication?: AuthConfig;
  /**
   * `'reject'` (the default) requires `authentication` and answers 401 to a
   * request without credentials on every route. `'allow'` serves every request
   * as the one local caller: its `authenticate` hook returns method
   * `unauthenticated-local` with every built-in Weft scope and every scope in
   * {@link BUREAU_SCOPES}, and Bureau owns what it creates as `anonymous:local`,
   * so two uncredentialed callers see each other's resources. It cannot be
   * combined with `authentication`. `'allow'` has no loopback guard: binding the
   * port, and keeping an unauthenticated handler off a public interface, belongs
   * to the host that binds it (COR-1488).
   */
  readonly unauthenticatedAccess?: 'reject' | 'allow';
  /** Protocol adapters, each claiming a path prefix ahead of the catalog. */
  readonly mounts?: readonly OperationHandlerMount[];
};

/** A published agent name is a URL path segment, so it needs no encoding. */
export const PUBLISHED_AGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const OPTION_NAMES: ReadonlySet<string> = new Set([
  'publish',
  'authentication',
  'unauthenticatedAccess',
  'mounts',
]);

function fail(message: string): never {
  throw new Error(`createBureauHandler: ${message}`);
}

function assertKnownOptions(options: object): void {
  for (const name of Object.keys(options)) {
    if (!OPTION_NAMES.has(name)) {
      fail(`unknown option "${name}". Accepted options: ${[...OPTION_NAMES].join(', ')}`);
    }
  }
}

function resolveUnauthenticatedAccess(options: BureauHandlerOptions): 'reject' | 'allow' {
  const value = options.unauthenticatedAccess ?? 'reject';
  if (value !== 'reject' && value !== 'allow') {
    fail(`unauthenticatedAccess must be 'reject' or 'allow' (got ${JSON.stringify(value)})`);
  }
  return value;
}

function assertAuthentication(
  authentication: AuthConfig | undefined,
  unauthenticatedAccess: 'reject' | 'allow',
): void {
  if (authentication === undefined) {
    if (unauthenticatedAccess === 'reject') {
      fail(
        "authentication is required unless unauthenticatedAccess is 'allow'. Pass " +
          "`authentication`, or `unauthenticatedAccess: 'allow'` to serve every request as the anonymous caller",
      );
    }
    return;
  }
  if (unauthenticatedAccess === 'allow') {
    fail("authentication cannot be combined with unauthenticatedAccess: 'allow'");
  }
  if (authentication.jwt !== undefined) {
    fail('authentication.jwt is not supported yet; only API-key authentication is');
  }
  if (authentication.mtls !== undefined) {
    fail('authentication.mtls is not supported yet; only API-key authentication is');
  }
  if (authentication.apiKeys !== undefined) {
    fail(
      'authentication.apiKeys (static keys) is not supported: every static key authenticates as ' +
        'one shared caller, so all of them would own every resource together. Pass ' +
        '`resolveApiKeyPrincipal`, which returns the principal, and so the owner, each key stands for',
    );
  }
  if (authentication.resolveApiKeyPrincipal === undefined) {
    fail('API-key authentication requires `authentication.resolveApiKeyPrincipal`');
  }
}

function assertPublish(bureau: BureauHandlerSource, publish: readonly string[] | undefined): void {
  if (publish === undefined) return;
  if (!Array.isArray(publish)) fail('publish must be an array of agent names');
  for (const entry of publish as readonly unknown[]) {
    const shown = JSON.stringify(entry);
    if (typeof entry !== 'string' || !PUBLISHED_AGENT_NAME_PATTERN.test(entry)) {
      fail(`publish name ${shown} must match ${PUBLISHED_AGENT_NAME_PATTERN.source}`);
    }
    if (!bureau.agents.has(entry)) {
      fail(`publish names ${shown}, which is not in the Bureau's agent catalog`);
    }
  }
}

function assertBureauId(bureau: BureauHandlerSource): void {
  // `bureau.events` takes a non-empty `bureauId`, so an empty id would leave the
  // Bureau's own feed unreachable.
  if (bureau.id === '') {
    fail('the Bureau has an empty id, so its event feed could not be addressed by bureauId');
  }
}

function assertPersistence(bureau: BureauHandlerSource): void {
  if (bureau.kv !== undefined && !bureau.hasExplicitId) {
    fail(
      'this Bureau persists to storage but was created without an explicit `id`. A generated ' +
        'identifier changes on every restart and would orphan what the storage holds. Pass `id` to createBureau',
    );
  }
}

/**
 * The operations `createBureauHandler` serves, and nothing else. A test that must
 * cover every served operation reads this list, so an operation added here is
 * covered without editing the test.
 *
 * `bureau.events` is the fleet-wide feed, so it requires
 * `bureau.events:observe-all` rather than `events:read`, and `bureau.tasks:read`
 * alone does not grant it. `operative.runs.events` and the reviews operations are
 * owner-scoped (see their modules).
 */
export const BUREAU_HANDLER_OPERATIONS = [
  defineBureauEventsSubscriptionOperation('bureau.events:observe-all'),
  bureauRunEventsSubscriptionOperation,
  ...bureauReviewsOperations,
] as const;

/**
 * The principal every request is served as under `unauthenticatedAccess:
 * 'allow'`: Weft's `unauthenticated-local` principal, with its built-in scopes,
 * plus every Bureau scope. It names nobody, so Bureau owns what it creates as
 * `anonymous:local`. A new set per request, so nothing can widen the next one's.
 */
function createLocalPrincipal(): AuthenticatedPrincipal {
  const scopes = new Set<AuthorizationScope>([
    ...(unauthenticatedLocalAuthContext().principal?.scopes ?? AUTHORIZATION_SCOPES),
    ...BUREAU_SCOPES,
  ]);
  return Object.freeze({
    method: 'unauthenticated-local',
    scopes,
    claims: undefined,
    subject: undefined,
    hasScope: (scope: AuthorizationScope) => scopes.has(scope),
  });
}

const authenticateLocalCaller: OperationHandlerAuthenticate = async () => ({
  method: 'unauthenticated-local' as const,
  principal: createLocalPrincipal(),
});

/**
 * The API-key authenticator, with the credentials Bureau cannot own resources
 * for refused as the rest of Weft refuses any rejected key (401, and one
 * authentication audit event): a key with no subject, or whose subject falls in
 * the `system:` or `anonymous:` namespace Bureau reserves for itself.
 */
function createApiKeyAuthenticate(authentication: AuthConfig): OperationHandlerAuthenticate {
  const resolve = authentication.resolveApiKeyPrincipal;
  if (resolve === undefined) {
    throw new Error('createBureauHandler: authentication.resolveApiKeyPrincipal is required');
  }
  return createOperationHandlerAuthenticator(
    {
      ...authentication,
      resolveApiKeyPrincipal: async (key) => {
        const principal = await resolve(key);
        if (principal === null) return null;
        const { subject } = principal;
        return subject === undefined || subject === '' || isReservedOwnerSubject(subject)
          ? null
          : principal;
      },
    },
    { additionalScopes: BUREAU_SCOPES },
  );
}

/**
 * Create a fetch handler that serves `bureau`'s native operations: the
 * `bureau.events` and `operative.runs.events` feeds as Server-Sent Events with
 * live-only cursors, and `bureau.reviews.list`, `get`, and `resolve` as
 * JSON-RPC methods.
 *
 * Every misconfiguration throws here, synchronously, before a request is served.
 * The scopes its operations declare are registered with the authenticator, so a
 * credential's claims for any name in {@link BUREAU_SCOPES} are kept.
 *
 * @example
 * ```ts
 * const handler = createBureauHandler(bureau, {
 *   authentication: {
 *     resolveApiKeyPrincipal: async (key) =>
 *       key === process.env.BUREAU_API_KEY
 *         ? principalFromApiKey({ subject: 'operations', scopes: [] })
 *         : null,
 *   },
 * });
 * Bun.serve({ fetch: handler });
 * ```
 */
export function createBureauHandler(
  bureau: BureauHandlerSource,
  options: BureauHandlerOptions,
): OperationHandler {
  if (typeof options !== 'object' || options === null) fail('options must be an object');
  assertKnownOptions(options);
  const unauthenticatedAccess = resolveUnauthenticatedAccess(options);
  assertAuthentication(options.authentication, unauthenticatedAccess);
  assertPublish(bureau, options.publish);
  assertBureauId(bureau);
  assertPersistence(bureau);

  const host: BureauHandlerHost = {
    // A Bureau owns exactly one feed, so the registry answers for its id alone.
    bureauFeeds: { get: (bureauId) => (bureauId === bureau.id ? bureau.eventFeed : undefined) },
    runFeeds: bureau.runEventFeeds,
    reviews: bureau,
    ownership: {
      runOwner: (runId) => bureau.getOwner({ kind: 'run', id: runId }),
      mayAccess: mayAccessOwnedResource,
    },
  };

  return createOperationHandler({
    operations: BUREAU_HANDLER_OPERATIONS,
    host,
    authenticate:
      options.authentication === undefined
        ? authenticateLocalCaller
        : createApiKeyAuthenticate(options.authentication),
    mounts: options.mounts ?? [],
    // Whether a route authenticates is decided by `authentication` alone, so the
    // health route and the documents are no more public than anything else.
    publicPaths: [],
  });
}
