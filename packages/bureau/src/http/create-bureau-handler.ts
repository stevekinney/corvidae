/**
 * `createBureauHandler`: a Bureau, served as a fetch handler.
 *
 * Built on Weft's `createOperationHandler`, so it speaks the catalog's
 * transports (JSON-RPC over HTTP, and Server-Sent Events for subscriptions) and
 * generates its own OpenAPI, OpenRPC, and AsyncAPI documents from the operations
 * below and nothing else. It serves Bureau's two event feeds and the review
 * queue, and Bureau's managed assets: the upload operations, `bureau.assets.get`,
 * and `GET /assets/{assetId}/content` (a mount, `assets-mount.ts`), which is why
 * it needs a Bureau with an asset service. It does not start a task: `bureau.tasks.start` reaches
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
  getPrincipalOperation,
  type OperationHandler,
  type OperationHandlerAuthenticate,
  type OperationHandlerMount,
  type Outbox,
  type AuthenticatedPrincipal,
  unauthenticatedLocalAuthContext,
} from '@lostgradient/weft';
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import {
  type AgentSkillDescriptor,
  readGenerationProfile,
  type RunEventsOperationHost,
} from '@lostgradient/operative';
import {
  type A2ASigningOptions,
  type OutboxPushNotificationSender,
  securitySchemesFromAuthConfig,
} from '@lostgradient/weft/a2a';

import {
  type BureauEventsOperationHost,
  defineBureauEventsSubscriptionOperation,
} from '../bureau-events-operation.ts';
import {
  type AgentDefinitions,
  type BureauAgentCatalog,
  mediaCapabilitiesOf,
} from '../agent-catalog.ts';
import { agentExamplesSchema } from '../agent-examples.ts';
import { readFileAgentBinding } from '../agent-file-catalog.ts';
import {
  COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS,
  createPrunedCommandLedger,
} from '../command-ledger.ts';
import { isReservedOwnerSubject } from '../owner-of-record.ts';
import { type AgUiOptions, createAgUiMount } from './ag-ui-mount.ts';
import { type BureauA2AMountOptions, createBureauA2AMount } from './a2a-mount.ts';
import { type BureauMcpOptions, createBureauMcpMount } from './mcp-mount.ts';
import {
  A2A_SEND_LEDGER_KEY_PREFIX,
  type A2ASendClaim,
  type A2ASendLedger,
  type A2ASendResult,
} from './a2a-request-handler.ts';
import { createA2APushCheckpoints } from './a2a-push-checkpoint.ts';
import { createA2APushProjector } from './a2a-push-projector.ts';
import { type A2ATaskRecords, createA2ATaskRecords } from './a2a-task-record.ts';
import { mediaInputModesOf, mediaOutputModesOf } from './a2a-agent-card.ts';
import { createTaskReader } from './a2a-task-reader.ts';
import type {
  Bureau,
  BureauAudit,
  BureauInternals,
  BureauReviews,
  BureauTasks,
  BureauContexts,
  BureauSchedules,
} from '../types.ts';
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
  type BureauDiagnosticsOperationHost,
  diagnosticsGetOperation,
} from './management/diagnostics-operations.ts';
import {
  agentsListOperation,
  type BureauDeploymentOperationHost,
  deploymentGetOperation,
  type DeploymentRecovery,
  describeOperations,
  type ListedAgent,
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
  type BureauDecisionsOperationHost,
  bureauDecisionsOperations,
} from './management/decisions-operations.ts';
import {
  type BureauSettingsOperationHost,
  bureauSettingsOperations,
} from './management/settings-operations.ts';
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
  type BureauTasksInspectOperationHost,
  tasksInspectOperation,
} from './management/tasks-inspect-operation.ts';
import {
  type BureauTasksOperationHost,
  tasksCancelOperation,
  tasksGetOperation,
  tasksListOperation,
} from './management/tasks-operations.ts';
import {
  type BureauTasksRespondOperationHost,
  respondToTask,
  tasksRespondOperation,
} from './management/tasks-respond-operation.ts';

/**
 * The part of a {@link Bureau} the handler reads. A structural type rather than
 * `Bureau`, because `Bureau<D>` is invariant in its agent definitions and a
 * Bureau built with named agents would not otherwise be accepted.
 */
export type BureauHandlerSource = Pick<
  Bureau,
  | 'id'
  | 'runtimeServices'
  | 'durableEngine'
  | 'ownerOf'
  | 'lifecycle'
  | 'recovery'
  | 'frames'
  | 'children'
  | 'models'
  | 'decisions'
  | 'settings'
  | 'workflows'
  | 'goals'
  | 'memory'
  | 'assets'
  | 'surfaces'
  | 'addEventListener'
  | 'removeEventListener'
> & { readonly tasks: Pick<BureauTasks, 'start'> } & {
  readonly tasks: Pick<
    BureauTasks,
    | 'cancel'
    | 'detail'
    | 'get'
    | 'snapshot'
    | 'workflow'
    | 'wait'
    | 'events'
    | 'subscribeEvents'
    | 'receipt'
    | 'inspect'
    | 'respond'
  >;
} & {
  readonly reviews: Pick<BureauReviews, 'list' | 'get' | 'resolve' | 'pendingOf'>;
  readonly audit: Pick<BureauAudit, 'query'>;
  readonly contexts: Pick<
    BureauContexts,
    | 'list'
    | 'get'
    | 'delete'
    | 'input'
    | 'inputsDeliveredBy'
    | 'steer'
    | 'steering'
    | 'fork'
    | 'subscribeEvents'
  >;
  readonly schedules: Pick<
    BureauSchedules,
    | 'create'
    | 'get'
    | 'list'
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'update'
    | 'agentName'
    | 'inputPreview'
  >;
} & {
  readonly internals: Pick<
    BureauInternals,
    | 'hasExplicitId'
    | 'taskRetention'
    | 'kv'
    | 'eventFeed'
    | 'runEventFeeds'
    | 'taskRegistry'
    | 'sessionStore'
    | 'hasDurableEngine'
    | 'auditTrail'
    | 'whenTaskRecorded'
    | 'diagnostics'
  >;
} & {
  readonly agents: {
    has(name: string): boolean;
    find(name: string): AgentDescription | undefined;
  } & Pick<
    BureauAgentCatalog<AgentDefinitions>,
    | 'list'
    | 'detail'
    | 'models'
    | 'tools'
    | 'revisions'
    | 'versions'
    | 'create'
    | 'update'
    | 'delete'
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
  BureauDiagnosticsOperationHost &
  BureauTasksOperationHost &
  BureauTasksInspectOperationHost &
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
  BureauAssetsOperationHost &
  BureauDecisionsOperationHost &
  BureauSettingsOperationHost;

export type BureauHandlerOptions = {
  /**
   * Names of the code-defined agents that opt into A2A. Every name must exist in the Bureau's
   * code-defined agents and match {@link A2A_AGENT_NAME_PATTERN}, because a name served over A2A
   * becomes a URL path segment. Omitted, no code-defined agent opts in.
   *
   * It governs code-defined agents only, and only the A2A mount: every ready agent, code-defined
   * or persisted, is listed and can be started over AG-UI. A persisted agent (an agent file,
   * COR-1524) opts in with `a2a: true` in its own frontmatter and is never named here.
   *
   * `bureau.agents.list`, `bureau.deployment.get`, and the A2A mount read the opt-in on every
   * request.
   */
  readonly a2aAgents?: readonly string[];
  /**
   * The handler's public URL, which mounts A2A 1.0.1 (`a2a-mount.ts`): every agent that opts in is
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
   * Signs every opted-in agent's Agent Card and serves its public key at
   * `<path>/.well-known/jwks.json` (the kit's option shape). Needs `publicUrl`.
   */
  readonly signing?: A2ASigningOptions;
  /**
   * Delivers A2A push notifications (COR-1543): Weft's outbox push sender
   * (`createOutboxPushNotificationSender`) and the outbox it enqueues to, whose adapter is
   * `createHttpDeliveryAdapter`. Needs `publicUrl`. An opted-in agent's card declares
   * `capabilities.pushNotifications` only when this is set and the Bureau also keeps a durable
   * event history, because a push notification is a projection of that history; otherwise every
   * push operation answers `PushNotificationNotSupportedError`.
   *
   * The sender's push store holds the configurations and the Bureau stores each configuration's
   * checkpoint beside the task's A2A record. The host drives delivery itself, with
   * `startPushDelivery` on the same outbox, and stops it when it shuts down.
   */
  readonly pushNotifications?: {
    readonly sender: OutboxPushNotificationSender;
    readonly outbox: Outbox;
    /**
     * How often, in milliseconds, the projector sweeps every push checkpoint for a task that no
     * longer exists and removes its configurations, checkpoints, and settled deliveries. A sweep
     * also runs at start. A positive integer of at most 2147483647; defaults to one hour. The timer does not keep the
     * process alive and ends with the Bureau.
     */
    readonly sweepIntervalMs?: number;
  };
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
   * Any ready agent can be started. The mount needs
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

/** An A2A agent name is a URL path segment, so it needs no encoding. */
export const A2A_AGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

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
  'a2aAgents',
  'publicUrl',
  'discoveryUrl',
  'signing',
  'pushNotifications',
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

function assertA2AAgents(
  bureau: BureauHandlerSource,
  a2aAgents: readonly string[] | undefined,
): void {
  if (a2aAgents === undefined) return;
  if (!Array.isArray(a2aAgents)) fail('a2aAgents must be an array of agent names');
  for (const entry of a2aAgents as readonly unknown[]) {
    const shown = JSON.stringify(entry);
    if (typeof entry !== 'string' || !A2A_AGENT_NAME_PATTERN.test(entry)) {
      fail(`a2aAgents name ${shown} must match ${A2A_AGENT_NAME_PATTERN.source}`);
    }
    if (!bureau.agents.has(entry)) {
      fail(`a2aAgents names ${shown}, which is not in the Bureau's agent catalog`);
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
  if (!bureau.internals.hasDurableEngine) {
    fail(
      'agUi needs a Bureau with a durable engine: its human-wait parks and run-creation receipts ' +
        'both depend on one. Configure storage and `durable` on createBureau',
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
    if (options.pushNotifications !== undefined) {
      fail('pushNotifications needs publicUrl, which mounts A2A');
    }
    return;
  }
  assertA2AUrl('publicUrl', options.publicUrl);
  const sweepIntervalMs = options.pushNotifications?.sweepIntervalMs;
  if (sweepIntervalMs !== undefined) {
    if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs <= 0) {
      fail('pushNotifications.sweepIntervalMs must be a positive integer');
    }
    if (sweepIntervalMs > 2_147_483_647) {
      fail('pushNotifications.sweepIntervalMs must be at most 2147483647');
    }
  }
  if (options.discoveryUrl !== undefined) assertA2AUrl('discoveryUrl', options.discoveryUrl);
  if (!bureau.internals.hasDurableEngine) {
    fail(
      'publicUrl needs a Bureau with a durable engine: every A2A send creates its task through a ' +
        'run-creation receipt, which only a durable engine keeps. Configure storage and ' +
        '`durable` on createBureau',
    );
  }
  // An exact retry of a send resolves through its binding to the task it created, so the task
  // has to outlive the binding: a binding left pointing at a removed task would answer a retry
  // with not-found, or start the work again.
  const retention = bureau.internals.taskRetention;
  if (
    retention !== 'forever' &&
    retention.olderThan < COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS
  ) {
    fail(
      `serving A2A needs the Bureau's retention.tasks window to be at least the ` +
        `${COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS} ms a send's idempotency binding is kept ` +
        `(got ${retention.olderThan} ms)`,
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
  if (bureau.internals.kv !== undefined && !bureau.internals.hasExplicitId) {
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
  diagnosticsGetOperation,
  agentsListOperation,
  agentsModelsOperation,
  tasksListOperation,
  tasksGetOperation,
  tasksInspectOperation,
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
  ...bureauDecisionsOperations,
  ...bureauSettingsOperations,
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
  if (bureau.recovery === undefined) return { status: 'not-applicable', failedRunCount: 0 };
  const pending = Symbol('pending');
  const report = await Promise.race([bureau.recovery(), Promise.resolve(pending)]);
  if (report === pending) return { status: 'pending', failedRunCount: 0 };
  return { status: report.outcome, failedRunCount: report.perRunFailures.length };
}

/** The `tools` field of a {@link ListedAgent}, which is absent when the agent does not say. */
function toolsOf(names: readonly string[] | undefined): { readonly tools?: readonly string[] } {
  return names === undefined ? {} : { tools: names };
}

/** The `examples` field of a {@link ListedAgent}, which is absent when the agent has none. */
function examplesOf(prompts: readonly string[] | undefined): {
  readonly examples?: readonly string[];
} {
  return prompts === undefined || prompts.length === 0 ? {} : { examples: prompts };
}

/**
 * The example prompts a code-defined agent states (`StandaloneAgent.examples`), or `undefined` for
 * an agent that is not a `createAgent` result or states anything else. A runnable agent may be any
 * object with a `run`, so the property is checked rather than trusted.
 */
function readCodeExamples(agent: object): readonly string[] | undefined {
  // The same bounds `createAgent` enforces: a runnable that states more, or longer, says nothing,
  // so one odd agent cannot make the whole list fail its output schema.
  const prompts = agentExamplesSchema.safeParse(
    (agent as { readonly examples?: unknown }).examples,
  );
  return prompts.success ? prompts.data : undefined;
}

/**
 * The tool names a code-defined agent states (`StandaloneAgent.toolNames`), or `undefined` for an
 * agent that is not a `createAgent` result, or states anything else. A runnable agent may be any
 * object with a `run`, so the property is checked rather than trusted.
 */
function readCodeToolNames(agent: object): readonly string[] | undefined {
  const names = (agent as { readonly toolNames?: unknown }).toolNames;
  return Array.isArray(names) && names.every((name) => typeof name === 'string')
    ? names
    : undefined;
}

/**
 * The agents this deployment lists: every code-defined agent, and every persisted agent (COR-1526)
 * whose file is ready. An agent file that is invalid is not an agent, so it is not listed. `a2a`
 * says whether the agent opts into A2A: the `a2aAgents` allowlist for a code-defined agent, the
 * file's own `a2a` frontmatter for a persisted one.
 */
function listedAgentsOf(
  bureau: BureauHandlerSource,
  a2aAgents: readonly string[],
): readonly ListedAgent[] {
  const code = bureau.agents.list().flatMap((listing): ListedAgent[] => {
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
        a2a: a2aAgents.includes(listing.id),
        media: mediaCapabilitiesOf(readGenerationProfile(agent as never).descriptors),
        ...toolsOf(readCodeToolNames(agent)),
        ...examplesOf(readCodeExamples(agent)),
      },
    ];
  });
  const persisted = bureau.agents.list().flatMap((listing): ListedAgent[] => {
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
        a2a: listing.a2a,
        media: mediaCapabilitiesOf(readGenerationProfile(agent as never).descriptors),
        ...toolsOf(readFileAgentBinding(agent)?.definition.tools),
        ...examplesOf(readFileAgentBinding(agent)?.definition.examples),
      },
    ];
  });
  return [...code, ...persisted];
}

/**
 * Whether an adapter may start `name`: the Bureau has a ready agent by that name, code-defined or
 * persisted. Read when asked, so an agent created or deleted takes effect on the next request.
 */
function createStartable(bureau: BureauHandlerSource): {
  readonly includes: (agentName: string) => boolean;
} {
  return { includes: (agentName) => bureau.agents.find(agentName) !== undefined };
}

/**
 * Whether the A2A mount serves `name`: it is in the `a2aAgents` allowlist, or it is a persisted
 * agent whose file says `a2a: true`. Read when asked, so a file that turns the opt-in on or off
 * takes effect on the next request without a restart.
 */
function createA2AOptIn(
  bureau: BureauHandlerSource,
  a2aAgents: readonly string[],
): { readonly includes: (agentName: string) => boolean } {
  return {
    includes: (agentName) =>
      a2aAgents.includes(agentName) ||
      bureau.agents
        .list()
        .some((listing) => listing.source === 'file' && listing.id === agentName && listing.a2a),
  };
}

/**
 * The A2A mount: one interface per agent that opts in. A task's A2A record leaves with its task:
 * the mount deletes it when the run leaves the store (`run.removed`).
 */
function createA2AMount(
  bureau: BureauHandlerSource,
  options: BureauHandlerOptions,
  host: BureauHandlerHost,
): OperationHandlerMount {
  const a2aAgents = options.a2aAgents ?? [];
  const kv = bureau.internals.kv ?? textValueStore(new MemoryStorage());
  const records = createA2ATaskRecords(kv);
  const push = createPushSupport(bureau, options, kv, records);
  // A record whose removal failed holds message text for a task that is gone, so the removal is
  // retried with the next one, and a sweep at start-up deletes the records of tasks the store no
  // longer holds (a failure that no later removal retried, or a crash before the removal ran).
  const unremoved = new Set<string>();
  async function removeRecords(taskId: string): Promise<void> {
    unremoved.add(taskId);
    for (const id of Array.from(unremoved)) {
      try {
        await records.remove(id);
        unremoved.delete(id);
      } catch {
        // Kept in `unremoved` for the next attempt.
      }
    }
  }
  void records
    .sweep(async (taskId) => (await bureau.internals.taskRegistry.get(taskId)) !== undefined)
    .catch(() => undefined);
  bureau.addEventListener('run.removed', (event) => {
    void removeRecords(event.runId);
    // Each configuration is deleted through the sender, which stops its deliveries, and only
    // then its checkpoint.
    void push?.projector.cleanup(event.runId).catch(() => undefined);
  });
  // Message text does not outlive its context: deleting one empties its tasks' A2A history, as
  // it empties their own. Another instance clears a record when it next reads it.
  bureau.addEventListener('session.deleted', (event) => {
    // Only the incarnation that was deleted: a context created again under the same id keeps its
    // tasks' history.
    void records.clearContext(event.sessionId, event.incarnation).catch(() => undefined);
  });
  const ledger: A2ASendLedger = createPrunedCommandLedger<A2ASendClaim, A2ASendResult>(
    kv,
    A2A_SEND_LEDGER_KEY_PREFIX,
    'a2a-send-conflict',
    bureau.runtimeServices,
  );
  return createBureauA2AMount({
    // The bureau's own clock and timers, so a custom runtime governs command deadlines and the
    // handler's waits as it governs the bureau.
    runtime: bureau.runtimeServices,
    publicUrl: options.publicUrl as string,
    ...(options.discoveryUrl === undefined ? {} : { discoveryUrl: options.discoveryUrl }),
    ...(options.signing === undefined ? {} : { signing: options.signing }),
    bureau,
    optedIn: createA2AOptIn(bureau, a2aAgents),
    // Only a task A2A served has a record, so an agent that never opted in, whose tasks came
    // through Bureau's other surfaces, never gets a tombstone.
    hasTasks: async (agentName) => {
      for (let offset = 0; ; offset += TOMBSTONE_SCAN_PAGE) {
        const page = await bureau.internals.taskRegistry.enumerate({
          agentName,
          limit: TOMBSTONE_SCAN_PAGE,
          offset,
        });
        for (const task of page.tasks) if ((await records.read(task.id)) !== undefined) return true;
        if (page.tasks.length < TOMBSTONE_SCAN_PAGE) return false;
      }
    },
    describe: (agentName) => {
      const described = listedAgentsOf(bureau, a2aAgents).find((agent) => agent.name === agentName);
      const agent = bureau.agents.find(agentName) as
        { readonly skillDescriptors?: readonly AgentSkillDescriptor[] | undefined } | undefined;
      if (described === undefined || agent === undefined) return undefined;
      const descriptors = readGenerationProfile(
        agent as Parameters<typeof readGenerationProfile>[0],
      ).descriptors;
      return {
        outputModes: mediaOutputModesOf(descriptors),
        // A file part is a managed asset: without the asset service none can be read.
        inputModes:
          bureau.assets === undefined
            ? undefined
            : mediaInputModesOf(descriptors, bureau.assets.policy.allowedMediaTypes),
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
    push,
    respond: (principal, input) => respondToTask(host, principal, input),
    ...(options.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
  });
}

/** The push projector, its checkpoints, and delivery, when the handler was given an outbox. */
function createPushSupport(
  bureau: BureauHandlerSource,
  options: BureauHandlerOptions,
  kv: ConditionalTextValueStore,
  records: A2ATaskRecords,
): NonNullable<BureauA2AMountOptions['push']> | undefined {
  const delivery = options.pushNotifications;
  if (delivery === undefined) return undefined;
  const checkpoints = createA2APushCheckpoints(kv);
  const projector = createA2APushProjector({
    bureau,
    checkpoints,
    delivery,
    tenant: bureau.id,
    reader: createTaskReader({ bureau, records, publicUrl: options.publicUrl as string }),
    timers: bureau.runtimeServices.timers,
    sweepMs: delivery.sweepIntervalMs,
  });
  // A restart resumes every checkpoint from where it stopped. Recovery retries with backoff and
  // `ready` settles only once it succeeds (or the Bureau stops), so no install races an
  // unsettled pending checkpoint.
  const ready = projector.recoverUntilReady();
  return { delivery, checkpoints, projector, ready };
}

/** How many of an opted-out agent's tasks one tombstone check reads at a time. */
const TOMBSTONE_SCAN_PAGE = 50;

/**
 * The `host` every served operation reads. Exported so a test can serve the same
 * operations with one part replaced, such as an instrumented owner predicate.
 */
export function buildBureauHandlerHost(
  bureau: BureauHandlerSource,
  a2aAgents: readonly string[],
): BureauHandlerHost {
  const operations = describeOperations(BUREAU_HANDLER_OPERATIONS);
  return {
    // A Bureau owns exactly one feed, so the registry answers for its id alone.
    bureauFeeds: {
      get: (bureauId) => (bureauId === bureau.id ? bureau.internals.eventFeed : undefined),
    },
    runFeeds: bureau.internals.runEventFeeds,
    reviews: {
      list: () => bureau.reviews.list(),
      get: (id) => bureau.reviews.get(id),
      resolve: (input) => bureau.reviews.resolve(input),
      pendingOf: (taskId) => bureau.reviews.pendingOf(taskId),
      durableEngine: () => bureau.durableEngine(),
    },
    ownership: {
      runOwner: (runId) => bureau.ownerOf({ kind: 'run', id: runId }),
      mayAccess: mayAccessOwnedResource,
    },
    tasks: bureau.internals.taskRegistry,
    inspect: (id) => bureau.tasks.inspect(id),
    taskHistory: bureau.tasks,
    contexts: {
      list: (listOptions) => bureau.contexts.list(listOptions),
      get: (id) => bureau.contexts.get(id),
      delete: (id, deleteOptions) => bureau.contexts.delete(id, deleteOptions),
      steering: (id) => bureau.contexts.steering(id),
      input: (id, request) => bureau.contexts.input(id, request),
      steer: (id, request) => bureau.contexts.steer(id, request),
      fork: (id, request) => bureau.contexts.fork(id, request),
      get lifecycle() {
        return bureau.lifecycle;
      },
      internals: bureau.internals,
    },
    agentModels: {
      describe: (agentName) => bureau.agents.models(agentName),
    },
    agentDefinitions: {
      agents: bureau.agents,
      optsCodeAgentIntoA2A: (id) => a2aAgents.includes(id),
      models: () => bureau.models.catalog().descriptors,
      audit: async (entry) => {
        await bureau.internals.auditTrail?.record(entry);
      },
    },
    workflows: bureau.workflows,
    schedules: {
      create: bureau.schedules.create,
      get: bureau.schedules.get,
      list: bureau.schedules.list,
      pause: bureau.schedules.pause,
      resume: bureau.schedules.resume,
      cancel: bureau.schedules.cancel,
      update: bureau.schedules.update,
      owner: (scheduleId) => bureau.ownerOf({ kind: 'schedule', id: scheduleId }),
      agentName: bureau.schedules.agentName,
      inputPreview: bureau.schedules.inputPreview,
      hasAgent: (name) => bureau.agents.find(name) !== undefined,
    },
    goals: bureau.goals,
    memory: { governed: bureau.memory, tenantId: bureau.id },
    audit: {
      keepsTrail: () => bureau.internals.auditTrail !== undefined,
      query: bureau.audit.query,
    },
    assets: bureau.assets,
    decisions: bureau.decisions,
    settings: bureau.settings,
    respond: (request) => bureau.tasks.respond(request),
    diagnostics: { snapshot: () => bureau.internals.diagnostics() },
    deployment: {
      id: bureau.id,
      state: () => bureau.lifecycle,
      agents: () => listedAgentsOf(bureau, a2aAgents),
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
  assertA2AAgents(bureau, options.a2aAgents);
  assertAgUi(bureau, options);
  assertA2A(bureau, options);
  assertAssets(bureau);
  assertMaxRequestBodyBytes(options.maxRequestBodyBytes);
  assertBureauId(bureau);
  assertPersistence(bureau);

  const host = buildBureauHandlerHost(bureau, options.a2aAgents ?? []);

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
                ownerOf: (resource) => bureau.ownerOf(resource),
              },
              createStartable(bureau),
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
