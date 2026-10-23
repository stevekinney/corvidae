/**
 * `createBureauHandler`: a Bureau, served as a fetch handler.
 *
 * Built on Weft's `createOperationHandler`, so it speaks the catalog's
 * transports (JSON-RPC over HTTP, and Server-Sent Events for subscriptions) and
 * generates its own OpenAPI, OpenRPC, and AsyncAPI documents from the operations
 * below and nothing else. It serves Bureau's two event feeds and the review
 * queue, and Bureau's managed assets: the upload operations, `bureau.assets.get`,
 * and `GET /assets/{assetId}/content` (a mount, `assets-mount.ts`), which is why
 * it needs a Bureau with an asset service. It does not serve `bureau.run`, `getRun`, or `abortRun`: those reach
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

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  type AuthConfig,
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
  type ConditionalTextValueStore,
  createOperationHandler,
  createOperationHandlerAuthenticator,
  getPrincipalOperation,
  MemoryStorage,
  type OperationHandler,
  type OperationHandlerAuthenticate,
  type OperationHandlerMount,
  type AuthenticatedPrincipal,
  textValueStore,
  unauthenticatedLocalAuthContext,
} from '@lostgradient/weft';
import {
  type AgentSkillDescriptor,
  readGenerationProfile,
  type RunEventsOperationHost,
} from '@lostgradient/operative';
import { type A2ASigningOptions, securitySchemesFromAuthConfig } from '@lostgradient/weft/a2a';

import {
  type BureauEventsOperationHost,
  defineBureauEventsSubscriptionOperation,
} from '../bureau-events-operation.ts';
import {
  type AgentDefinitions,
  type BureauAgentCatalog,
  mediaCapabilitiesOf,
} from '../agent-catalog.ts';
import { describeAgentModels } from '../agent-models.ts';
import { type CommandLedger, createCommandLedger } from '../command-ledger.ts';
import { isReservedOwnerSubject } from '../owner-of-record.ts';
import { type AgUiOptions, createAgUiMount } from './ag-ui-mount.ts';
import { createBureauA2AMount } from './a2a-mount.ts';
import { type BureauMcpOptions, createBureauMcpMount } from './mcp-mount.ts';
import {
  A2A_SEND_LEDGER_KEY_PREFIX,
  type A2ASendClaim,
  type A2ASendLedger,
  type A2ASendResult,
} from './a2a-request-handler.ts';
import { createA2ATaskRecords } from './a2a-task-record.ts';
import type { Bureau } from '../types.ts';
import { bureauReviewsOperations } from './bureau-reviews-operations.ts';
import { bureauRunEventsSubscriptionOperation } from './bureau-run-events-operation.ts';
import { createAssetsMount } from './assets-mount.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { type BureauOwnershipHost, mayAccessOwnedResource } from './owner-predicate.ts';
import type { BureauReviewsOperationHost } from './bureau-reviews-operations.ts';
import {
  type BureauAgentModelsOperationHost,
  agentsModelsOperation,
} from './management/agents-models-operation.ts';
import {
  type BureauContextsInputOperationHost,
  contextsInputOperation,
} from './management/contexts-input-operation.ts';
import {
  type BureauContextsForkOperationHost,
  contextsForkOperation,
} from './management/contexts-fork-operation.ts';
import {
  type BureauContextsSteerOperationHost,
  contextsSteerOperation,
} from './management/contexts-steer-operation.ts';
import {
  type BureauContextsOperationHost,
  contextsDeleteOperation,
  contextsGetOperation,
  contextsListOperation,
} from './management/contexts-operations.ts';
import {
  type BureauAgentDefinitionsOperationHost,
  bureauAgentDefinitionsOperations,
} from './management/agent-definitions-operations.ts';
import {
  agentsListOperation,
  type BureauDeploymentOperationHost,
  deploymentGetOperation,
  type DeploymentRecovery,
  describeOperations,
  type PublishedAgent,
} from './management/deployment-operations.ts';
import {
  type BureauWorkflowsOperationHost,
  bureauWorkflowsOperations,
} from './management/workflows-operations.ts';
import {
  auditQueryOperation,
  type BureauAuditOperationHost,
} from './management/audit-operations.ts';
import {
  type BureauAssetsOperationHost,
  bureauAssetsOperations,
} from './management/assets-operations.ts';
import {
  type BureauGoalsOperationHost,
  bureauGoalsOperations,
} from './management/goals-operations.ts';
import {
  type BureauMemoryOperationHost,
  bureauMemoryOperations,
} from './management/memory-operations.ts';
import {
  type BureauSchedulesOperationHost,
  bureauSchedulesOperations,
} from './management/schedules-operations.ts';
import {
  type BureauTaskEventsOperationHost,
  tasksEventsOperation,
} from './management/tasks-events-operation.ts';
import {
  type BureauTasksOperationHost,
  tasksCancelOperation,
  tasksGetOperation,
  tasksListOperation,
} from './management/tasks-operations.ts';
import {
  type BureauTasksRespondOperationHost,
  respondToTask,
  TASKS_RESPOND_LEDGER_KEY_PREFIX,
  tasksRespondOperation,
  type TasksRespondClaim,
  type TasksRespondLedger,
  type TasksRespondResult,
} from './management/tasks-respond-operation.ts';

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
  | 'pendingHumanWaitsOfRun'
  | 'durableEngine'
  | 'getOwner'
  | 'getScheduleAgentName'
  | 'tasks'
  | 'lifecycle'
  | 'eventHistory'
  | 'subscribeEventHistory'
  | 'getSession'
  | 'getSessionSteering'
  | 'submitSteeringCommand'
  | 'forkSession'
  | 'deleteSession'
  | 'listSessions'
  | 'sessionStore'
  | 'waitForRecovery'
  | 'createRun'
  | 'getRun'
  | 'abortRun'
  | 'listRuns'
  | 'subscribeLiveFrames'
  | 'subscribeRunSnapshot'
  | 'hasDurableEngine'
  | 'locateRunCreationReceipt'
  | 'children'
  | 'getDurableRun'
  | 'waitForDurableRun'
  | 'cancelDurableRun'
  | 'modelCatalog'
  | 'auditTrail'
  | 'workflows'
  | 'createSchedule'
  | 'getSchedule'
  | 'listSchedules'
  | 'pauseSchedule'
  | 'resumeSchedule'
  | 'cancelSchedule'
  | 'updateSchedule'
  | 'goals'
  | 'memory'
  | 'submitSessionInput'
  | 'whenRunRecorded'
  | 'sessionInputsDeliveredBy'
  | 'assets'
  | 'addEventListener'
> & {
  readonly agents: {
    has(name: string): boolean;
    find(name: string): AgentDescription | undefined;
  } & Pick<
    BureauAgentCatalog<AgentDefinitions>,
    | 'list'
    | 'detail'
    | 'tools'
    | 'revisions'
    | 'create'
    | 'update'
    | 'delete'
    | 'publish'
    | 'withdraw'
  >;
};

/** The part of a catalog agent the deployment operations describe. */
type AgentDescription = { readonly name: string; readonly description?: string | undefined };

/** What every operation `createBureauHandler` serves reads from `host`. */
export type BureauHandlerHost = BureauEventsOperationHost &
  RunEventsOperationHost &
  BureauReviewsOperationHost &
  BureauOwnershipHost &
  BureauDeploymentOperationHost &
  BureauTasksOperationHost &
  BureauTaskEventsOperationHost &
  BureauTasksRespondOperationHost &
  BureauContextsOperationHost &
  BureauContextsInputOperationHost &
  BureauContextsSteerOperationHost &
  BureauContextsForkOperationHost &
  BureauAgentModelsOperationHost &
  BureauAgentDefinitionsOperationHost &
  BureauWorkflowsOperationHost &
  BureauSchedulesOperationHost &
  BureauGoalsOperationHost &
  BureauMemoryOperationHost &
  BureauAuditOperationHost &
  BureauAssetsOperationHost;

export type BureauHandlerOptions = {
  /**
   * Names of the code-defined agents this handler publishes. Every name must exist in the
   * Bureau's code-defined agents and match {@link PUBLISHED_AGENT_NAME_PATTERN}, because a
   * published name becomes a URL path segment. Omitted publishes no code-defined agent.
   *
   * It governs code-defined agents only. A persisted agent (an agent file, COR-1524) is
   * published by its own `published` frontmatter, which `bureau.agents.definitions.publish`
   * and `withdraw` set, and is never named here.
   *
   * `bureau.agents.list`, `bureau.deployment.get`, the AG-UI mount, and the A2A mount read the
   * publication on every request.
   */
  readonly publish?: readonly string[];
  /**
   * The handler's public URL, which mounts A2A 1.0.1 (`a2a-mount.ts`): every published agent is
   * served at `<publicUrl>/a2a/<catalog-name>`, its public Agent Card at
   * `<publicUrl>/a2a/<catalog-name>/.well-known/agent-card.json`. It is the only source of the
   * card's interface URL: nothing is derived from a request. An absolute `http` or `https` URL
   * with no query or fragment. Omitted, A2A is not mounted.
   */
  readonly publicUrl?: string;
  /**
   * Base of the A2A discovery URLs (a signed card's `jku`), when discovery is served from another
   * listener. Defaults to `publicUrl`, and needs it.
   */
  readonly discoveryUrl?: string;
  /**
   * Signs every published agent's Agent Card and serves its public key at
   * `<path>/.well-known/jwks.json` (the kit's option shape). Needs `publicUrl`.
   */
  readonly signing?: A2ASigningOptions;
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
  /**
   * Mounts the AG-UI adapter (`ag-ui-mount.ts`): four routes under
   * `agUi.pathPrefix` (default `/ag-ui`) that start or resume a run, attach to
   * one, and cancel one, as AG-UI 1.0 Server-Sent Events. Omitted, nothing is
   * mounted and those paths are the handler's ordinary 404.
   *
   * Agents are selected from {@link BureauHandlerOptions.publish}. The mount needs
   * a Bureau with a durable engine, because its human-wait parks and its
   * run-creation receipts both do, and `createBureauHandler` throws at
   * construction without one. It is prepended to `mounts`, so Weft still refuses a
   * prefix that overlaps a catalog route or another mount.
   */
  readonly agUi?: AgUiOptions;
  /**
   * Mounts the MCP adapter (`mcp-mount.ts`, COR-839) at `mcp.pathPrefix` (default `/mcp`): Bureau's
   * `mcpExposable` operations as MCP tools, in both MCP protocol eras, each call run through the
   * catalog pipeline as the authenticated caller. Omitted, nothing is mounted.
   */
  readonly mcp?: BureauMcpOptions;
  /**
   * The most bytes a JSON-RPC request body may hold, a positive integer. Weft refuses a larger one
   * with 413 before any operation runs, so an oversized `bureau.assets.uploads.append` chunk writes
   * nothing. Omitted, Weft's own default (1 MB) applies.
   */
  readonly maxRequestBodyBytes?: number;
};

/** A published agent name is a URL path segment, so it needs no encoding. */
export const PUBLISHED_AGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Every `agUi` option, as a record keyed by `AgUiOptions`: a key added to the type
 * and not to this record is a compile error, so the allowlist cannot drift from
 * what the mount reads. The value says whether the option is a positive integer.
 */
const AG_UI_OPTIONS: Readonly<Record<keyof AgUiOptions, 'positive-integer' | 'other'>> = {
  pathPrefix: 'other',
  maxStreamDurationMs: 'positive-integer',
  liveBufferSize: 'positive-integer',
  keepAliveIntervalMs: 'positive-integer',
  leaseDurationMs: 'positive-integer',
  runtime: 'other',
};

const AG_UI_OPTION_NAMES: ReadonlySet<string> = new Set(Object.keys(AG_UI_OPTIONS));

const OPTION_NAMES: ReadonlySet<string> = new Set([
  'publish',
  'publicUrl',
  'discoveryUrl',
  'signing',
  'authentication',
  'unauthenticatedAccess',
  'mounts',
  'agUi',
  'mcp',
  'maxRequestBodyBytes',
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

function assertAgUi(bureau: BureauHandlerSource, options: BureauHandlerOptions): void {
  const agUi = options.agUi;
  if (agUi === undefined) return;
  if (typeof agUi !== 'object' || agUi === null) fail('agUi must be an object');
  for (const name of Object.keys(agUi)) {
    if (!AG_UI_OPTION_NAMES.has(name)) {
      fail(`unknown agUi option "${name}". Accepted: ${[...AG_UI_OPTION_NAMES].join(', ')}`);
    }
  }
  if (agUi.pathPrefix !== undefined && !/^\/[^\s?#]+$/.test(agUi.pathPrefix)) {
    fail('agUi.pathPrefix must be an absolute path with no query or fragment');
  }
  for (const [name, kind] of Object.entries(AG_UI_OPTIONS) as Array<
    [keyof AgUiOptions, 'positive-integer' | 'other']
  >) {
    if (kind !== 'positive-integer') continue;
    const value = agUi[name] as number | undefined;
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      fail(`agUi.${name} must be a positive integer`);
    }
  }
  if (!bureau.hasDurableEngine) {
    fail(
      'agUi needs a Bureau with a durable engine: its human-wait parks and run-creation receipts ' +
        'both depend on one. Configure storage and `durableExecution` on createBureau',
    );
  }
}

function assertA2AUrl(name: string, value: unknown): void {
  let parsed: URL | undefined;
  try {
    parsed = typeof value === 'string' ? new URL(value) : undefined;
  } catch {
    parsed = undefined;
  }
  if (
    parsed === undefined ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    fail(`${name} must be an absolute http or https URL with no query or fragment`);
  }
}

function assertA2A(bureau: BureauHandlerSource, options: BureauHandlerOptions): void {
  if (options.publicUrl === undefined) {
    if (options.discoveryUrl !== undefined) fail('discoveryUrl needs publicUrl, which mounts A2A');
    if (options.signing !== undefined) fail('signing needs publicUrl, which mounts A2A');
    return;
  }
  assertA2AUrl('publicUrl', options.publicUrl);
  if (options.discoveryUrl !== undefined) assertA2AUrl('discoveryUrl', options.discoveryUrl);
  if (!bureau.hasDurableEngine) {
    fail(
      'publicUrl needs a Bureau with a durable engine: every A2A send creates its task through a ' +
        'run-creation receipt, which only a durable engine keeps. Configure storage and ' +
        '`durableExecution` on createBureau',
    );
  }
}

function assertAssets(bureau: BureauHandlerSource): void {
  if (bureau.assets === undefined) {
    fail(
      'the handler serves the asset operations and the asset content route, so it needs a Bureau ' +
        'with an asset service. Pass `assets` (an `AssetStorage` and an optional policy) to createBureau',
    );
  }
}

function assertMaxRequestBodyBytes(value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(`maxRequestBodyBytes must be a positive integer (got ${String(value)})`);
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
  getPrincipalOperation,
  deploymentGetOperation,
  agentsListOperation,
  agentsModelsOperation,
  tasksListOperation,
  tasksGetOperation,
  tasksCancelOperation,
  tasksEventsOperation,
  tasksRespondOperation,
  contextsListOperation,
  contextsGetOperation,
  contextsDeleteOperation,
  contextsInputOperation,
  contextsSteerOperation,
  contextsForkOperation,
  ...bureauAgentDefinitionsOperations,
  ...bureauWorkflowsOperations,
  defineBureauEventsSubscriptionOperation('bureau.events:observe-all'),
  bureauRunEventsSubscriptionOperation,
  ...bureauReviewsOperations,
  ...bureauSchedulesOperations,
  ...bureauGoalsOperations,
  ...bureauMemoryOperations,
  auditQueryOperation,
  ...bureauAssetsOperations,
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

/** How long a recovery that has not finished is waited for before it reads as pending. */
async function recoveryOf(bureau: BureauHandlerSource): Promise<DeploymentRecovery> {
  if (bureau.waitForRecovery === undefined) return { status: 'not-applicable', failedRunCount: 0 };
  const pending = Symbol('pending');
  const report = await Promise.race([bureau.waitForRecovery(), Promise.resolve(pending)]);
  if (report === pending) return { status: 'pending', failedRunCount: 0 };
  return { status: report.outcome, failedRunCount: report.perRunFailures.length };
}

/**
 * The agents this deployment lists as published or withdrawn. A code-defined agent is published
 * by the `publish` allowlist alone and is not listed otherwise. A persisted agent (COR-1526)
 * is published by its own frontmatter: every agent file that is ready is listed, `published`
 * when its file says so and `withdrawn` when it does not. An agent file that is invalid is not
 * an agent, so it is not listed.
 */
function publishedAgentsOf(
  bureau: BureauHandlerSource,
  publish: readonly string[],
): readonly PublishedAgent[] {
  // Every code-defined agent is described, and the `publish` allowlist says which are offered: the
  // rest are `unpublished`, which only a caller who may read definitions is told of.
  const code = bureau.agents.list().flatMap((listing): PublishedAgent[] => {
    if (listing.source !== 'code') return [];
    const agent = bureau.agents.find(listing.id);
    if (agent === undefined) return [];
    return [
      {
        name: listing.id,
        kind: 'code',
        displayName: agent.name === '' || agent.name === '(agent)' ? listing.id : agent.name,
        description: agent.description ?? null,
        definitionRevision: readGenerationProfile(agent as never).revision,
        publishState: publish.includes(listing.id) ? 'published' : 'unpublished',
        media: mediaCapabilitiesOf(readGenerationProfile(agent as never).descriptors),
      },
    ];
  });
  const persisted = bureau.agents.list().flatMap((listing): PublishedAgent[] => {
    if (listing.source !== 'file' || listing.state !== 'ready') return [];
    const agent = bureau.agents.find(listing.id);
    if (agent === undefined) return [];
    return [
      {
        name: listing.id,
        kind: 'file',
        displayName: listing.name,
        description: listing.description,
        definitionRevision: readGenerationProfile(agent as never).revision,
        publishState: listing.published ? 'published' : 'withdrawn',
        media: mediaCapabilitiesOf(readGenerationProfile(agent as never).descriptors),
      },
    ];
  });
  return [...code, ...persisted];
}

/**
 * Whether an adapter may start `name`: it is in the `publish` allowlist, or it is a persisted
 * agent whose file publishes it. Read when asked, so publishing or withdrawing takes effect on
 * the next request without a restart.
 */
function createPublication(
  bureau: BureauHandlerSource,
  publish: readonly string[],
): { readonly includes: (agentName: string) => boolean } {
  return {
    includes: (agentName) =>
      publish.includes(agentName) ||
      bureau.agents
        .list()
        .some(
          (listing) => listing.source === 'file' && listing.id === agentName && listing.published,
        ),
  };
}

/**
 * The A2A mount: one interface per published agent. A task's A2A record leaves with its task:
 * the mount deletes it when the run leaves the store (`run.removed`).
 */
function createA2AMount(
  bureau: BureauHandlerSource,
  options: BureauHandlerOptions,
  host: BureauHandlerHost,
): OperationHandlerMount {
  const publish = options.publish ?? [];
  const kv = bureau.kv ?? textValueStore(new MemoryStorage());
  const records = createA2ATaskRecords(kv);
  bureau.addEventListener('run.removed', (event) => {
    void records.remove(event.runId).catch(() => undefined);
  });
  // Message text does not outlive its context: deleting one empties its tasks' A2A history, as
  // it empties their own. Another instance clears a record when it next reads it.
  bureau.addEventListener('session.deleted', (event) => {
    void records.clearContext(event.sessionId).catch(() => undefined);
  });
  const ledger: A2ASendLedger = createPrunedLedger<A2ASendClaim, A2ASendResult>(
    kv,
    A2A_SEND_LEDGER_KEY_PREFIX,
    'a2a-send-conflict',
  );
  return createBureauA2AMount({
    publicUrl: options.publicUrl as string,
    ...(options.discoveryUrl === undefined ? {} : { discoveryUrl: options.discoveryUrl }),
    ...(options.signing === undefined ? {} : { signing: options.signing }),
    bureau,
    publication: createPublication(bureau, publish),
    describe: (agentName) => {
      const described = publishedAgentsOf(bureau, publish).find(
        (agent) => agent.name === agentName,
      );
      const agent = bureau.agents.find(agentName) as
        { readonly skillDescriptors?: readonly AgentSkillDescriptor[] | undefined } | undefined;
      if (described === undefined || agent === undefined) return undefined;
      return {
        catalogName: agentName,
        displayName: described.displayName,
        description: described.description ?? undefined,
        definitionRevision: described.definitionRevision,
        skillDescriptors: agent.skillDescriptors,
      };
    },
    security:
      options.authentication === undefined
        ? undefined
        : securitySchemesFromAuthConfig(options.authentication),
    records,
    ledger,
    respond: (principal, input) => respondToTask(host, principal, input),
    ...(options.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
  });
}

/** How often the respond ledger drops its expired bindings, at most. */
const RESPOND_LEDGER_PRUNE_INTERVAL_MS = 3_600_000;

function createRespondLedger(bureau: BureauHandlerSource): TasksRespondLedger {
  return createPrunedLedger<TasksRespondClaim, TasksRespondResult>(
    // An ephemeral Bureau keeps the ledger in memory: a receipt then lives as long as the process does.
    bureau.kv ?? textValueStore(new MemoryStorage()),
    TASKS_RESPOND_LEDGER_KEY_PREFIX,
    'respond-conflict',
  );
}

/** A command ledger that drops its expired bindings at most once an hour, on a claim. */
function createPrunedLedger<Claim, Result>(
  kv: ConditionalTextValueStore,
  keyPrefix: string,
  conflictIdPrefix: string,
): CommandLedger<Claim, Result> {
  const runtime = createDefaultRuntimeServices();
  const ledger = createCommandLedger<Claim, Result>({
    kv,
    keyPrefix,
    clock: runtime.clock,
    nextConflictId: () => runtime.identifiers.next(conflictIdPrefix),
  });
  let prunedAt = runtime.clock.now();
  return {
    ...ledger,
    async claim(identity, digest, claim) {
      const now = runtime.clock.now();
      if (now - prunedAt >= RESPOND_LEDGER_PRUNE_INTERVAL_MS) {
        prunedAt = now;
        await ledger.prune().catch(() => undefined);
      }
      return ledger.claim(identity, digest, claim);
    },
  };
}

/**
 * The `host` every served operation reads. Exported so a test can serve the same
 * operations with one part replaced, such as an instrumented owner predicate.
 */
export function buildBureauHandlerHost(
  bureau: BureauHandlerSource,
  publish: readonly string[],
): BureauHandlerHost {
  const operations = describeOperations(BUREAU_HANDLER_OPERATIONS);
  return {
    // A Bureau owns exactly one feed, so the registry answers for its id alone.
    bureauFeeds: { get: (bureauId) => (bureauId === bureau.id ? bureau.eventFeed : undefined) },
    runFeeds: bureau.runEventFeeds,
    reviews: bureau,
    ownership: {
      runOwner: (runId) => bureau.getOwner({ kind: 'run', id: runId }),
      mayAccess: mayAccessOwnedResource,
    },
    tasks: bureau.tasks,
    taskHistory: bureau,
    contexts: bureau,
    agentModels: {
      describe: (agentName) => {
        const agent = bureau.agents.find(agentName);
        return agent === undefined
          ? undefined
          : describeAgentModels(agent, bureau.modelCatalog.catalog().descriptors);
      },
    },
    agentDefinitions: {
      agents: bureau.agents,
      publishesCodeAgent: (id) => publish.includes(id),
      models: () => bureau.modelCatalog.catalog().descriptors,
      audit: async (entry) => {
        await bureau.auditTrail?.record(entry);
      },
    },
    workflows: bureau.workflows,
    schedules: {
      createSchedule: bureau.createSchedule,
      getSchedule: bureau.getSchedule,
      listSchedules: bureau.listSchedules,
      pauseSchedule: bureau.pauseSchedule,
      resumeSchedule: bureau.resumeSchedule,
      cancelSchedule: bureau.cancelSchedule,
      updateSchedule: bureau.updateSchedule,
      owner: (scheduleId) => bureau.getOwner({ kind: 'schedule', id: scheduleId }),
      agentName: (scheduleId) => bureau.getScheduleAgentName(scheduleId),
      hasAgent: (name) => bureau.agents.has(name),
    },
    goals: bureau.goals,
    memory: { governed: bureau.memory, tenantId: bureau.id },
    audit: {
      get trail() {
        return bureau.auditTrail;
      },
      ownerOf: ({ runId, detail }) => bureau.getOwner({ kind: 'audit', runId, detail }),
    },
    assets: bureau.assets,
    respondLedger: createRespondLedger(bureau),
    respondInFlight: new Map(),
    deployment: {
      id: bureau.id,
      state: () => bureau.lifecycle,
      publishedAgents: () => publishedAgentsOf(bureau, publish),
      operations: () => operations,
      recovery: () => recoveryOf(bureau),
    },
  };
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
  assertAgUi(bureau, options);
  assertA2A(bureau, options);
  assertAssets(bureau);
  assertMaxRequestBodyBytes(options.maxRequestBodyBytes);
  assertBureauId(bureau);
  assertPersistence(bureau);

  const host = buildBureauHandlerHost(bureau, options.publish ?? []);

  return createOperationHandler({
    operations: BUREAU_HANDLER_OPERATIONS,
    host,
    authenticate:
      options.authentication === undefined
        ? authenticateLocalCaller
        : createApiKeyAuthenticate(options.authentication),
    ...(options.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
    mounts: [
      createAssetsMount(bureau.assets!),
      ...(options.agUi === undefined
        ? []
        : [
            createAgUiMount(
              bureau,
              {
                mayAccess: host.ownership.mayAccess,
                ownerOf: (resource) => bureau.getOwner(resource),
              },
              createPublication(bureau, options.publish ?? []),
              options.agUi,
            ),
          ]),
      ...(options.mcp === undefined
        ? []
        : [createBureauMcpMount(options.mcp, options.maxRequestBodyBytes)]),
      ...(options.publicUrl === undefined ? [] : [createA2AMount(bureau, options, host)]),
      ...(options.mounts ?? []),
    ],
    // Whether a route authenticates is decided by `authentication` alone, so the
    // health route and the documents are no more public than anything else.
    publicPaths: [],
  });
}
