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
 * @module create-bureau-handler
 */

import {
  type AuthConfig,
  createOperationHandler,
  createOperationHandlerAuthenticator,
  type OperationHandler,
  type OperationHandlerMount,
} from '@lostgradient/weft';
import {
  runEventsSubscriptionOperation,
  type RunEventsOperationHost,
} from '@lostgradient/operative';

import {
  type BureauEventsOperationHost,
  bureauEventsSubscriptionOperation,
} from '../bureau-events-operation.ts';
import type { Bureau } from '../types.ts';
import {
  bureauReviewsOperations,
  type BureauReviewsOperationHost,
} from './bureau-reviews-operations.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';

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
> & { readonly agents: { has(name: string): boolean } };

/** What every operation `createBureauHandler` serves reads from `host`. */
export type BureauHandlerHost = BureauEventsOperationHost &
  RunEventsOperationHost &
  BureauReviewsOperationHost;

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
   * How a caller proves who it is. API-key authentication only in v1: a `jwt` or
   * `mtls` configuration throws at construction. Required unless
   * `unauthenticatedAccess` is `'allow'`, and refused with it.
   */
  readonly authentication?: AuthConfig;
  /**
   * `'reject'` (the default) requires `authentication` and answers 401 to a
   * request without credentials on every route. `'allow'` serves every request
   * as Weft's anonymous caller: `/v1/health` and the discovery documents answer,
   * and every scoped operation answers 401. It cannot be combined with
   * `authentication`. `'allow'` has no loopback guard: binding the port, and
   * keeping an unauthenticated handler off a public interface, belongs to the host
   * that binds it (COR-1488).
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
 * Create a fetch handler that serves `bureau`'s native operations: the
 * `bureau.events` and `operative.runs.events` feeds as Server-Sent Events with
 * live-only cursors, and `bureau.reviews.list`, `get`, and `resolve` as
 * JSON-RPC methods.
 *
 * Every misconfiguration throws here, synchronously, before a request is served.
 * The scopes its operations declare are registered with the authenticator, so a
 * credential's `bureau.reviews:read` and `bureau.reviews:resolve` claims are
 * kept.
 *
 * @example
 * ```ts
 * const handler = createBureauHandler(bureau, {
 *   authentication: { apiKeys: [process.env.BUREAU_API_KEY] },
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
  };

  return createOperationHandler({
    operations: [
      bureauEventsSubscriptionOperation,
      runEventsSubscriptionOperation,
      ...bureauReviewsOperations,
    ],
    host,
    ...(options.authentication === undefined
      ? {}
      : {
          authenticate: createOperationHandlerAuthenticator(options.authentication, {
            additionalScopes: BUREAU_SCOPES,
          }),
        }),
    mounts: options.mounts ?? [],
    // Whether a route authenticates is decided by `authentication` alone, so the
    // health route and the documents are no more public than anything else.
    publicPaths: [],
  });
}
