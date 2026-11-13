import {
  authorizeHostRoutes,
  inventoryEngineRelay,
  inventoryHostRoutes,
  type HostRouteInventoryEntry,
} from './host-route-policy.ts';
/**
 * The Interborough host: one loopback origin that serves the browser application, Weft's engine
 * API for the Engine console, and a Bureau.
 *
 * The state lives in Bungalow's home (`~/.interborough`, or `INTERBOROUGH_HOME`): the Bureau runs on
 * Bun SQLite at Bungalow's database path with `BureauOptions.id` set to Bungalow's stable
 * `workspaceId`, so a restart finds its tasks, sessions, schedules, and goals where it left them.
 *
 * Setting `INTERBOROUGH_DATABASE_URL` and `INTERBOROUGH_BUCKET` selects remote mode instead
 * (README, "Running on Postgres and S3"): the Bureau runs on Postgres, the agent and workflow
 * definitions are objects in the bucket, the approval secret is `INTERBOROUGH_SECRET_APPROVAL_SECRET`,
 * and Bureau's durable ownership and maintenance settings are locked, so any number of hosts, such as the old and new release
 * of a rolling deploy, can run at once on the same state.
 * A fresh host defines no agent of its own. The `demo` plugin (`plugins/demo`, off by default)
 * contributes the scripted agents, tools, validators, goal and schedule a new install can try.
 * Agents are Markdown files in `agents/` under the home, which the Bureau loads and watches
 * (COR-1524): `researcher.md` is the agent `researcher`, its `model` is `<provider>/<model>` from
 * the catalog below, and its `tools` come from the loaded plugins and the saved tool sources.
 *
 * Memory is governed memory over the same database (`memory.ts`), embedded with a hashing
 * embedder that needs no model provider, so every agent, the demo ones included, remembers across
 * its owner's chats.
 *
 * The model catalog holds the models of the providers the loaded plugins contribute (the anthropic,
 * openai and gemini plugins) that have an API key in Bungalow's secrets (`providers.ts`), limited
 * by each plugin's `configuration.models` in `configuration.json`, with the catalog edits beside them
 * (`catalog-edits.ts`). The demo agents still answer from a script. A local host writes the
 * configuration and a provider's key, and reloads the catalog, without a restart
 * (`provider-manager.ts`, `provider-routes.ts`); a remote host refuses, reporting the reason
 * `deployment`.
 *
 * Every request without a credential acts as the one local caller, `anonymous:local`, holding
 * every Weft scope and every Bureau scope. There is no sign-in: the host binds `127.0.0.1` only,
 * and the Bureau handler (`unauthenticatedAccess: 'allow'`) serves every such request as that
 * caller. A host that listened on anything but loopback would hand every operation to whoever could
 * reach the port, which is why the hostname is not an option. The one credential the host knows is
 * the operator's A2A key (COR-1904, `a2a-authentication.ts`): once it is stored, A2A requires it,
 * and it is the only way a request from beyond loopback, through a reverse proxy serving the public
 * origin `INTERBOROUGH_A2A_PUBLIC_ORIGIN` names, reaches anything, and then only `/bureau/a2a/*`
 * and `/bureau/assets/*`.
 *
 * Weft's server would report its own shared `unauthenticated-local` caller for a request with no
 * credential, so it listens on a second, private loopback port that answers only a per-process
 * key mapped to `anonymous:local`, and the public listener relays to it (`engine-proxy.ts`). Both
 * halves of the application therefore name the same caller.
 *
 * The routes on the public origin:
 *
 * - `/api/runs`, `/api/runs/<run>`, `/api/chats/<chat>/messages`, `/api/agents`, `/api/schedules`,
 *   `/api/reviews/<review>/decision`, their description at `/api/openapi.json`, and `/host/session`:
 *   Interborough's own API over the Bureau, each operation checked against the session's scopes
 *   (`api-routes.ts`, `api-description.ts`).
 * - The rest of `/api/*` (`/api/v1/*` and so on), `/v1/*`, `/jsonrpc`, `/mcp`, and Weft's discovery
 *   documents: Weft's engine operations, relayed to its server.
 * - `/bureau/*`: Bureau's operations and its AG-UI mount (`/bureau/ag-ui`, which Chat talks to),
 *   served by `createBureauHandler` with the `/bureau` prefix removed. A request that needs a scope
 *   of Interborough's API the session does not hold is refused before it reaches Bureau
 *   (`scope-gate.ts`), as a write to `/host/plugins` or `/host/providers` is without
 *   `settings:write`. A WebSocket upgrade there
 *   (`bureau.events` at `/bureau/jsonrpc`) goes to the same handler's `upgrade`, and
 *   `host-websocket.ts` dispatches the upgraded socket to Bureau beside the engine relay's. They
 *   do not share Weft's root because both catalogs claim `/jsonrpc` and `/v1/…`.
 * - `/bureau/a2a/<agent>`: the A2A 1.0.1 interface of every agent that opts in, and its public Agent
 *   Card at `/bureau/a2a/<agent>/.well-known/agent-card.json` (COR-1819). A file agent opts in with
 *   `a2a: true` in its own file; a code agent opts in by being named in {@link HostOptions.a2aAgents}.
 *   The URL a card names is derived from the origin the listener ended up on, or is the public
 *   origin when one is set. With no A2A key, A2A is served under the same posture as the rest of
 *   the host: loopback only, every call as `anonymous:local`. With the key (the Bungalow secret
 *   `a2a-api-key`), every A2A JSON-RPC call must present it and acts as `api-key:a2a`, which sees
 *   only the agents that opt in; with the public origin as well, the request guard lets that
 *   origin's `Host` through for these paths and, with a credential, `/bureau/assets/*`, where the
 *   media their tasks generate is read (`request-guard.ts`).
 * - `/host/paths`: where the host keeps the files a person edits by hand, so the agent editor and
 *   the Workflows pages can show an agent's file path and a workflow's, and the agent editor can
 *   say where to configure a model provider: the configuration file, and the file that holds each
 *   provider's API key.
 * - `/host/providers`, `/host/providers/<name>`, `/host/providers/reload`, and `/host/catalog`:
 *   read and change the provider configuration (`provider-routes.ts`).
 * - `/host/plugins`, `/host/plugins/<name>`, and `/host/plugins/<name>/secrets/<key>`: the plugins the
 *   host loads, the owner's choices for them in `configuration.json` (`plugins`), and the secrets they
 *   declare (`plugin-routes.ts`). A remote host refuses a change with the reason `deployment`.
 *   `/host/panels` and `/host/plugins/<name>/apps/<app>[/tool-calls]` serve a plugin's
 *   panels (`panel-routes.ts`).
 * - `/host/tool-sources`, `/host/tool-sources/<id>`, `/host/tool-sources/<id>/affected-agents`,
 *   `/host/tool-sources/<id>/test`, `/host/tool-sources/<id>/authorize`, and `/host/oauth/callback/<id>`: the saved MCP and OpenAPI tool sources in `configuration.json`
 *   (`toolSources`), their encrypted credentials, and the OAuth sign-in (`tool-source-routes.ts`).
 *   The sources load before the Bureau is built, so an agent file lists their tools as
 *   `<id>__<tool>` after the host starts again. A remote host refuses a change with the reason
 *   `deployment`.
 * - `POST /host/restart`: asks the host to restart. It is registered only for a host started with
 *   `onRestartRequested` (the entries, which run under the supervisor), and answers `202` before
 *   the callback runs. `GET /host/restart` says whether it is registered, and the terminal command
 *   the supervisor recorded when it started this host (`launch-command.ts`), or `null`.
 * - `/assets/*` and the client routes: the built application, with `index.html` for every route
 *   the client router owns.
 *
 * @module host
 */

import type { Tool } from 'armorer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, resolve as resolvePath, sep } from 'node:path';
import {
  combineHostAuthentication,
  createHostAuthority,
  type HostWorkspaceAuthentication,
} from './host-authority.ts';
import { localWorkspaceMembership } from './workspace-principal.ts';

import {
  openBungalow,
  type Bungalow,
  type BungalowEnvironment,
  type SecretProviderFactory,
} from '@lostgradient/bungalow';
import {
  ANONYMOUS_LOCAL_OWNER,
  BUREAU_PLUGIN_ENTRY,
  createBureau,
  createBureauHandler,
  createDurableAssetStorage,
  resolveProviderGenerate,
  startIdleTurn,
  type AgentDefinitions,
  type AgentWithBureauTools,
  type Bureau,
  type BureauOptions,
  type BureauPluginEntry,
  type SettingsOptions,
} from '@lostgradient/bureau';
import {
  type GenerateFunction,
  type PeerCallJournal,
  type RuntimeServices,
  type Validator,
} from '@lostgradient/operative';
import { DEMO_AGENT_NAMES } from '@lostgradient/plugin-demo';
import { type Storage } from '@lostgradient/storage';
import {
  handleRequest,
  serve,
  type AlertingOptions,
  type RegistryAgnosticEngine,
  type ServeOptions,
  type WeftServer,
} from '@lostgradient/weft';
import { createEgressPolicy, type A2APeerUpdate, type EgressPolicy } from '@lostgradient/weft/a2a';

import { routes as clientRoutes } from '../app/routes.ts';
import { HOST_PATHS_ROUTE } from '../lib/host-paths.ts';
import { HOST_STORAGE_ROUTE, HOST_STORAGE_SUMMARY_ROUTE } from '../lib/host-storage.ts';
import { A2A_API_KEY_SECRET_KEY, A2A_SUBJECT, resolveA2aExposure } from './a2a-authentication.ts';
import { createA2APeerTools, readA2APeersConfiguration } from './a2a-peers.ts';
import { startHostPushDelivery, type HostPushDelivery } from './a2a-push.ts';
import { ANSWER_ENCRYPTION_KEY, answerEncryptionKeys } from './answer-encryption.ts';
import { API_DESCRIPTION_ROUTE, apiDescription } from './api-description.ts';
import { apiRoutes, localApiPrincipal, type ApiPrincipal } from './api-routes.ts';
import { createConfigurationQueue, type ConfigurationQueue } from './configuration-queue.ts';
import {
  createDevReload,
  DEV_RELOAD_ROUTE,
  injectDevReloadClient,
  type DevReload,
} from './dev-reload.ts';
import {
  createLocalAuthentication,
  isEngineRequestPath,
  relayRequest,
  webSocketRelayData,
} from './engine-proxy.ts';
import {
  DEFAULT_BUILD_DIRECTORY,
  processEnvironment,
  resolveA2aPublicOrigin,
  resolvePort,
} from './environment-configuration.ts';
import {
  HOST_DEPENDENCIES,
  loadFolderPlugins,
  PLUGIN_FOLDER_NAME,
  PLUGIN_RUNTIME_DIRECTORY_VARIABLE,
} from './folder-plugins.ts';
import { hookOptionsFor } from './hook-options.ts';
import { buildDiagnostics, providerDiagnostics, type HostDiagnostics } from './host-diagnostics.ts';
import { HOST_STATUS_ROUTE, type HostStatus } from './host-status.ts';
import { hostStorageReport, hostStorageSummary } from './host-storage.ts';
import {
  bureauUpgradeServer,
  hostWebSocketHandlers,
  isWebSocketUpgrade,
  type BureauHandler,
  type HostSocketData,
} from './host-websocket.ts';
import { resolveLaunchCommand } from './launch-command.ts';
import {
  claimWorkspaceBinding,
  createAgentSource,
  createHostStorage,
  createPluginAgentSource,
  createPluginSkillSource,
  createPluginWorkflowSource,
  createWorkflowSource,
  disposeHostStorage,
  hostPathsReport,
  redactDatabase,
  type HostDatabase,
  type LocalDirectoryOptions,
} from './locations.ts';
import { createHostMemory } from './memory.ts';
import { cleanUpRoutes, startNightlyCleanUp, type NightlyCleanUp } from './nightly-clean-up.ts';
import { PANEL_PREBUILT_DIRECTORY_VARIABLE, panelMounts } from './panel-mounts.ts';
import { panelRoutes } from './panel-routes.ts';
import { pluginAttention } from './plugin-attention.ts';
import { createPluginManager, pluginStartupLines, type PluginManager } from './plugin-manager.ts';
import { pluginRoutes } from './plugin-routes.ts';
import { defaultDecisionOptions, workspacePlugins } from './plugins.ts';
import { providerAttention } from './provider-attention.ts';
import { createProviderManager, type ProviderManager } from './provider-manager.ts';
import { providerRoutes } from './provider-routes.ts';
import { contributedProviders, type ModelSelection } from './providers.ts';
import { allowedHosts, createRequestGuard } from './request-guard.ts';
import { HOST_RESTART_ROUTE, type HostRestartStanding } from './restart.ts';
import { bureauScopeRefusal, refuseWritesWithoutScope } from './scope-gate.ts';
import { isShellNavigation } from './shell-request.ts';
import { createSkillManager, discoverFirstSkills, type SkillManager } from './skill-manager.ts';
import { skillRoutes } from './skill-routes.ts';
import { storageDeletionApplied, storageDeletionOf, storageResourceOf } from './storage-audit.ts';
import { agentToolUseOf } from './tool-source-agents.ts';
import { createToolSourceManager, type ToolSourceManager } from './tool-source-manager.ts';
import { toolSourceRoutes } from './tool-source-routes.ts';
import { TOOL_SOURCE_SECRET_PREFIX } from './tool-source-vault.ts';
import { createWorkspaceSecrets } from './workspace-secrets.ts';

/** The application name Bungalow keys the state directory, `INTERBOROUGH_HOME`, and lock on. */
export const APPLICATION_NAME = 'interborough';

/** The only address the host listens on. */
const LOOPBACK = '127.0.0.1';

/**
 * The Bungalow secret that signs the approvals a file agent's tools raise. The host keeps it for
 * itself: a plugin that declares it is refused (`reservedSecretKeys`), so a plugin signs with a
 * secret of its own.
 */
export const APPROVAL_SECRET_KEY = 'approval-secret';
/** Bungalow secret used to sign durable child-run authority grants. */
export const DELEGATION_SECRET_KEY = 'delegation-secret';

/**
 * The restart-applied settings a remote host holds to their code options (COR-1797): ownership,
 * maintenance, the durable engine, and the claim TTL and renew interval, whose code defaults keep
 * renew below TTL. Hosts that share a database must all run the same overlap-safe configuration,
 * so the Bureau reports each as locked for the reason `shared-storage`. The cap on workflow runs
 * executing at once is the deployment's to size (board SettingsShell, "Locked settings, remote
 * mode"), so it is locked for the reason `deployment`.
 */
const REMOTE_LOCKED_SETTINGS = {
  'durableOwnership.ownership': 'shared-storage',
  maintenance: 'shared-storage',
  durable: 'shared-storage',
  'engine.workflowClaimTtl': 'shared-storage',
  'engine.workflowClaimRenewInterval': 'shared-storage',
  'engine.maxConcurrentRuns': 'deployment',
} as const satisfies NonNullable<SettingsOptions['locked']>;

/**
 * The actor of what the host itself does, as the audit trail names it: `host.started` (COR-2009).
 * It sits in the `system:` namespace Bureau reserves for its own actors, so no credential can
 * claim it, and the audit log shows it as Interborough.
 */
export const HOST_ACTOR = 'system:host';

/**
 * How long the host keeps its audit trail by default: 90 days, in milliseconds (COR-1810). It is
 * the `retention.audit` window the Bureau starts with; a value stored on the Settings page replaces it.
 */
export const AUDIT_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;

/**
 * How long the host keeps a notification by default: 30 days, in milliseconds (COR-1941). It is the
 * `retention.notifications` window the Bureau starts with; a value stored on the Settings page
 * replaces it.
 */
export const NOTIFICATION_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long the host keeps a settled hook delivery record by default: 30 days, in milliseconds
 * (COR-1943). It is the `retention.hookDeliveries` window the Bureau starts with; a value stored on
 * the Settings page replaces it.
 */
export const HOOK_DELIVERY_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long the host keeps a finished run's workflow log lines after the run last wrote one: 7 days, in
 * milliseconds (COR-1811). It is the `retention.logs` window the Bureau starts with; a value stored
 * on the Settings page replaces it.
 */
export const WORKFLOW_LOG_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many workflow log lines a run keeps by default: 500, with the oldest evicted past it
 * (COR-1811). It is the `logs.maximumLinesPerRun` setting the Bureau starts with.
 */
export const WORKFLOW_LOG_MAXIMUM_LINES_PER_RUN = 500;

/** The directory of agent files under the Interborough home: `researcher.md` is the agent `researcher`. */
export const AGENT_DIRECTORY_NAME = 'agents';

/**
 * The directory of workflow files under the Interborough home: `nightly-digest.json` is the
 * workflow `nightly-digest` (COR-1527). Its steps may name any agent, the files in `agents/`
 * included, and it runs as the deployment's one owner.
 */
export const WORKFLOW_DIRECTORY_NAME = 'workflows';

/** The path prefix under which the Bureau handler is mounted. */
export const BUREAU_PATH_PREFIX = '/bureau';

/** Agents a host serves beside the ones its plugins contribute. */
export type ExtraAgents = {
  /** The agents, by name. */
  readonly agents: Readonly<Record<string, AgentDefinitions[string]>>;
  /**
   * Agents that hold Bureau's own tools (COR-2009), by name: each function builds its agent from
   * them (`bureau:workflows-create`, `bureau:discover-agents`, …), once the Bureau has made them.
   * They are served as {@link ExtraAgents.agents} are, and a name may be in only one of the two.
   */
  readonly withBureauTools?: Readonly<Record<string, AgentWithBureauTools>>;
  /**
   * Goal validators to register beside the ones the plugins contribute (COR-2009), passed through
   * as `BureauOptions.validators`: a goal names one by its exact name and version. The showcase's
   * built-in checks are registered this way.
   */
  readonly validators?: readonly Validator[];
};

/**
 * The agent a run belongs to, by the run's id, read from the host's Bureau: its name, or
 * `undefined` for a run the Bureau holds no task of (one it never started, one recovered before the
 * Bureau finished starting, or one whose record has expired).
 */
export type RunAgentLookup = (runId: string) => Promise<string | undefined>;

/**
 * What `startHost` reads to start a host. Every field is optional and defaults to the environment
 * and the checked-in build.
 */
export type HostOptions = {
  /** The environment to read `INTERBOROUGH_HOME` and `INTERBOROUGH_PORT` from. Defaults to the process's. */
  readonly environment?: BungalowEnvironment;
  /** The workspace identity to bind to the trusted backing store. */
  readonly workspaceId?: string;
  /** Inject verified credentials and a directory for this exact workspace; no listener expansion. */
  readonly workspaceAuthentication?: HostWorkspaceAuthentication;
  /** Trusted provider factory; browser payloads cannot select it. */
  readonly secretProvider?: SecretProviderFactory;
  /** Opt in to revision-checked remote configuration publication. */
  readonly writableConfiguration?: boolean;
  /**
   * How the host watches its local agent and workflow directories, the owner's and each plugin's
   * (COR-2291). Omitted or `true`, a directory is watched natively with the once-a-second rescan
   * behind it; `false` watches nothing; `'poll'` opens no native watcher and finds changes by the
   * rescan alone, for a machine where native watchers are unavailable or slow to close. A remote
   * home's sources poll their bucket and ignore it.
   */
  readonly directoryWatch?: LocalDirectoryOptions['watch'];
  /** The port to listen on; `0` asks for a free one. Defaults to `INTERBOROUGH_PORT`, then 7234. */
  readonly port?: number;
  /** The built application to serve. Defaults to `build/` at the package root. */
  readonly buildDirectory?: string;
  /**
   * Replaces the engine behind the Engine console, for a host whose console must start and inspect
   * workflows of its own (the end-to-end fixtures). The default is the Bureau's durable engine:
   * the one that owns the Bureau's runs, so a cancel from the console is fenced by their owner
   * and the live feed sees them. A replacement is a second engine over the same storage and the
   * host disposes it, so it must register its own workflows and run no background tasks of its
   * own on the Bureau's runs.
   */
  readonly createConsoleEngine?: (
    storage: Storage,
  ) => RegistryAgnosticEngine | Promise<RegistryAgnosticEngine>;
  /** The few Weft server settings a host may tune for the engine API it relays. */
  readonly engineServer?: Pick<
    ServeOptions,
    'cancellationGracePeriodMs' | 'workerReconnectGracePeriodMs'
  >;
  /** Agents to define beside the ones the plugins contribute, for tests that need an agent of their own. */
  readonly extraAgents?: ExtraAgents;
  /**
   * Tools to offer beside the ones tool sources bring: an agent file may name them and the catalog
   * lists them with their tier. The sample world's built-in tools (Lookup order, Issue refund and
   * Triage refunds) are offered this way, so a screen that says whether a tool is dangerous can
   * read it from the catalog.
   */
  readonly extraTools?: Readonly<Record<string, Tool>>;
  /** Egress policy for configured A2A peers; tests may allow an explicit loopback destination. */
  readonly a2aPeerEgressPolicy?: EgressPolicy;
  /** Fetch implementation for configured peers; used by end-to-end fixtures to observe requests. */
  readonly a2aPeerFetch?: typeof fetch;
  /** Observes nonterminal updates from a configured peer during durable recovery. */
  readonly a2aPeerRecoveryUpdate?: (update: A2APeerUpdate) => void;
  /**
   * The code-defined agents that opt into A2A (COR-1819): each is served at
   * `/bureau/a2a/<name>` with an Agent Card, as a file agent with `a2a: true` is. Every name must
   * be an agent the host defines (one a plugin contributes, or one of {@link HostOptions.extraAgents}) and a
   * valid A2A name, or the host does not start. Defaults to none, so a code agent is reachable
   * over A2A only when it is named here.
   */
  readonly a2aAgents?: readonly string[];
  /**
   * The package plugins to load, in order. Defaults to the workspace's own (`plugins.ts`). A host
   * started with others, such as a test's fixtures, loads exactly these. The array is copied
   * before the host opens anything. The folder plugins (COR-1881) load after them, whatever this is.
   */
  readonly plugins?: readonly BureauPluginEntry[];
  /**
   * Leaves the built-in `bureau` plugin out of Settings › Plugins. The Bureau still supplies its
   * tools; only the listing and the manager's entry for it go. The showcase host sets it, because the
   * sample world's plugin list (decisions.md, "Plugins: the sample world uses real plugins") holds
   * the plugins a person adds, never Interborough's own.
   */
  readonly omitBuiltInPlugin?: boolean;
  /**
   * Plugin folders to load as well, each marked `development-source` (`--plugin <path>` on the
   * development entry). They load like the folders in Bungalow's `plugins/`. Copied before the host
   * opens anything.
   */
  readonly developmentPlugins?: readonly string[];
  /** Receives the host's progress lines, such as one per plugin at startup. Defaults to `console.info`. */
  readonly log?: (message: string) => void;
  /**
   * Replaces Bureau's provider resolver, which {@link Host.generateFor} calls with the host's provider
   * definitions and the provider, model, and API key from Bungalow's secret. For tests that stand a fake client in for the SDK.
   */
  readonly resolveProviderGenerate?: typeof resolveProviderGenerate;
  /**
   * Builds the provider resolver from the host's {@link RunAgentLookup}, in place of
   * {@link HostOptions.resolveProviderGenerate}, for a resolver whose generate answers by whose run
   * it is. The showcase host passes it, so a built-in agent's step that a model override sent to the
   * provider still answers from the agent's script (`showcase.ts`).
   */
  readonly resolveProviderGenerateFor?: (
    agentOfRun: RunAgentLookup,
  ) => typeof resolveProviderGenerate;
  /** Receives the host's startup warnings. Defaults to `console.warn`. */
  readonly warn?: (message: string) => void;
  /**
   * The version this host runs, recorded with its `host.started` audit event so the audit log can
   * say "Server started, Interborough 2.4.1". Left out, the event carries no version and the log
   * names the host alone. The showcase host passes the sample world's (`showcase.ts`).
   */
  readonly version?: string;
  /**
   * Which runtime settings the Bureau holds to their code options (`settings.locked`, each with
   * the reason it is held), so the settings page shows them read-only and says why. A person's
   * host locks none; the end-to-end host locks one, so the page's locked state is exercised
   * against the real Bureau. A remote host adds the settings its shared storage requires.
   */
  readonly settings?: SettingsOptions;
  /**
   * Whether this is the development host (`dev.ts`). It serves the reload stream at
   * `/__dev/reload` and injects its client into `index.html`, and {@link Host.notifyRebuilt}
   * sends the reload. A host without it has no such route and serves the page as built. Defaults
   * to `false`.
   */
  readonly development?: boolean;
  /**
   * What to do when a person asks the host to restart (`POST /host/restart`). The entry that owns
   * the process stops the host and exits with `RESTART_EXIT_CODE`, which its supervisor answers by
   * starting the host again. The host calls it once, after it has answered the request, so a second
   * request while the first is in flight is answered and ignored. A host without it registers no
   * `POST` on the route, so a restart request is a 404, and `GET /host/restart` reports it
   * unavailable.
   */
  readonly onRestartRequested?: () => void | Promise<void>;
  /**
   * How long a probe of a tool source that is not saved yet (`POST /host/tool-sources/<id>/probe`)
   * may take to connect and list its tools before the host answers that the source did not
   * answer. Defaults to ten seconds.
   */
  readonly toolSourceProbeTimeoutMilliseconds?: number;
  /**
   * Alert rules the Bureau's engine evaluates against its own metrics, passed through as
   * `BureauOptions.alerts`, such as a `storage.size` rule. A firing rule is listed under Needs
   * attention. Omitted, the host configures none.
   */
  readonly alerts?: AlertingOptions;
  /**
   * How often, in milliseconds, the Bureau's engine reports its storage's size, passed through as
   * `BureauOptions.storageSizeReportIntervalMs` (COR-2009). Omitted, every minute; `0` turns the
   * report off, which the showcase does so its sample world's one 1.6 GB reading stands.
   */
  readonly storageSizeReportIntervalMilliseconds?: number;
  /**
   * The runtime services the host and its Bureau run on, passed through as `BureauOptions.runtime`
   * (COR-2009): its clock stamps every record the Bureau and its engine write, and the host's own
   * times (when its plugins loaded, its workers' ages, the nightly clean-up) read it too. The
   * showcase runs its sample world on an offset clock this way. Omitted, the process's own clock and
   * timers.
   */
  readonly runtime?: RuntimeServices;
  /**
   * The HTTP client hook deliveries send with, passed through as `BureauOptions.webhooks.fetch`
   * (COR-2009). The showcase answers every delivery itself, so its sample hooks keep delivery
   * records without ever posting to the real addresses they name. Omitted, the global `fetch`.
   */
  readonly hookFetch?: typeof fetch;
  /**
   * The nightly clean-up of expired records (COR-2009): the IANA time zone its 3:00 AM is in, which
   * defaults to the process's, and the clock it reads, which defaults to `Date.now`. The showcase
   * pins both to its sample world.
   */
  readonly nightlyCleanUp?: {
    /** The IANA time zone the nightly time is in, such as `America/Chicago`. */
    readonly timeZone?: string;
    /** The clock the clean-up reads, in milliseconds since the epoch. */
    readonly now?: () => number;
  };
  /**
   * Who a request to Interborough's own operations acts as, and the scopes of Interborough's API it
   * holds (`src/lib/api-scopes.ts`): the seven `/api` operations, the Bureau operations and AG-UI
   * runs the pages call, and the plugin and provider settings check them (`scope-gate.ts`).
   * Omitted, every request is the local person holding every scope, because Interborough is
   * single-user for now.
   */
  readonly apiPrincipal?: (request: Request) => ApiPrincipal;
};

/**
 * A running Interborough host: its origin, the Bureau and engine behind it, Weft's server, and the
 * means to stop it.
 */
export type Host = {
  /** The exact public listener routes, classified before registration. */
  readonly routeInventory: readonly HostRouteInventoryEntry[];
  /** The origin the host listens on, `http://127.0.0.1:<port>/`. */
  readonly url: URL;
  /** The Bureau, running on Bungalow's database. */
  readonly bureau: Bureau<AgentDefinitions>;
  /** The engine behind the Engine console: the Bureau's durable engine unless the host was given another. */
  readonly engine: RegistryAgnosticEngine;
  /** Weft's server, which owns the listening socket. */
  readonly server: WeftServer;
  /** The legacy deployment identifier persisted by Bungalow. */
  readonly deploymentId: string;
  /** The stable logical workspace identity, distinct from this process's runtime instance. */
  readonly workspaceId: string;
  /** A process-local identity that is intentionally not used as the durable memory tenant. */
  readonly runtimeInstanceId: string;
  /**
   * Where the Bureau and the engine share their database: the SQLite file, or the Postgres server
   * and database name with no credential. The connection URL carries the password, so the host
   * never hands it out.
   */
  readonly database: HostDatabase;
  /**
   * The generate for an agent assigned a model in the Bureau's catalog, resolved through Bureau's
   * provider path with the API key from Bungalow's secrets. Throws for a model the catalog does
   * not hold.
   */
  generateFor(selection: ModelSelection): GenerateFunction;
  /**
   * Change the model providers without a restart: connect one with its key, edit the catalog, or
   * read the configuration again. A remote host refuses a change with
   * {@link ProviderWriteLockedError}, reason `deployment`. See {@link ProviderManager}.
   */
  readonly providers: Pick<
    ProviderManager,
    'connect' | 'disconnect' | 'editCatalog' | 'reload' | 'snapshot'
  >;
  /**
   * The plugins the host loads: report each with the owner's choices and its secrets, store the
   * choices (`plugins.<name>` in `configuration.json`, applied on the next start), and store a
   * secret a plugin declared, which a plugin that needs it uses at once. A remote host refuses a
   * change with {@link PluginWriteLockedError}, reason `deployment`. See {@link PluginManager}.
   */
  readonly plugins: Pick<PluginManager, 'snapshot' | 'update' | 'saveSecret'>;
  /**
   * The nightly clean-up of expired records (COR-2009): its standing, which `GET /host/clean-up`
   * serves, and a clean-up by hand, which `POST /host/clean-up` runs. See {@link NightlyCleanUp}.
   */
  readonly cleanUp: Pick<NightlyCleanUp, 'standing' | 'cleanUpNow'>;
  /**
   * The queue every writer of `configuration.json` runs its read-change-write through, so two
   * writers never start from text the other is about to replace. The provider manager uses it;
   * another writer of the file takes it from here (`configuration-queue.ts`).
   */
  readonly configurationQueue: ConfigurationQueue;
  /**
   * The executable skills the host discovered from the `skills` sources in `configuration.json`,
   * and the one way they change: deciding whether a source is trusted, which is written to the
   * file, applied, and recorded in the audit trail as `skill.source.trusted`. A remote host
   * refuses a change with {@link SkillWriteLockedError}, reason `deployment`. See {@link SkillManager}.
   */
  readonly skills: Pick<SkillManager, 'setTrust' | 'refresh' | 'standing'>;
  /**
   * The saved MCP and OpenAPI tool sources: connect or remove one, start an OAuth sign-in, and
   * read where each stands. Credentials are encrypted at rest and never returned. A change is
   * listed after the host starts again; a remote host refuses one with
   * {@link ToolSourceWriteLockedError}, reason `deployment`. See {@link ToolSourceManager}.
   */
  readonly toolSources: Pick<
    ToolSourceManager,
    | 'probe'
    | 'test'
    | 'connect'
    | 'configureTools'
    | 'remove'
    | 'affectedAgents'
    | 'snapshot'
    | 'authorize'
    | 'completeAuthorization'
  >;
  /**
   * A point-in-time reading of the host's own state: the Bureau's diagnostics, the engine server's
   * lease, workers, and connections, the build it serves, and the providers it offers. It holds no
   * credential: a provider is its name and its models. The lock holder is left out, because it is
   * always this process while the host runs.
   */
  diagnostics(): HostDiagnostics;
  /**
   * Tell every open page of a development host that the build has been replaced, so each reloads.
   * Call it after a successful rebuild. It does nothing on a host started without `development`.
   */
  notifyRebuilt(): void;
  /** Stop listening, shut the Bureau and the engine down, close the database, and release the lock. */
  close(): Promise<void>;
};

/**
 * The installation's approval secret. Locally it is created on first use and kept in Bungalow's
 * `secrets/`. Remotely it is the variable Bungalow names (`INTERBOROUGH_SECRET_APPROVAL_SECRET`),
 * the same on every host, and a host without it does not start: a secret one host made up would
 * not verify an approval another host signed.
 */
async function approvalSecret(bungalow: Bungalow): Promise<string> {
  const existing = await bungalow.deploymentSecrets.read(APPROVAL_SECRET_KEY);
  if (existing !== undefined) return existing;
  if (bungalow.mode === 'remote') {
    throw new Error(
      `${bungalow.deploymentSecrets.location(APPROVAL_SECRET_KEY)} is not set. Remote mode needs it: it signs the approvals every host verifies.`,
    );
  }
  const created = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await bungalow.deploymentSecrets.write(APPROVAL_SECRET_KEY, created);
  return created;
}

async function delegationSecret(bungalow: Bungalow): Promise<string> {
  const existing = await bungalow.deploymentSecrets.read(DELEGATION_SECRET_KEY);
  if (existing !== undefined) return existing;
  if (bungalow.mode === 'remote') {
    throw new Error(
      `${bungalow.deploymentSecrets.location(DELEGATION_SECRET_KEY)} is not set. Remote mode needs it: it signs durable child-run authority grants every host verifies.`,
    );
  }
  const created = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await bungalow.deploymentSecrets.write(DELEGATION_SECRET_KEY, created);
  return created;
}

/** Where the `/bureau` prefix comes off a request before the Bureau handler sees it. */
function withoutBureauPrefix(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(BUREAU_PATH_PREFIX.length) || '/';
  return new Request(url, request);
}

function missingBuild(): Response {
  return new Response(
    'Interborough has not been built. Run `bun run --filter=@lostgradient/interborough build`.',
    { status: 503 },
  );
}

/** The files under `/assets/`, refusing any path that leaves the build directory. */
async function assetResponse(buildDirectory: string, pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response('Malformed asset path.', { status: 400 });
  }
  // The route is `/assets/*`, so only the build's `assets/` directory is reachable: `..` may not
  // climb out of it to `index.html` or anything else in the build.
  const assets = resolvePath(buildDirectory, 'assets');
  const path = resolvePath(buildDirectory, `.${decoded}`);
  if (!path.startsWith(`${assets}${sep}`)) return new Response('Not found', { status: 404 });
  const asset = Bun.file(path);
  if (!(await asset.exists())) return new Response('Not found', { status: 404 });
  return new Response(asset, {
    headers: { 'cache-control': 'public, max-age=31536000, immutable' },
  });
}

/**
 * The application's one page, `index.html`, which the client router takes over. A development host
 * injects the reload client into it as it serves it (`dev-reload.ts`); the file in the build never
 * holds it.
 */
function shellResponder(buildDirectory: string, development: boolean): () => Promise<Response> {
  return async () => {
    const page = Bun.file(join(buildDirectory, 'index.html'));
    if (!(await page.exists())) return missingBuild();
    return new Response(development ? injectDevReloadClient(await page.text()) : page, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  };
}

type PublicRoutes = Bun.Serve.Routes<HostSocketData, string>;

/**
 * The route table for the application: `index.html` for every client route, and the build's
 * assets. The routes are the client router's own patterns, so a route added there is served here.
 */
function applicationRoutes(
  buildDirectory: string,
  refuse: Guard,
  shell: () => Promise<Response>,
): PublicRoutes {
  const table: PublicRoutes = {
    '/assets/*': {
      GET: (request) =>
        refuse(request) ?? assetResponse(buildDirectory, new URL(request.url).pathname),
    },
  };
  for (const route of clientRoutes) {
    table[route.pattern] = { GET: (request) => refuse(request) ?? shell() };
  }
  return table;
}

/**
 * The handler of `POST /host/restart` for a host that restarts through `restart`: answer `202`,
 * then run `restart` once. The callback stops the host, which closes its connections, so it runs in
 * a later turn of the event loop rather than before the answer is written. A second request while
 * one is in flight changes nothing. A failure is reported and clears the request, so the person
 * can ask again; the entry's callback exits the process itself.
 */
function restartHandler(restart: () => void | Promise<void>): () => Response {
  let requested = false;
  return () => {
    if (!requested) {
      requested = true;
      setImmediate(() => {
        void Promise.resolve()
          .then(restart)
          .catch((error: unknown) => {
            requested = false;
            console.error('The restart failed.', error);
          });
      });
    }
    return Response.json({ restarting: true }, { status: 202 });
  };
}

/** A request guard: the refusal to send, or `undefined` to let the request through. */
type Guard = (request: Request) => Response | undefined;

/** Where the engine's private listener is, once it is up. */
type EngineUpstream = { readonly url: string; readonly key: string };

/** Start the host. The caller owns it and must `close()` it. */
export async function startHost(options: HostOptions = {}): Promise<Host> {
  const incarnationId = randomUUID();
  // The clock the host's own times are read from: its runtime's, so they agree with its Bureau's.
  const clock = options.runtime?.clock ?? { now: () => Date.now() };
  // The demo plugin's agents are named `demo:<name>`, and Bureau skips a plugin whose contribution
  // takes a name a host option already holds. That is a mistake in whoever named the extra agent,
  // so it stops the host before anything opens, rather than silently dropping the plugin.
  for (const name of DEMO_AGENT_NAMES) {
    const id = `demo:${name}`;
    const extra = { ...options.extraAgents?.agents, ...options.extraAgents?.withBureauTools };
    if (Object.hasOwn(extra, id)) {
      throw new Error(
        `The extra agent "${id}" has the name of an agent the demo plugin contributes, which would clash with it. Give it another name.`,
      );
    }
  }
  const environment = { ...(options.environment ?? processEnvironment()) };
  // The caller's lock list is read before the first await, so a later change to it cannot reach the Bureau.
  const callerLocks = { ...options.settings?.locked };
  // The A2A allowlist is read the same way: after the first await it would be the caller's live array.
  const a2aAgents = options.a2aAgents === undefined ? undefined : [...options.a2aAgents];
  // The plugin lists are read the same way, so the Bureau and the routes see the plugins this host was started with.
  const packagePlugins = [...(options.plugins ?? workspacePlugins())];
  const developmentPlugins = [...(options.developmentPlugins ?? [])];
  const log = options.log ?? ((message: string) => console.info(message));
  // The A2A public origin (COR-1904) is read from the caller's environment before it can change,
  // and a malformed one stops the host before anything opens.
  const a2aPublicOrigin = resolveA2aPublicOrigin(environment);
  let claimedRemoteStorage: Storage | undefined;
  let bungalow: Bungalow;
  try {
    bungalow = await openBungalow({
      name: APPLICATION_NAME,
      environment,
      ...(options.secretProvider === undefined ? {} : { secretProvider: options.secretProvider }),
      ...(options.writableConfiguration === undefined
        ? {}
        : { writableConfiguration: options.writableConfiguration }),
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      databaseWorkspaceClaim: async (databaseUrl, prefix, workspaceId) => {
        // Required deployment secrets must be present before opening its database. The
        // normal secret readers below still validate their values before starting engines.
        for (const variable of [
          'INTERBOROUGH_SECRET_APPROVAL_SECRET',
          'INTERBOROUGH_SECRET_ANSWER_ENCRYPTION_KEY',
          'INTERBOROUGH_SECRET_DELEGATION_SECRET',
        ]) {
          if (environment[variable] === undefined || environment[variable] === '') {
            throw new Error(`${variable} is not set. Remote mode needs it on every host.`);
          }
        }
        const storage =
          claimedRemoteStorage ??
          createHostStorage({ kind: 'postgres', url: databaseUrl }, clock.now);
        claimedRemoteStorage = storage;
        await claimWorkspaceBinding(storage, prefix, workspaceId);
      },
    });
  } catch (error) {
    if (claimedRemoteStorage !== undefined) await disposeHostStorage(claimedRemoteStorage);
    throw error;
  }
  const held: Held = {
    bungalow,
    ...(claimedRemoteStorage === undefined ? {} : { storage: claimedRemoteStorage }),
  };
  try {
    // No engine, plugin or listener may start before the workspace is bound and secrets validate.
    if (
      options.workspaceAuthentication !== undefined &&
      (options.workspaceAuthentication.authentication === undefined ||
        options.workspaceAuthentication.workspace?.workspaceId !== bungalow.workspaceId)
    )
      throw new Error(
        'Workspace authentication requires credentials and this workspace directory.',
      );
    const database = redactDatabase(bungalow.database);
    const workspaceSecrets = createWorkspaceSecrets(bungalow);
    await workspaceSecrets.reconcile();
    const approval = await approvalSecret(bungalow);
    const delegation = await delegationSecret(bungalow);
    // The A2A key and public origin (COR-1904), read as early, so a public origin without a key
    // stops the host before anything listens.
    const a2aExposure = await resolveA2aExposure(
      bungalow,
      a2aPublicOrigin,
      options.warn ?? ((message) => console.warn(message)),
    );
    // The key secret answers are sealed with (COR-1920), read or created the same way and as early.
    const answerKeys = await answerEncryptionKeys(bungalow);
    const storage = claimedRemoteStorage ?? createHostStorage(bungalow.database, clock.now);
    held.storage = storage;
    // The catalog holds the models of the providers `configuration.json` names that have a key in
    // the secrets, and nothing else. The Bureau is created with exactly these rows, so no boot step
    // plans against a provider that is not configured. The demo agents still answer from a
    // script.
    const configurationQueue = createConfigurationQueue();
    // The folder plugins load now, once: Bungalow's `plugins/` folder, then the development ones.
    // A folder that cannot load is reported and skipped, never a reason to stop the host.
    const content = bungalow.content(PLUGIN_FOLDER_NAME);
    // When the host loaded its plugins: a plugin that did not load needs attention from here (COR-2009).
    const pluginsLoadedAt = clock.now();
    const folderPlugins = await loadFolderPlugins({
      directory: content.kind === 'directory' ? content.path : undefined,
      dependencies: environment[PLUGIN_RUNTIME_DIRECTORY_VARIABLE]?.trim() || HOST_DEPENDENCIES,
      developmentPaths: developmentPlugins,
    });
    // The built-in `bureau` plugin (COR-1890) is listed first so the Plugins page shows it and the
    // manager refuses to turn it off. Bureau supplies the plugin itself, so it is not given to it again.
    const plugins = [
      ...(options.omitBuiltInPlugin === true ? [] : [BUREAU_PLUGIN_ENTRY]),
      ...packagePlugins,
      ...folderPlugins.entries,
    ];
    // The plugins read their choices from the same file, before the Bureau composes them. A secret
    // the provider routes store reaches a plugin that waits on it through the same watchers.
    const isProviderPlugin = (plugin: string): boolean =>
      held.providers?.current().providers.some((provider) => provider.plugin === plugin) === true;
    const pluginManager = await createPluginManager({
      workspaceSecrets,
      audit: async (entry) => {
        await held.bureau?.internals.auditTrail?.record(entry);
      },
      bungalow,
      plugins,
      unloaded: folderPlugins.failures.map((failure) => ({
        source: 'folder',
        location: failure.location,
        status: 'skipped',
        problems: [
          { code: 'load-failed', message: failure.message },
          ...(failure.developmentPath === undefined
            ? []
            : [{ code: 'development-source', path: failure.developmentPath } as const]),
        ],
      })),
      configurationQueue,
      // A provider plugin's allowlist applies without a restart: the provider manager reloads the catalog.
      appliesConfigurationLive: isProviderPlugin,
      checkDocument: (document) => held.providers?.checkDocument(document),
      applyConfiguration: async () => {
        await held.providers?.reload();
      },
      // So does its key saved on the plugin's own route (Plugins › Add the key, COR-2009): the
      // provider manager reads keys when it loads, so it loads again.
      applySecret: async (plugin) => {
        if (isProviderPlugin(plugin)) await held.providers?.reload();
      },
      listing: async () => (held.bureau === undefined ? [] : held.bureau.plugins.list()),
      reservedSecretKeys: [APPROVAL_SECRET_KEY, DELEGATION_SECRET_KEY, A2A_API_KEY_SECRET_KEY],
      reservedSecretPrefixes: [ANSWER_ENCRYPTION_KEY, TOOL_SOURCE_SECRET_PREFIX],
    });
    held.plugins = pluginManager;
    await pluginManager.ensureGeneratedSecrets();
    // The Bureau is built after the providers, so a run's agent is read through `held`.
    const agentOfRun: RunAgentLookup = async (runId) => {
      const bureau = held.bureau;
      if (bureau === undefined) return undefined;
      // A run this process holds answers at once; any other is read from the task registry.
      const live = bureau.tasks.detail(runId)?.agentName;
      if (live !== undefined) return live;
      const recorded = await bureau.tasks.get(runId);
      return recorded?.agentName ?? undefined;
    };
    const providers = createProviderManager({
      workspaceSecrets,
      bungalow,
      configurationQueue,
      afterConfigurationWrite: () => pluginManager.reload(),
      pluginConfigurations: async () => {
        await pluginManager.reload();
        return new Map(
          pluginManager
            .loadable()
            .map((entry) => [
              entry.descriptor.name,
              pluginManager.configuration(entry.descriptor.name),
            ]),
        );
      },
      warn: options.warn ?? ((message) => console.warn(message)),
      resolveProviderGenerate:
        options.resolveProviderGenerateFor?.(agentOfRun) ??
        options.resolveProviderGenerate ??
        resolveProviderGenerate,
      // The Bureau is built after the providers, so the trail is read through `held`.
      audit: async (entry) => {
        await held.bureau?.internals.auditTrail?.record(entry);
      },
    });
    held.providers = providers;
    const generateFor = (selection: ModelSelection): GenerateFunction =>
      providers.generateFor(selection);
    // The saved tool sources load before the Bureau is built, because an agent file names a tool
    // from the catalog the Bureau starts with. A source that fails is that source's own standing
    // and never stops the host. The origin is known only once the listener is up; until then
    // it fills the redirect URL of a source that already holds tokens, which starts no sign-in.
    let hostOrigin: string | undefined;
    const startPort = options.port ?? resolvePort(environment);
    const toolSources = createToolSourceManager({
      workspaceSecrets,
      ...(options.workspaceAuthentication === undefined
        ? {}
        : { workspace: options.workspaceAuthentication.workspace }),
      bungalow,
      keys: answerKeys,
      configurationQueue,
      audit: async (entry) => {
        await held.bureau?.internals.auditTrail?.record(entry);
      },
      // The Bureau is built after the sources, so the agent files are read through `held`.
      agentToolUse: async () =>
        held.bureau === undefined ? [] : agentToolUseOf(held.bureau.agents)(),
      origin: () => hostOrigin ?? `http://${LOOPBACK}:${startPort}`,
      warn: options.warn ?? ((message) => console.warn(message)),
      ...(options.toolSourceProbeTimeoutMilliseconds === undefined
        ? {}
        : { probeTimeoutMilliseconds: options.toolSourceProbeTimeoutMilliseconds }),
    });
    held.toolSources = toolSources;
    await toolSources.start();
    const configuration = await bungalow.readConfiguration();
    const configuredPeers = readA2APeersConfiguration(
      configuration.text,
      bungalow.configurationLocation,
    );
    const peerSecrets = new Map<string, string | undefined>();
    for (const peer of configuredPeers) {
      if (peer.bearerSecret !== undefined && !peerSecrets.has(peer.bearerSecret)) {
        peerSecrets.set(
          peer.bearerSecret,
          await workspaceSecrets.read(peer.bearerSecret, configuration),
        );
      }
    }
    const recoverableStartedApprovals = new Map<
      string,
      NonNullable<BureauOptions['recoverableStartedApprovals']> extends ReadonlyMap<
        string,
        infer Approval
      >
        ? Approval
        : never
    >();
    let peerCalls: PeerCallJournal | undefined;
    const peerCallHandoff: PeerCallJournal = {
      read: (key) => {
        if (peerCalls === undefined) throw new Error('The Bureau peer journal is not ready.');
        return peerCalls.read(key);
      },
      write: (key, entry) => {
        if (peerCalls === undefined) throw new Error('The Bureau peer journal is not ready.');
        return peerCalls.write(key, entry);
      },
    };
    const peerTools = createA2APeerTools({
      peers: configuredPeers,
      readSecret: (key) => peerSecrets.get(key),
      ...(options.a2aPeerFetch === undefined ? {} : { fetch: options.a2aPeerFetch }),
      ...(options.a2aPeerRecoveryUpdate === undefined
        ? {}
        : { onRecoveryUpdate: options.a2aPeerRecoveryUpdate }),
      egressPolicy: options.a2aPeerEgressPolicy ?? createEgressPolicy(),
      peerCalls: peerCallHandoff,
      recoverableStartedApprovals,
      warn: options.warn ?? ((message) => console.warn(message)),
    });
    const agentContent = bungalow.content(AGENT_DIRECTORY_NAME);
    const workflowContent = bungalow.content(WORKFLOW_DIRECTORY_NAME);
    // Hosts that share a database must agree on who owns a run, so a remote host holds ownership
    // to Bureau's lease default and the Settings page cannot store `none`: two hosts would then
    // both run every task. The other restart-applied settings that overlap depends on are held too
    // (COR-1797): `maintenance: 'manual'` starts no scheduler, so a run parked by the old release
    // would never finish on the new one, and `durable: false` or a claim TTL at or below the renew
    // interval would stop or lose the leases. The code defaults apply. A caller's own locks stay.
    const settings: SettingsOptions | undefined =
      bungalow.mode === 'remote'
        ? {
            ...options.settings,
            locked: { ...callerLocks, ...REMOTE_LOCKED_SETTINGS },
          }
        : options.settings;
    // Bureau recovers durable runs before it returns, and the skill manager waits for the Bureau, so
    // a run recovered at boot reads this catalog, or it would lose the skills it held.
    const firstSkills = await discoverFirstSkills({
      bungalow,
      pluginSources: () =>
        pluginManager.loadable().flatMap((entry) => {
          const shipped = entry.descriptor.content;
          const source =
            shipped === undefined
              ? undefined
              : createPluginSkillSource(entry.descriptor.name, shipped);
          return source === undefined ? [] : [source];
        }),
    });
    const peerToolNames = new Set(Object.keys(peerTools));
    const sourceTools = toolSources.tools();
    const directoryOptions: LocalDirectoryOptions =
      options.directoryWatch === undefined ? {} : { watch: options.directoryWatch };
    for (const name of Object.keys(sourceTools)) {
      if (peerToolNames.has(name)) {
        (options.warn ?? ((message) => console.warn(message)))(
          `Configured A2A peer tool "${name}" replaces an existing tool with the same name.`,
        );
      }
    }
    const localWorkspace = localWorkspaceMembership(
      bungalow.workspaceId,
      a2aExposure.authentication !== undefined,
    );
    const configuredWorkspace = options.workspaceAuthentication?.workspace ?? localWorkspace;
    if (configuredWorkspace.workspaceId !== bungalow.workspaceId)
      throw new Error('The authentication directory belongs to another workspace.');
    const workspace =
      options.workspaceAuthentication === undefined || a2aExposure.authentication === undefined
        ? configuredWorkspace
        : {
            ...configuredWorkspace,
            resolveMembership: async (
              credential: Parameters<typeof configuredWorkspace.resolveMembership>[0],
            ) =>
              credential.method === 'api-key' && credential.subject === A2A_SUBJECT
                ? localWorkspace.resolveMembership(credential)
                : configuredWorkspace.resolveMembership(credential),
            resolveOwnerMembership: async (owner: string) =>
              owner === `api-key:${encodeURIComponent(A2A_SUBJECT)}`
                ? ((await localWorkspace.resolveOwnerMembership?.(owner)) ?? null)
                : ((await configuredWorkspace.resolveOwnerMembership?.(owner)) ?? null),
          };
    const authentication = await combineHostAuthentication(
      options.workspaceAuthentication?.authentication,
      a2aExposure.authentication,
    );
    const authority = await createHostAuthority(
      workspace,
      authentication,
      options.workspaceAuthentication === undefined,
    );
    const bureau = await createBureau({
      peerCallsReady: (journal) => {
        peerCalls = journal;
      },
      recoverableStartedApprovals,
      workspace,
      id: bungalow.workspaceId,
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      agents: { ...options.extraAgents?.agents },
      ...(options.extraAgents?.withBureauTools === undefined
        ? {}
        : { agentsWithBureauTools: { ...options.extraAgents.withBureauTools } }),
      ...(options.extraAgents?.validators === undefined
        ? {}
        : { validators: options.extraAgents.validators }),
      // The default of the `decisions.model` setting is the plugin's Jev model, while that plugin
      // is loaded and enabled; the other choice is Bureau's own `catalog`, the language-model fallback.
      ...defaultDecisionOptions(pluginManager.loadable(), pluginManager.settings()),
      // A file's `model` is a row of this catalog, so it runs with the key in the secrets.
      // The catalog is built once the plugins have been set up, from the providers they contribute.
      models: {
        catalog: (contributions) => providers.adopt(contributedProviders(contributions)),
        // A stored allowlist the provider's rows do not match skips its plugin and starts the host.
        checkProviders: (check) => providers.checkProviders(check),
        generate: (row) => generateFor({ provider: row.provider, model: row.model }),
      },
      storage,
      // The plugins this host loads, the owner's choices for them, and the secrets they declare
      // (COR-1880). Memory is built once their setup has run, with what they contribute to it.
      plugins: pluginManager.loadable().filter((entry) => entry.source !== 'built-in'),
      pluginConfiguration: pluginManager.settings(),
      pluginSecrets: pluginManager.secrets,
      answerEncryption: answerKeys,
      // The audit trail is kept 90 days (COR-1810); a person changes it on the Settings page, and
      // the stored value then replaces this default.
      // Expired records go once a night, at 3:00 AM in the host's zone, not on every maintenance
      // pass (COR-2009): the host's nightly clean-up removes them.
      expiredRecords: 'on-request',
      retention: {
        audit: { olderThan: AUDIT_RETENTION_MILLISECONDS },
        logs: { olderThan: WORKFLOW_LOG_RETENTION_MILLISECONDS },
        notifications: { olderThan: NOTIFICATION_RETENTION_MILLISECONDS },
        hookDeliveries: { olderThan: HOOK_DELIVERY_RETENTION_MILLISECONDS },
      },
      // The `ctx.log` lines of a workflow are kept with its run (COR-1811), so the run page can show
      // them: the newest 500 per run, for seven days, both changeable on the Settings page.
      logs: { maximumLinesPerRun: WORKFLOW_LOG_MAXIMUM_LINES_PER_RUN },
      // Governed memory (COR-1546): an agent remembers across every chat its owner has with it, and
      // the Memory page lists, searches, forgets, and corrects what it remembers.
      memory: (contributions) => createHostMemory(storage, contributions, options.runtime),
      // Managed assets (COR-1547): the handler serves uploads and an asset's content, and a chat
      // attachment is one, so the Bureau keeps them in the same database as everything else.
      assets: { storage: createDurableAssetStorage(storage) },
      // Agent files: Markdown files in Bungalow's `agents/` directory are agents (COR-1524). A
      // file's `model` is a row of the `models` catalog.
      agentSource: createAgentSource(
        bungalow,
        agentContent,
        {
          ...options.extraTools,
          ...sourceTools,
          ...peerTools,
        },
        directoryOptions,
      ),
      agentSkillCatalog: () => held.skills?.standing().catalog ?? firstSkills,
      // The agent files a running plugin ships (COR-1897): its `content/agents`, read-only, beneath the owner's.
      pluginAgentSource: (plugin, shipped) =>
        createPluginAgentSource(plugin, shipped, directoryOptions),
      // The approvals a file agent's tools raise are signed with the host's approval secret, so a
      // restart still resolves a pending one.
      agentApprovalSecret: approval,
      children: {
        delegation: {
          secret: delegation,
          rootAuthority: { levels: 2, budget: { concurrentChildren: 4, totalDescendants: 16 } },
        },
      },
      // Workflow files: JSON files in Bungalow's `workflows/` directory are agent-authored
      // workflows (COR-1527), registered with the Bureau's engine and run on their schedules.
      workflowSource: createWorkflowSource(bungalow, workflowContent, directoryOptions),
      // The workflow files a running plugin ships (COR-1977): its `content/workflows`, read-only, beneath the owner's.
      pluginWorkflowSource: (plugin, shipped) =>
        createPluginWorkflowSource(plugin, shipped, directoryOptions),
      ...(settings === undefined ? {} : { settings }),
      // User-defined hooks (COR-1939): signed webhooks, started workflows and notifications over the
      // Bureau's events, with what a remote home needs of them (COR-1978).
      hooks: hookOptionsFor(bungalow.mode),
      ...(options.hookFetch === undefined
        ? {}
        : { webhooks: { targets: [], fetch: options.hookFetch } }),
      ...(options.alerts === undefined ? {} : { alerts: options.alerts }),
      ...(options.storageSizeReportIntervalMilliseconds === undefined
        ? {}
        : { storageSizeReportIntervalMs: options.storageSizeReportIntervalMilliseconds }),
      // Needs attention (COR-2009): no model provider connected is the host's to see, and so is a
      // plugin the host skipped before the Bureau composed the rest.
      attention: async () => [
        ...(await providerAttention({
          rows: () => providers.current().rows,
          auditTrail: () => held.bureau?.internals.auditTrail,
        })),
        ...pluginAttention(await pluginManager.snapshot(), pluginsLoadedAt),
      ],
    });
    held.bureau = bureau;
    // The records past their retention window go once a night (COR-2009): the Bureau leaves them
    // to this clean-up (`expiredRecords: 'on-request'`), and Data and retention reports it.
    const nightlyCleanUp = startNightlyCleanUp({
      storage,
      removeExpiredRecords: async () => {
        await workspaceSecrets.reconcile();
        return bureau.removeExpiredRecords();
      },
      now: clock.now,
      ...options.nightlyCleanUp,
      warn: options.warn ?? ((message) => console.warn(message)),
    });
    held.nightlyCleanUp = nightlyCleanUp;
    // A tool source connected from now on is loaded at once, and its tools join the Bureau's
    // catalog without a restart (COR-2009).
    toolSources.goLive((tools) => bureau.agents.addTools(tools));
    // One line per plugin with its status and problem codes, once Bureau has composed them.
    for (const line of pluginStartupLines(await pluginManager.snapshot())) {
      log(line);
    }
    // The skills the configuration names are discovered now and handed to the handler below. A
    // trust change is audited by the Bureau's trail, so the manager waits for the Bureau.
    const skills = await createSkillManager({
      bungalow,
      configurationQueue,
      // The skills a running plugin ships (COR-1977): its `content/skills`, read each time the catalog is discovered.
      pluginSources: async () => {
        const listed = await bureau.plugins.list();
        const loadable = pluginManager.loadable();
        // Two plugins may share a name, one running and one skipped with `name-clash`, so a running
        // listing is matched to its entry by where it came from, as the plugin snapshot does.
        return listed.flatMap((listing) => {
          const entry = loadable.find(
            (candidate) =>
              candidate.source === listing.source && candidate.location === listing.location,
          );
          const shipped = entry?.descriptor.content;
          const source =
            listing.status === 'running' && shipped !== undefined
              ? createPluginSkillSource(listing.descriptor.name, shipped)
              : undefined;
          return source === undefined ? [] : [source];
        });
      },
      // Strict, so a failed write rejects and the trust route answers `partial` (COR-1926).
      audit: async (entry) => {
        await bureau.internals.auditTrail?.record({ ...entry, strict: true });
      },
    });
    held.skills = skills;
    // From here a change to the configuration or a key reaches the Bureau's catalog, and a file
    // agent is validated against it again.
    providers.attach(async (rows) => {
      const catalog = bureau.models.replace(rows);
      // `replace` starts a rescan of the agent files without waiting for it. A file agent keeps
      // the generate it was built with, so a run that starts after this resolves must find the
      // agents already rebuilt with the keys just read.
      await bureau.agents.refresh();
      return catalog.revision;
    });

    // The console serves the engine that owns the Bureau's runs. A second engine over the same
    // storage holds no lease on them, so its cancel would not be fenced by their owner and its
    // live feed would not see them.
    let engine = bureau.durableEngine();
    if (engine === undefined) throw new Error('The Bureau composed no durable engine.');
    if (options.createConsoleEngine !== undefined) {
      engine = await options.createConsoleEngine(storage);
      held.replacementEngine = engine;
    }

    // The handler is built once the listener has a port, because the Agent Card of an agent that
    // opts into A2A names the URL it is served at (COR-1819). Until then `/bureau/*` answers 503,
    // which only a client that guessed the port could see.
    const mcpMounts = await panelMounts(
      bureau.plugins.panels(),
      environment[PANEL_PREBUILT_DIRECTORY_VARIABLE]?.trim() || undefined,
    );
    // A plugin's app that does not build is left out and listed as a problem on the plugin; it
    // never stops the host from starting.
    for (const failure of mcpMounts.failures) {
      bureau.plugins.reportPanelFailure(failure.plugin, failure.app, failure.message);
      log(`Plugin ${failure.plugin}: its panel ${failure.app} did not build: ${failure.message}`);
    }
    let bureauHandler: BureauHandler | undefined;
    const bureauSockets: BureauHandler['websocket'] = {
      open: (socket) => bureauHandler?.websocket.open(socket),
      message: (socket, message) => bureauHandler?.websocket.message(socket, message),
      close: (socket) => bureauHandler?.websocket.close(socket),
    };
    let engineUpstream: ((upstream: EngineUpstream) => void) | undefined;
    const upstream = new Promise<EngineUpstream>((resolve) => {
      engineUpstream = resolve;
    });
    // Every route, the relay, and every WebSocket upgrade go through one guard (`request-guard.ts`).
    let listening: Bun.Server<HostSocketData> | undefined;
    const refuse = createRequestGuard(() => listening?.port ?? 0);
    // `/bureau/*` alone also answers the public origin, and only for its A2A paths (COR-1904).
    const refuseBureau =
      a2aExposure.publicOrigin === undefined
        ? refuse
        : createRequestGuard(() => listening?.port ?? 0, a2aExposure.publicOrigin);
    // Who a request to Interborough's own operations acts as: the local person, holding every scope
    // of Interborough's API, unless the host was started with another (`scope-gate.ts`).
    const apiPrincipal = options.apiPrincipal ?? (() => localApiPrincipal(ANONYMOUS_LOCAL_OWNER));
    // Changing a provider or a plugin is changing settings, which needs `settings:write`.
    const refuseSettingsWrites = refuseWritesWithoutScope(refuse, 'settings:write', apiPrincipal);
    const buildDirectory = options.buildDirectory ?? DEFAULT_BUILD_DIRECTORY;
    const devReload = options.development === true ? createDevReload() : undefined;
    if (devReload !== undefined) held.devReload = devReload;
    const shell = shellResponder(buildDirectory, devReload !== undefined);
    // Handed over by the supervisor when it started (`launch-command.ts`), for the page to show
    // after a restart that does not come back.
    const launchCommand = resolveLaunchCommand(environment);
    const restart =
      options.onRestartRequested === undefined
        ? undefined
        : restartHandler(options.onRestartRequested);
    const publicRoutes = {
      ...applicationRoutes(buildDirectory, refuse, shell),
      '/api/v1/principal': {
        GET: async (request: Request) => {
          const context = await authority.authenticate(request);
          if (context instanceof Response) return context;
          const principalUrl = new URL(request.url);
          principalUrl.pathname = '/v1/principal';
          return handleRequest(new Request(principalUrl, request), engine, {
            authContext: context,
          });
        },
      },
      // The development reload stream. A production host registers no route, so the path is a 404.
      ...(devReload === undefined
        ? {}
        : {
            [DEV_RELOAD_ROUTE]: {
              GET: (request: Request) => refuse(request) ?? devReload.connect(),
            },
          }),
      // The guard answers first, for an upgrade as for any request. An upgrade goes to Bureau's
      // handler with the prefix removed, as a request does; a refused one falls through to the
      // handler, which answers it as the plain request it then is.
      [`${BUREAU_PATH_PREFIX}/*`]: async (
        request: Request,
        listener: Bun.Server<HostSocketData>,
      ) => {
        const refusal = refuseBureau(request);
        if (refusal !== undefined) return refusal;
        if (bureauHandler === undefined) {
          return new Response('The Bureau is not serving yet.', { status: 503 });
        }
        const bureauRequest = withoutBureauPrefix(request);
        // The scopes of Interborough's API, on the operations its pages call (`scope-gate.ts`).
        const forbidden = await bureauScopeRefusal(bureauRequest, apiPrincipal(request));
        if (forbidden !== undefined) return forbidden;
        if (
          isWebSocketUpgrade(request) &&
          (await bureauHandler.upgrade(bureauRequest, bureauUpgradeServer(listener, request)))
        ) {
          return undefined;
        }
        return bureauHandler(bureauRequest);
      },
      // Whether the host can restart, and the command it was launched with (COR-2009), and the
      // restart request itself. The guard answers first, so a page on another origin cannot
      // restart the host. A host no supervisor started has no `POST`, so that path is a 404.
      [HOST_RESTART_ROUTE]: {
        GET: (request: Request) =>
          refuse(request) ??
          Response.json({
            available: restart !== undefined,
            launch: launchCommand ?? null,
          } satisfies HostRestartStanding),
        ...(restart === undefined
          ? {}
          : { POST: (request: Request) => refuse(request) ?? restart() }),
      },
      [HOST_STATUS_ROUTE]: {
        GET: (request: Request) =>
          refuse(request) ??
          Response.json({
            deploymentId: bungalow.deploymentId,
            incarnationId,
            diagnostics: {
              bureau: bureau.internals.diagnostics(),
              weft: {
                lease: engine.getLeaseHealth(),
                workers: server.registry.getWorkerSummaries(clock.now()),
                connections: server.connections(),
              },
              build: buildDiagnostics(buildDirectory),
              providers: providerDiagnostics(providers.current()),
              pendingSecretOperations: workspaceSecrets.pending(),
              pendingSecretOperationCount: workspaceSecrets.pending().length,
            },
          } satisfies HostStatus),
      },
      ...providerRoutes(providers, refuseSettingsWrites, authority, log),
      ...pluginRoutes(pluginManager, refuseSettingsWrites, authority, log),
      // The nightly clean-up's standing, and "Clean up now" (COR-2009).
      ...cleanUpRoutes(nightlyCleanUp, refuse),
      // A plugin's panel on the run page: its page, and the Bureau tools it declared (COR-1894).
      ...panelRoutes(
        mcpMounts.apps,
        refuse,
        async (request) =>
          (await bureauScopeRefusal(request, apiPrincipal(request))) ??
          (await bureauHandler?.(request)) ??
          new Response('The Bureau is not serving yet.', { status: 503 }),
      ),
      ...skillRoutes(skills, refuse, authority, log),
      ...toolSourceRoutes(
        toolSources,
        refuse,
        {
          mutation: (request, input) => authority.mutation(request, input),
        },
        log,
      ),
      // Interborough's own API over the Bureau (COR-2019), checked against the session's scopes.
      // Interborough is single-user for now, so every request is the local person, who holds
      // every scope. Weft's engine operations under `/api/v1` are relayed below, as before.
      ...apiRoutes(
        {
          bureau,
          timeline: (runId) => engine.getTimeline(runId),
          principal: apiPrincipal,
          log,
          // A message sent through the API takes the admission Chat's own send takes.
          startTurn: (input) => startIdleTurn(bureau, input),
        },
        refuse,
      ),
      [API_DESCRIPTION_ROUTE]: {
        GET: (request: Request) =>
          refuse(request) ??
          Response.json(
            // The API answers only the host's own address, not an A2A public origin.
            apiDescription(hostOrigin ?? `http://${LOOPBACK}:${startPort}`),
          ),
      },
      // The key prefixes the Bureau writes, which the storage explorer refuses to edit.
      [HOST_STORAGE_ROUTE]: {
        GET: async (request: Request) =>
          refuse(request) ?? Response.json(await hostStorageReport(storage)),
      },
      // How many keys storage holds under a prefix, and how large it is, for the storage page's
      // footer and its "Storage details".
      [HOST_STORAGE_SUMMARY_ROUTE]: {
        GET: async (request: Request) =>
          refuse(request) ??
          Response.json(
            await hostStorageSummary(
              storage,
              new URL(request.url).searchParams.get('prefix') ?? '',
            ),
          ),
      },
      [HOST_PATHS_ROUTE]: {
        GET: async (request: Request) =>
          refuse(request) ??
          Response.json(
            hostPathsReport(
              bungalow,
              { agents: agentContent, workflows: workflowContent },
              providers
                .current()
                .providers.flatMap(({ name, secretKey }) =>
                  secretKey === undefined ? [] : [{ name, secretKey }],
                ),
              // The directory of the agents shared over A2A, at the address a caller reaches: the
              // public origin when one is set (COR-1904), else this host's own.
              `${a2aExposure.publicOrigin?.origin ?? hostOrigin ?? `http://${LOOPBACK}:${startPort}`}${BUREAU_PATH_PREFIX}/a2a/.well-known/agent-card.json`,
            ),
          ),
      },
    };
    inventoryHostRoutes(publicRoutes);
    const publicServer = Bun.serve<HostSocketData>({
      hostname: LOOPBACK,
      port: options.port ?? resolvePort(environment),
      // Bun closes a connection that sends nothing for 10 seconds by default. The pages hold
      // streams that are quiet for longer: the engine's event feed pings every 15 seconds, and a
      // chat run waiting on a person's answer sends nothing at all. A stream cut that way ends
      // without its terminating chunk, and Chromium logs `ERR_INCOMPLETE_CHUNKED_ENCODING` for each
      // one (COR-1643). The listener is loopback-only behind the request guard, so a connection
      // that stays open costs nothing a timeout would save.
      idleTimeout: 0,
      routes: authorizeHostRoutes(publicRoutes, authority, refuse),
      async fetch(request, listener) {
        const refusal = refuse(request);
        if (refusal !== undefined) return refusal;
        if (!isEngineRequestPath(new URL(request.url).pathname)) {
          // An address no client route names: the router renders its not-found view inside the
          // shell. A miss on an asset, the engine, or the Bureau stays a 404.
          if (isShellNavigation(request)) return shell();
          return new Response('Not found', { status: 404 });
        }
        const denied = await authority.authorize(request, 'deployment-operator');
        if (denied !== undefined) return denied;
        const { url, key } = await upstream;
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const data = webSocketRelayData(request, url, key);
          if (data !== undefined && listener.upgrade(request, { data })) return undefined;
          return new Response('WebSocket upgrade failed', { status: 500 });
        }
        // A storage key deleted through the relay is recorded once the engine says it is gone.
        const deletion = await storageDeletionOf(request);
        const relayed = await relayRequest(request, url, key);
        if (deletion !== undefined && (await storageDeletionApplied(deletion, relayed))) {
          const actor = await authority.authenticate(request);
          const principal =
            actor instanceof Response
              ? ANONYMOUS_LOCAL_OWNER
              : (actor.principal?.subject ?? ANONYMOUS_LOCAL_OWNER);
          for (const deleted of deletion.keys) {
            await held.bureau?.internals.auditTrail
              ?.record({
                runId: storageResourceOf(deleted),
                type: 'storage.key.deleted',
                principal,
                detail: null,
              })
              .catch(() => undefined);
          }
        }
        return relayed;
      },
      websocket: hostWebSocketHandlers(bureauSockets),
    });
    held.publicServer = publicServer;
    listening = publicServer;
    const publicPort = publicServer.port;
    if (publicPort === undefined) throw new Error('The public listener has no port.');
    const publicOrigin = `http://${LOOPBACK}:${publicPort}`;
    hostOrigin = publicOrigin;
    // A2A push delivery is a restart-applied setting: the values read here are the ones this
    // process booted with (COR-1819).
    const { values: bootedSettings } = await bureau.settings.get();
    // `a2a.enabled` is a restart-applied setting too: off, no A2A mount is built, so no remote
    // call is answered and there is no push delivery to run (COR-2019).
    const a2aEnabled = bootedSettings['a2a.enabled'] !== false;
    const pushDelivery = a2aEnabled
      ? startHostPushDelivery(
          storage,
          bungalow.deploymentId,
          bootedSettings,
          options.warn ?? ((message) => console.warn(message)),
        )
      : undefined;
    if (pushDelivery !== undefined) held.pushDelivery = pushDelivery;
    // COR-2009 — the audit log's "Server started", recorded once the listener is up. The missed
    // schedule occurrences this start finds are recorded by the Bureau as `schedule.missed`.
    await bureau.internals.auditTrail?.record({
      runId: 'host',
      type: 'host.started',
      principal: HOST_ACTOR,
      detail: options.version === undefined ? {} : { version: options.version },
    });
    bureauHandler = createBureauHandler(bureau, {
      workspace,
      // The local caller, unless the request carries a credential. With an A2A key configured
      // (COR-1904), a credential is checked against it, and A2A's JSON-RPC routes require one.
      ...(options.workspaceAuthentication === undefined
        ? {
            unauthenticatedAccess: 'allow' as const,
            ...(authentication === undefined ? {} : { authentication }),
          }
        : { authentication: authentication! }),
      // Chat runs over AG-UI: the mount starts, attaches to, and resumes a run, and takes the
      // `RunAgentInput` Chat's transport sends.
      agUi: {},
      // An MCP host (Claude Desktop or Claude Code) observes and steers this Bureau's work at
      // `/bureau/mcp` (COR-839). It is Bureau's own endpoint, not the engine's `/mcp`: Bureau owns
      // what a local caller does as `anonymous:local`, which the engine's relayed principal is not.
      // Its run inspector is an MCP App (COR-910): the page is built here, in this application, and
      // handed to the adapter as an injected `ui://` resource linked to `bureau.tasks.inspect`.
      mcp: mcpMounts,
      // A2A (COR-1819): an agent that opts in is served at `<origin>/bureau/a2a/<name>`, which is
      // where the `/bureau/*` route above sends it once the prefix is removed. Without an A2A key
      // the listener is loopback-only behind the request guard and every call acts as the owner,
      // so A2A is no more reachable than the rest of the host. With a public origin (COR-1904) the
      // cards name it, because that is the address a remote caller reaches.
      ...(a2aEnabled
        ? {
            publicUrl: `${a2aExposure.publicOrigin?.origin ?? publicOrigin}${BUREAU_PATH_PREFIX}`,
            ...(a2aAgents === undefined ? {} : { a2aAgents }),
          }
        : {}),
      // `bureau.skills.list` reads the host's standing on every request, so a trust change shows
      // on the next call.
      skills: { standing: () => skills.standing() },
      ...(pushDelivery === undefined ? {} : { pushNotifications: pushDelivery.pushNotifications }),
    });

    const key = randomBytes(32).toString('hex');
    const engineServerOptions = { ...options.engineServer };
    // HostOptions exposes timing options only; this listener serves the built-in registry.
    const engineInventory = inventoryEngineRelay();
    const server = serve({
      engine,
      hostname: LOOPBACK,
      port: 0,
      auth: createLocalAuthentication(key),
      // Signs the worker start-override previews an operator spends on a terminal run's restart.
      // Derived from this process's key, so a restart of the host invalidates every outstanding
      // token, which is the safe direction, and nothing secret is written to disk.
      workerStartOverrideSigningSecret: deriveStartOverrideSigningSecret(key),
      // Discovery documents name absolute URLs, and they must name the origin a browser used, not
      // the private listener the relay forwards to.
      publicOrigin,
      trustedHosts: allowedHosts(publicPort),
      ...engineServerOptions,
    });
    held.server = server;
    await server.ready;
    engineUpstream?.({ url: server.url, key });
    return {
      routeInventory: Object.freeze([
        ...inventoryHostRoutes(publicRoutes, bureauHandler.resourceInventory),
        engineInventory,
      ]),
      url: new URL(`http://${LOOPBACK}:${publicPort}/`),
      bureau,
      engine,
      server,
      deploymentId: bungalow.deploymentId,
      workspaceId: bungalow.workspaceId,
      runtimeInstanceId: randomUUID(),
      database,
      generateFor,
      configurationQueue,
      toolSources: {
        probe: (request, mutation) => toolSources.probe(request, mutation),
        test: (id, mutation) => toolSources.test(id, mutation),
        connect: (request, mutation) => toolSources.connect(request, mutation),
        configureTools: (request, mutation) => toolSources.configureTools(request, mutation),
        remove: (request, mutation) => toolSources.remove(request, mutation),
        affectedAgents: (id) => toolSources.affectedAgents(id),
        snapshot: () => toolSources.snapshot(),
        authorize: (id, mutation) => toolSources.authorize(id, mutation),
        completeAuthorization: (id, callbackUrl, mutation) =>
          toolSources.completeAuthorization(id, callbackUrl, mutation),
      },
      skills: {
        setTrust: (request, mutation) => skills.setTrust(request, mutation),
        refresh: () => skills.refresh(),
        standing: () => skills.standing(),
      },
      plugins: {
        snapshot: () => pluginManager.snapshot(),
        update: (name, request, mutation) => pluginManager.update(name, request, mutation),
        saveSecret: (name, secretKey, value, mutation) =>
          pluginManager.saveSecret(name, secretKey, value, mutation),
      },
      cleanUp: {
        standing: () => nightlyCleanUp.standing(),
        cleanUpNow: () => nightlyCleanUp.cleanUpNow(),
      },
      providers: {
        connect: (connection, mutation) => providers.connect(connection, mutation),
        disconnect: (provider, mutation) => providers.disconnect(provider, mutation),
        editCatalog: (edits, base, mutation) => providers.editCatalog(edits, base, mutation),
        reload: () => providers.reload(),
        snapshot: () => providers.snapshot(),
      },
      diagnostics: () => ({
        bureau: bureau.internals.diagnostics(),
        weft: {
          lease: engine.getLeaseHealth(),
          workers: server.registry.getWorkerSummaries(clock.now()),
          connections: server.connections(),
        },
        build: buildDiagnostics(buildDirectory),
        providers: providerDiagnostics(providers.current()),
        pendingSecretOperations: workspaceSecrets.pending(),
        pendingSecretOperationCount: workspaceSecrets.pending().length,
      }),
      notifyRebuilt: () => devReload?.notify(),
      close: () => (held.closing ??= teardown(held)),
    };
  } catch (error) {
    await teardown(held).catch(() => undefined);
    throw error;
  }
}

/** The signing secret for worker start-override previews, derived from the per-process key. */
export function deriveStartOverrideSigningSecret(key: string): string {
  return createHash('sha256').update(`interborough:worker-start-override:${key}`).digest('hex');
}

/** What the host holds while it starts and runs, so a failure at any step can release the rest. */
type Held = {
  readonly bungalow: Bungalow;
  storage?: Storage;
  bureau?: Bureau<AgentDefinitions>;
  providers?: ProviderManager;
  plugins?: PluginManager;
  skills?: SkillManager;
  toolSources?: ToolSourceManager;
  replacementEngine?: RegistryAgnosticEngine;
  server?: WeftServer;
  pushDelivery?: HostPushDelivery;
  nightlyCleanUp?: NightlyCleanUp;
  publicServer?: Bun.Server<HostSocketData>;
  devReload?: DevReload;
  closing?: Promise<void>;
};

/** Release everything the host holds, in the reverse of the order it took it, whatever failed. */
async function teardown(held: Held): Promise<void> {
  const failures: unknown[] = [];
  const step = async (release: (() => unknown) | undefined): Promise<void> => {
    try {
      await release?.();
    } catch (error) {
      failures.push(error);
    }
  };
  // No change to the providers may start once the host is going away.
  held.providers?.close();
  held.plugins?.close();
  held.skills?.close();
  // End the reload streams first, so no page is left reading a host that is going away.
  await step(held.devReload && (() => held.devReload?.close()));
  await step(held.publicServer && (() => held.publicServer?.stop(true)));
  await step(held.server && (() => held.server?.stop()));
  await step(held.pushDelivery && (() => held.pushDelivery?.stop()));
  await step(held.nightlyCleanUp && (() => held.nightlyCleanUp?.close()));
  await step(held.bureau && (() => held.bureau?.shutdown({ policy: 'detach' })));
  // After the Bureau: a run still in flight may be calling a source's tool.
  await step(held.toolSources && (() => held.toolSources?.close()));
  await step(held.replacementEngine && (() => held.replacementEngine?.[Symbol.asyncDispose]()));
  const { storage } = held;
  await step(storage && (() => disposeHostStorage(storage)));
  await step(() => held.bungalow.close());
  if (failures.length > 0) {
    throw new AggregateError(failures, 'The Interborough host did not shut down cleanly.');
  }
}
