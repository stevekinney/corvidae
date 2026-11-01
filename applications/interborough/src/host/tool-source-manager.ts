/**
 * The host's saved tool sources while it runs (COR-1930): the MCP servers and OpenAPI services
 * `toolSources` in `configuration.json` names (`tool-sources-configuration.ts`), whose tools an
 * agent file may list by name, and the ways a person changes them.
 *
 * - **Loaded at boot, listed after a restart.** {@link ToolSourceManager.start} loads every
 *   configured source through Armorer's loader (`armorer/tool-sources`) before the Bureau is
 *   built, and {@link ToolSourceManager.tools} is the catalog the Bureau is built with. A source
 *   that is added, changed or removed afterwards shows in {@link ToolSourceManager.snapshot} as
 *   `pending-restart` until the host starts again.
 * - **One source never blocks another, or the host.** A source that fails to connect, names a
 *   credential nobody stored, has credentials that cannot be read, or does not answer within
 *   {@link ToolSourceManagerOptions.loadTimeoutMilliseconds} is reported on its own entry and the
 *   rest load. An OAuth source with no tokens is not contacted at boot: it reports
 *   `needs-authorization` until a person signs in ({@link ToolSourceManager.authorize}).
 * - **Credentials are never plaintext.** A value arrives in a request, goes straight into the
 *   encrypted vault (`tool-source-vault.ts`, Bungalow secret `tool-source-<id>`), and is read back
 *   only to hand to Armorer's loader through `resolveCredential` and the OAuth token storage.
 *   Nothing here returns, logs, audits or puts in an error a credential, a URL, or an environment
 *   value.
 * - **A change is validated, then committed secret first.** {@link ToolSourceManager.connect}
 *   checks the whole request before it writes a byte, stores the credentials, then writes the
 *   configuration through the queue every writer of the file shares (`configuration-queue.ts`). If
 *   the configuration write fails and the file is not the one meant, the previous secret is put
 *   back; if that fails too, the error says the change is partial. A write that threw after it
 *   replaced the file is read back and taken as done.
 * - **`acceptsSecrets` per tool (COR-1932).** The owner's per-tool settings sit in the entry's
 *   `tools`, keyed by the tool's own name. At load, a flagged tool is rebuilt with
 *   `metadata.acceptsSecrets: true` (`tool-source-tool-settings.ts`), the key Armorer reads for
 *   secret answers (COR-1816); every other tool keeps the loader's metadata. Every tool, flagged or
 *   not, is rebuilt behind the gate below, and keeps the `version` the loader gave it (COR-1950): an
 *   approval, and a chat's remembered tool, are bound to it. A setting that
 *   reaches no tool is reported on the source as `unmatchedSettings`. {@link
 *   ToolSourceManager.configureTools} changes the settings through the same queue and lock.
 * - **Local only.** A remote home keeps its configuration in a bucket and its secrets in the
 *   environment, which the host cannot write, so every change is refused with the lock reason
 *   `deployment` ({@link ToolSourceWriteLockedError}), as for providers and skills.
 * - **A probe contacts a source before it is saved.** {@link ToolSourceManager.probe} checks a
 *   request as {@link ToolSourceManager.connect} does, loads the source with the credentials the
 *   request carries and nothing from the vault, and answers with the tools it lists. It stores,
 *   writes and records nothing, closes the connection before it answers, runs against its own
 *   deadline ({@link DEFAULT_PROBE_TIMEOUT_MILLISECONDS}), and reports a source that does not
 *   answer as a sentence that holds no address, command or value. An OAuth server that asks for
 *   a sign-in is reported as `needs-authorization`: the sign-in belongs to a saved source.
 * - **A local command is the owner's.** A source that spawns a process on this machine is probed or added
 *   only by the owner principal ({@link ToolSourceOwnerOnlyError}), and the addition is recorded
 *   in the audit trail with its command line (never its environment).
 * - **The sign-in.** {@link ToolSourceManager.authorize} starts an MCP OAuth flow and returns the
 *   authorization URL; the person's browser comes back to `/host/oauth/callback/<id>`
 *   ({@link ToolSourceManager.completeAuthorization}), which accepts only the `state` the flow
 *   recorded, only while a flow is waiting, only within {@link SIGN_IN_TIME_TO_LIVE_MILLISECONDS}
 *   of the URL being handed out, and only for the description the flow began for. It takes its
 *   turn in the configuration queue and on the source's secret, like every other change, so a
 *   removal that arrives during the token exchange waits for it.
 * - **Credentials go only where they were given.** A stored credential is carried over only for
 *   the same source going to the same place ({@link recipientOf}); a changed address drops it and
 *   the OAuth state, and a new source never inherits a secret an earlier one left behind. The tools
 *   a replaced or removed source loaded stay in the catalog until a restart, but each refuses to
 *   run: every saved source's tools are built behind one gate ({@link refusingWhen}) that checks
 *   {@link retired} in the manager, so no kind of source can use what the loader captured.
 * - **Removal lists the agents it breaks, and rewrites none of them (COR-1931).**
 *   {@link ToolSourceManager.affectedAgents} reads the agent files that name any of the source's
 *   tools, in `tools` or only in `toolApproval`, before anything is removed; {@link
 *   ToolSourceManager.remove} answers the same list and records the agents' identifiers in its audit
 *   entry. A file is affected when it names a tool the host loaded from the source or any name
 *   that starts with `<id>__` (a source that failed, awaits a sign-in, or was added since the host
 *   started loaded nothing, but an agent file may still name its tools). An agent file is never
 *   edited. The Bureau's tool catalog is fixed when the host starts, so the removed tools stay in it
 *   (each refuses to run, and the source's connection is closed) and the affected agents stay as
 *   they were until the next start; then each reads `invalid` with `unknown-tool`, naming the tool,
 *   until the owner detaches it. Taking the tools away at once
 *   would need a catalog that changes while agents run, which the Bureau does not have, and it
 *   matches every other change to a source, which also takes effect at the next start. The
 *   credential, and any OAuth state a sign-in in progress had stored, are cleared with the source;
 *   a sign-in that was still starting when the source went is cleared by {@link ToolSourceManager.authorize}.
 *
 * @module tool-source-manager
 */

import type { Bungalow } from '@lostgradient/bungalow';
import {
  ANONYMOUS_LOCAL_OWNER,
  auditTrailToolSourceOwnerId,
  type AnswerEncryptionKeys,
  type SettingLockReason,
} from '@lostgradient/bureau';
import { resolveCapabilityTier, type McpOAuthTokenStorage, type Tool } from 'armorer';
import {
  completeToolSourceAuthorization,
  loadToolSource,
  parseToolSourceDescription,
  ToolSourceAuthorizationRequiredError,
  ToolSourceBaseUrlError,
  ToolSourceCredentialError,
  ToolSourceDescriptionError,
  type LoadedToolSource,
  type ToolSourceDescription,
  type ToolSourceOAuthOptions,
} from 'armorer/tool-sources';
import { createHash } from 'node:crypto';

import { createConfigurationQueue, type ConfigurationQueue } from './configuration-queue.ts';
import { hostWriteLocks } from './locations.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { parseProviderConfiguration } from './providers.ts';
import { affectedAgents, type AffectedAgent, type AgentToolUse } from './tool-source-agents.ts';
import {
  refusingWhen,
  unmatchedToolSettings,
  withAcceptsSecrets,
} from './tool-source-tool-settings.ts';
import {
  createToolSourceVault,
  NO_SECRETS,
  ToolSourceSecretsLockedError,
  ToolSourceSecretsUnreadableError,
  type TokenStorageTurn,
  type ToolSourceSecrets,
  type ToolSourceVault,
} from './tool-source-vault.ts';
import {
  parseToolSourcesConfiguration,
  qualifyToolNames,
  readToolSourcesConfiguration,
  RESERVED_TOOL_SOURCE_IDENTIFIERS,
  serializeToolSources,
  TOOL_SOURCE_IDENTIFIER,
  type ConfiguredToolSettings,
  type ConfiguredToolSource,
} from './tool-sources-configuration.ts';

/** The route the authorization server sends a person's browser back to, for the source `sourceId`. */
export const HOST_OAUTH_CALLBACK_ROUTE = '/host/oauth/callback/:id';

/** The callback path of the source `sourceId`: `/host/oauth/callback/<id>`. */
export function oauthCallbackPath(sourceId: string): string {
  return `/host/oauth/callback/${sourceId}`;
}

/** How long one source may take to connect and list its tools at boot, and when a sign-in starts, by default. */
export const DEFAULT_LOAD_TIMEOUT_MILLISECONDS = 30_000;

/**
 * How long a probe (`ToolSourceManager.probe`) may take to connect and list a source's tools, by
 * default. It is shorter than a load at boot because a person is waiting on the dialog.
 */
export const DEFAULT_PROBE_TIMEOUT_MILLISECONDS = 10_000;

/**
 * How long a sign-in stays good after the host hands out its authorization URL: a person who has
 * not finished by then starts again, and a callback that arrives later is refused.
 */
export const SIGN_IN_TIME_TO_LIVE_MILLISECONDS = 10 * 60_000;

/** The longest credential value the host stores. Real tokens are far shorter; the limit bounds a request. */
const MAXIMUM_CREDENTIAL_LENGTH = 4096;

/** The most credentials one source may hold. */
const MAXIMUM_CREDENTIALS = 32;

/** A write the home does not allow: the reason is the one `settings.get` reports for a locked key. */
export class ToolSourceWriteLockedError extends Error {
  /** Why the write is refused. A remote home is `deployment`: the deployment, not the host, holds the files. */
  readonly reason: SettingLockReason;

  constructor(reason: SettingLockReason) {
    super(
      'This host runs on remote storage, where the tool-source configuration and credentials belong to the deployment. Change them there; the host cannot write them.',
    );
    this.name = 'ToolSourceWriteLockedError';
    this.reason = reason;
  }
}

/** A request the host cannot act on. The message names the field and never repeats its value. */
export class ToolSourceInputError extends Error {
  /** The field of the request that cannot be used. */
  readonly field: string;
  /** `unknown-source` when the request names a source the configuration does not list. */
  readonly kind: 'invalid' | 'unknown-source';

  constructor(field: string, problem: string, kind: 'invalid' | 'unknown-source' = 'invalid') {
    super(`Invalid ${field}: ${problem}`);
    this.name = 'ToolSourceInputError';
    this.field = field;
    this.kind = kind;
  }
}

/** A source added with `createOnly` under an identifier a source already holds. */
export class ToolSourceExistsError extends Error {
  constructor(sourceId: string) {
    super(`Tool source "${sourceId}" is already saved. Choose another name, or remove it first.`);
    this.name = 'ToolSourceExistsError';
  }
}

/** A local-command source asked for by a principal other than the owner. */
export class ToolSourceOwnerOnlyError extends Error {
  constructor() {
    super('Only the owner may add a source that runs a command on this machine.');
    this.name = 'ToolSourceOwnerOnlyError';
  }
}

/**
 * A change whose credentials were stored but whose configuration could not be written, and whose
 * previous credentials could not be put back (`connect`), or whose configuration was written but
 * whose credentials could not be cleared (`remove`). The message says which and names no value.
 */
export class ToolSourcePartialChangeError extends Error {
  /** The source the change was for. */
  readonly sourceId: string;
  /** What is left behind: the stored credentials are `new` and not in use, or `orphaned` after a removal. */
  readonly stage: 'credentials-not-restored' | 'credentials-not-cleared';

  constructor(sourceId: string, stage: 'credentials-not-restored' | 'credentials-not-cleared') {
    super(
      stage === 'credentials-not-restored'
        ? `The credentials of tool source "${sourceId}" were stored, but the configuration could not be written and the previous credentials could not be put back.`
        : `Tool source "${sourceId}" was removed from the configuration, but its stored credentials could not be cleared.`,
    );
    this.name = 'ToolSourcePartialChangeError';
    this.sourceId = sourceId;
    this.stage = stage;
  }
}

/** A change that was written and applied, but could not be recorded in the audit trail. The change stands. */
export class ToolSourceAuditError extends Error {
  /** The source the change was for. */
  readonly sourceId: string;

  constructor(sourceId: string) {
    super(
      `The change to tool source "${sourceId}" was applied, but could not be recorded in the audit trail.`,
    );
    this.name = 'ToolSourceAuditError';
    this.sourceId = sourceId;
  }
}

/** One record the manager writes to the audit trail. */
export type ToolSourceAuditEntry = {
  /** The synthetic resource the record is filed under, `tool-source:<id>`. */
  readonly runId: string;
  /** What happened to the source. */
  readonly type:
    | 'tool.source.connected'
    | 'tool.source.removed'
    | 'tool.source.authorized'
    | 'tool.source.tools-configured';
  /** The principal that made the change. */
  readonly principal: string;
  /** The source and the owner, and a local command's command line. Never a credential, URL or environment value. */
  readonly detail: {
    readonly sourceId: string;
    readonly kind: string;
    readonly owner: string;
    readonly commandLine?: string;
    /** For a removal: the identifiers of the agent files that named the source's tools, comma-joined. */
    readonly affectedAgents?: string;
    /** For a removal: how many agent files that is. */
    readonly affectedAgentCount?: number;
    /** For a tool-settings change: the tools that were granted `acceptsSecrets`. Names only. */
    readonly granted?: readonly string[];
    /** The tools whose `acceptsSecrets` was revoked, by a settings change or by pointing the source elsewhere. Names only. */
    readonly revoked?: readonly string[];
  };
};

/** Where a source stands. */
export type ToolSourceState =
  /** Its tools are in the catalog the host started with. */
  | 'loaded'
  /** It could not be loaded; `message` says why, in words that hold no URL or value. */
  | 'failed'
  /** An MCP OAuth source with no tokens, or whose tokens no longer work: a person must sign in. */
  | 'needs-authorization'
  /** Added or changed since the host started: it loads at the next start. */
  | 'pending-restart';

/** One tool a source offers, under the name an agent file uses. */
export type ToolSourceToolStanding = {
  /** The name an agent file lists (`<id>__<tool>`). */
  readonly name: string;
  /** The tool's own name at the source. */
  readonly tool: string;
  /** Whether the running host lets the tool receive the plaintext of a secret answer (COR-1932). */
  readonly acceptsSecrets: boolean;
  /**
   * Whether the saved settings allow it: what `acceptsSecrets` becomes at the next start. It differs
   * from `acceptsSecrets` after a change to the tool's settings that the running host has not
   * loaded (`settingsPending`), so a page reads back what it saved and not only what runs.
   */
  readonly savedAcceptsSecrets: boolean;
  /** Its capability tier (`read-only`, `mutating`, `dangerous`), or `null` when it has none. */
  readonly tier: string | null;
};

/** One source in a {@link ToolSourceSnapshot}. */
export type ToolSourceStanding = {
  /** The source's identifier. */
  readonly id: string;
  /** `mcp` or `openapi`. */
  readonly kind: ToolSourceDescription['kind'];
  /** Whether the source spawns a command on this machine. */
  readonly localCommand: boolean;
  /** Where the source stands. */
  readonly state: ToolSourceState;
  /** Why it did not load, when it did not. */
  readonly message?: string;
  /** The tools it offers, when it loaded. */
  readonly tools: readonly ToolSourceToolStanding[];
  /** The tools it offered that the host does not list, each with the reason. */
  readonly skipped: readonly { readonly tool: string; readonly reason: string }[];
  /**
   * Saved tool settings that reach no tool of a loaded source: a name the server does not list, or
   * a tool the host does not offer. Nothing is applied to a different tool.
   */
  readonly unmatchedSettings: readonly { readonly tool: string; readonly message: string }[];
  /** True when the saved tool settings differ from the ones the running host applied: they load at the next start. */
  readonly settingsPending?: true;
  /** The names of the credentials stored for it, never their values. */
  readonly credentials: readonly string[];
  /** For an OAuth source: whether tokens are stored. Stored tokens are not proof that they work: see `tokensRejected`. */
  readonly authorized?: boolean;
  /**
   * True when tokens were stored but the server refused them when the host loaded the source, so
   * a person must sign in again. A restart does not help until they do; a completed sign-in clears it.
   */
  readonly tokensRejected?: true;
};

/** The saved tool sources as the host holds them, with no credential. */
export type ToolSourceSnapshot = {
  /** The configured sources, in the order the file lists them. */
  readonly sources: readonly ToolSourceStanding[];
  /** Present when changes are refused, with the reason. */
  readonly lockReason?: SettingLockReason;
};

/** What a probe asks for. Every field is `unknown` because it arrives from a request: the manager checks it. */
export type ToolSourceProbeRequest = {
  /** The description (`armorer/tool-sources`), as {@link ToolSourceConnection.source}. */
  readonly source: unknown;
  /** Credential name to value, for every credential the description names: a probe reads none from the vault. */
  readonly credentials?: unknown;
  /** The identifier the request addresses, which the description's `id` must equal. */
  readonly id: unknown;
  /** Who is asking. A local command is spawned only for the owner. */
  readonly principal: string;
};

/** One tool a probe found, under the name an agent file would use once the source is saved. */
export type ToolSourceProbeTool = {
  /** The name an agent file lists (`<id>__<tool>`). */
  readonly name: string;
  /** The tool's own name at the source. */
  readonly tool: string;
  /** Its capability tier (`read-only`, `mutating`, `dangerous`), or `null` when it has none. */
  readonly tier: string | null;
};

/**
 * What a probe found. A source that cannot be reached is an answer, not an error: `message` says
 * why in words that hold no URL, command, header or value.
 */
export type ToolSourceProbe =
  /** The source answered and listed these tools. Nothing was saved. */
  | {
      readonly outcome: 'listed';
      readonly tools: readonly ToolSourceProbeTool[];
      readonly skipped: readonly { readonly tool: string; readonly reason: string }[];
    }
  /** The server is there and asks for a sign-in, which can only happen once the source is saved. */
  | { readonly outcome: 'needs-authorization' }
  /** The source did not answer as an MCP server or OpenAPI service should. */
  | { readonly outcome: 'failed'; readonly message: string };

/** What a connection asks for. Every field is `unknown` because it arrives from a request: the manager checks it. */
export type ToolSourceConnection = {
  /** The description (`armorer/tool-sources`): plain JSON with credentials named, never held. */
  readonly source: unknown;
  /** Credential name to value, for each credential the description names and the host does not hold. */
  readonly credentials?: unknown;
  /** The identifier the request addresses, which the description's `id` must equal. */
  readonly id: unknown;
  /** Who is asking. A local command is added only by the owner. */
  readonly principal: string;
  /**
   * Refuse with {@link ToolSourceExistsError}, changing nothing, when a source is already saved
   * under the identifier, instead of replacing it. The check is made in the source's turn, so two
   * requests for one new name cannot both succeed.
   */
  readonly createOnly?: boolean;
};

/** What a change to the per-tool settings of a source asks for. Every field is `unknown` because it arrives from a request. */
export type ToolSourceToolSettingsChange = {
  /** The identifier of a configured source. */
  readonly id: unknown;
  /**
   * Tool name (as the server lists it, not the `<id>__<tool>` name) to settings. Each named tool's
   * settings are replaced; tools not named are kept. `{ "acceptsSecrets": false }` or `{}` removes
   * the tool's entry, which is the default.
   */
  readonly tools: unknown;
};

/** What a change reports. */
export type ToolSourceChange = {
  /** The source the change was for. */
  readonly id: string;
  /** Whether the stored configuration changed. */
  readonly changed: boolean;
  /** True: the host lists the source's tools when it starts again. */
  readonly restartRequired: true;
};

/** What a removal reports: the change, and the agent files it leaves invalid at the next start. */
export type ToolSourceRemoval = ToolSourceChange & {
  /** The agent files that name the source's tools. None of them is edited. */
  readonly affectedAgents: readonly AffectedAgent[];
};

/** What removing a source would break, read without removing anything. */
export type ToolSourceRemovalPreview = {
  /** The source. */
  readonly id: string;
  /** The names of the tools the host loaded from it, which an agent file lists. */
  readonly tools: readonly string[];
  /** The agent files that name any of them, in `tools` or in `toolApproval`. */
  readonly affectedAgents: readonly AffectedAgent[];
};

/** What starting a sign-in reports. */
export type ToolSourceAuthorization =
  { readonly authorized: true } | { readonly authorized: false; readonly authorizationUrl: string };

/** The saved tool sources a running host offers and how they change. See the module comment. */
export type ToolSourceManager = {
  /** Load every configured source. Call once, before the Bureau is built. */
  start(): Promise<void>;
  /** The tools the loaded sources offer, by the name an agent file uses. Fixed once {@link start} has settled. */
  tools(): Readonly<Record<string, Tool>>;
  /** Why changes are refused, or `undefined` when they are allowed. */
  lockReason(): SettingLockReason | undefined;
  /** The configuration as it is on disk, with where each source stands. */
  snapshot(): Promise<ToolSourceSnapshot>;
  /**
   * Contact a source that is not saved, with the credentials the request carries, and report the
   * tools it lists. Writes, stores and records nothing, and holds no connection afterwards.
   */
  probe(request: ToolSourceProbeRequest): Promise<ToolSourceProbe>;
  /** Store a source's credentials and list the source in the configuration. */
  connect(request: ToolSourceConnection): Promise<ToolSourceChange>;
  /** Set the per-tool settings (`acceptsSecrets`) of a configured source. Loaded at the next start. */
  configureTools(request: ToolSourceToolSettingsChange): Promise<ToolSourceChange>;
  /** Remove a source from the configuration and clear its credentials. No agent file is changed. */
  remove(request: { readonly id: unknown; readonly principal: string }): Promise<ToolSourceRemoval>;
  /** The agent files a removal of the source would leave invalid. Changes nothing, and works on a remote home. */
  affectedAgents(id: unknown): Promise<ToolSourceRemovalPreview>;
  /** Start an MCP OAuth sign-in for a configured source. */
  authorize(id: unknown): Promise<ToolSourceAuthorization>;
  /** Finish a sign-in from the URL the browser came back to. */
  completeAuthorization(id: unknown, callbackUrl: string): Promise<ToolSourceChange>;
  /** Refuse every later change and close every connection the sources hold. The host calls it as it shuts down. */
  close(): Promise<void>;
};

/** What {@link createToolSourceManager} reads. */
export type ToolSourceManagerOptions = {
  /** The open home. Its mode decides whether a write is allowed. */
  readonly bungalow: Pick<
    Bungalow,
    | 'mode'
    | 'configurationLocation'
    | 'readConfiguration'
    | 'writeConfiguration'
    | 'readSecret'
    | 'writeSecret'
  >;
  /** The installation's answer keys, which seal the credentials. */
  readonly keys: AnswerEncryptionKeys;
  /** The queue every writer of `configuration.json` shares. Defaults to a new one. */
  readonly configurationQueue?: ConfigurationQueue;
  /** Appends one record to the audit trail; resolves without writing when the Bureau keeps none. */
  readonly audit: (entry: ToolSourceAuditEntry) => Promise<void>;
  /**
   * The origin the host is reachable at, such as `http://127.0.0.1:7234`. A sign-in's redirect URL
   * is built from it. It is read when a sign-in starts or completes; at boot it only fills the
   * redirect URL of a source that already holds tokens, which starts no sign-in.
   */
  readonly origin: () => string;
  /**
   * The tool names every agent file mentions (`tool-source-agents.ts`), read when a removal is
   * previewed or made. Defaults to no agent files.
   */
  readonly agentToolUse?: () => Promise<readonly AgentToolUse[]>;
  /** The owner a change is made by. Defaults to the local owner, the one principal of a single-user host. */
  readonly owner?: string;
  /** Receives one line per source that did not load. It names the source and the kind of failure, never a URL or a value. */
  readonly warn?: (message: string) => void;
  /** Replaces the global `fetch` the loader uses, for a test. */
  readonly fetch?: typeof fetch;
  /** How long one source may take to load. Defaults to {@link DEFAULT_LOAD_TIMEOUT_MILLISECONDS}. */
  readonly loadTimeoutMilliseconds?: number;
  /** How long a probe may take. Defaults to {@link DEFAULT_PROBE_TIMEOUT_MILLISECONDS}. */
  readonly probeTimeoutMilliseconds?: number;
  /** The clock a sign-in's age is read from. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Runs `expire` after `milliseconds` and returns the function that cancels it: the deadline of a
   * load and of a token exchange. Defaults to `setTimeout`; a test supplies its own to expire one
   * at a moment it chooses.
   */
  readonly schedule?: (expire: () => void, milliseconds: number) => () => void;
};

/** A source that did not answer in time. */
class LoadTimeoutError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the source spawns a process on this machine. */
export function isLocalCommand(source: ToolSourceDescription): boolean {
  return source.kind === 'mcp' && source.transport.type === 'stdio';
}

function isOAuth(source: ToolSourceDescription): boolean {
  return (
    source.kind === 'mcp' &&
    source.transport.type === 'http' &&
    source.transport.authentication?.type === 'oauth'
  );
}

/** The names of the credentials a description asks the host for. */
export function referencedCredentials(source: ToolSourceDescription): string[] {
  if (source.kind === 'mcp') {
    if (source.transport.type === 'stdio') {
      return [...new Set(Object.values(source.transport.credentialEnv ?? {}))];
    }
    const authentication = source.transport.authentication;
    return authentication?.type === 'bearer' ? [authentication.credential] : [];
  }
  return source.authentication === undefined ? [] : [source.authentication.credential];
}

/** A command line for the audit trail: the executable and its arguments, quoted where they hold a space or a quote. */
function commandLineOf(source: ToolSourceDescription): string | undefined {
  if (source.kind !== 'mcp' || source.transport.type !== 'stdio') return undefined;
  const quote = (part: string): string =>
    /[\s"'\\]/.test(part) || part === '' ? JSON.stringify(part) : part;
  return [source.transport.command, ...(source.transport.args ?? [])].map(quote).join(' ');
}

/** The URL fields of a description, refused before Armorer reads it when they are not http(s) without userinfo. */
function checkUrls(raw: unknown): void {
  if (!isPlainObject(raw)) return;
  const transport = raw['transport'];
  const specification = raw['specification'];
  const candidates: [string, unknown][] = [
    ['source.baseUrl', raw['baseUrl']],
    ['source.transport.url', isPlainObject(transport) ? transport['url'] : undefined],
    ['source.specification.url', isPlainObject(specification) ? specification['url'] : undefined],
  ];
  for (const [field, value] of candidates) {
    if (value === undefined) continue;
    let url: URL | undefined;
    try {
      url = typeof value === 'string' ? new URL(value) : undefined;
    } catch {
      url = undefined;
    }
    if (
      url === undefined ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new ToolSourceInputError(
        field,
        'expected an http or https URL without a username or password.',
      );
    }
  }
}

function checkedCredentials(raw: unknown, allowed: readonly string[]): Map<string, string> {
  const supplied = new Map<string, string>();
  if (raw === undefined) return supplied;
  if (!isPlainObject(raw)) {
    throw new ToolSourceInputError(
      'credentials',
      'expected an object of credential names to values.',
    );
  }
  const entries = Object.entries(raw);
  if (entries.length > MAXIMUM_CREDENTIALS) {
    throw new ToolSourceInputError('credentials', `more than ${MAXIMUM_CREDENTIALS} credentials.`);
  }
  for (const [name, value] of entries) {
    const field = `credentials.${name.slice(0, 64)}`;
    if (!allowed.includes(name)) {
      throw new ToolSourceInputError(
        field,
        'the source description does not name this credential.',
      );
    }
    if (typeof value !== 'string') throw new ToolSourceInputError(field, 'expected text.');
    const trimmed = value.trim();
    if (trimmed === '') throw new ToolSourceInputError(field, 'expected a value, and it is empty.');
    if (trimmed.length > MAXIMUM_CREDENTIAL_LENGTH) {
      throw new ToolSourceInputError(field, `longer than ${MAXIMUM_CREDENTIAL_LENGTH} characters.`);
    }
    // eslint-disable-next-line no-control-regex -- a control character is what this refuses.
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new ToolSourceInputError(field, 'contains a line break or another control character.');
    }
    supplied.set(name, trimmed);
  }
  return supplied;
}

/** A deep copy of a request's JSON, or the refusal for a value that is not plain JSON. */
function copyOfJson(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new ToolSourceInputError('source', 'expected plain JSON.');
  }
}

function checkedIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOOL_SOURCE_IDENTIFIER.test(value)) {
    throw new ToolSourceInputError(
      field,
      'expected 1 to 20 lowercase letters, digits or hyphens, starting with a letter.',
    );
  }
  return value;
}

/** The sentence a failed load is reported with: what kind of failure, never the URL or value in the error. */
function describeFailure(error: unknown): string {
  if (error instanceof LoadTimeoutError) return 'The source did not answer in time.';
  if (error instanceof ToolSourceCredentialError) return error.message;
  if (error instanceof ToolSourceBaseUrlError) return error.message;
  if (error instanceof ToolSourceSecretsUnreadableError) return error.message;
  // A remote home cannot save the tokens a refresh returns.
  if (error instanceof ToolSourceSecretsLockedError) return error.message;
  if (error instanceof ToolSourceDescriptionError) return error.message;
  return 'The source could not be reached, or did not answer as an MCP server or OpenAPI service should.';
}

/** Close a source that arrived after its deadline, so a late connection does not outlive the host's decision. */
async function closeLate(work: Promise<LoadedToolSource>): Promise<void> {
  try {
    const loaded = await work;
    await loaded.close();
  } catch {
    // It failed to load, or to close: either way there is nothing left to close.
  }
}

/** A digest of a description, to tell whether the source a sign-in began for is the one that stands. */
function revisionOf(source: ToolSourceDescription): string {
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

/**
 * What the saved per-tool settings come to, to tell whether the running host applied them: the
 * tools flagged `acceptsSecrets`, by name. A tool with no entry, an empty entry, or `false` is the
 * same default.
 */
function settingsRevision(entry: ConfiguredToolSource): string {
  return JSON.stringify(acceptingTools(entry.tools));
}

/** The names of the tools flagged `acceptsSecrets`, sorted. */
function acceptingTools(tools: ReadonlyMap<string, ConfiguredToolSettings>): string[] {
  return [...tools]
    .filter(([, settings]) => settings.acceptsSecrets === true)
    .map(([name]) => name)
    .sort();
}

/**
 * The settings a request names, copied and checked before the first `await` (the caller owns the
 * original). An entry for a name the server does not list is accepted: the source reports it.
 */
function checkedToolSettings(value: unknown): Map<string, ConfiguredToolSettings> {
  const copy = copyOfJson(value);
  if (!isPlainObject(copy)) throw new ToolSourceInputError('tools', 'expected an object.');
  const settings = new Map<string, ConfiguredToolSettings>();
  for (const [name, entry] of Object.entries(copy)) {
    if (name === '') throw new ToolSourceInputError('tools', 'a tool name cannot be empty.');
    if (!isPlainObject(entry)) {
      throw new ToolSourceInputError(`tools.${name}`, 'expected an object.');
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'acceptsSecrets') {
        throw new ToolSourceInputError(`tools.${name}.${key}`, 'not a known field.');
      }
    }
    const accepts = entry['acceptsSecrets'];
    if (accepts !== undefined && typeof accepts !== 'boolean') {
      throw new ToolSourceInputError(`tools.${name}.acceptsSecrets`, 'expected true or false.');
    }
    settings.set(name, accepts === undefined ? {} : { acceptsSecrets: accepts });
  }
  return settings;
}

/** A record's entries ordered by key, so two records that differ only in key order compare equal. */
function sortedEntries(record: Readonly<Record<string, string>> | undefined): [string, string][] {
  return Object.entries(record ?? {}).sort(([left], [right]) => (left < right ? -1 : 1));
}

/**
 * Where a source's credentials are sent: its kind, and the address or command they reach. A change
 * to any of it is a change of recipient, so the credentials held for the old one are not carried
 * over. Changing anything else (an operation filter, a scope, a header name) keeps them.
 */
function recipientOf(source: ToolSourceDescription): string {
  if (source.kind === 'mcp') {
    const { transport } = source;
    return JSON.stringify(
      transport.type === 'stdio'
        ? [
            'mcp',
            'stdio',
            transport.command,
            transport.args ?? [],
            transport.cwd ?? null,
            // The environment is part of where a command sends what it is given (a token goes to
            // whichever host `GITHUB_HOST` names), so it is compared with its keys in order.
            sortedEntries(transport.env),
            sortedEntries(transport.credentialEnv),
          ]
        : ['mcp', 'http', transport.url],
    );
  }
  const { specification } = source;
  return JSON.stringify([
    'openapi',
    source.baseUrl ?? null,
    // An inline document names its servers itself; one fetched from a URL is wherever the URL says.
    specification.type === 'url' ? specification.url : (specification.document.servers ?? null),
  ]);
}

/**
 * The identifier and description of a request to connect or probe a source, checked before the
 * first `await` (the caller owns the request) and before anything is contacted or written. A
 * source that runs a command on this machine is refused to everyone but `owner`.
 */
function checkedDescription(
  request: { readonly id: unknown; readonly source: unknown; readonly principal: string },
  owner: string,
): { readonly id: string; readonly source: ToolSourceDescription } {
  const id = checkedIdentifier(request.id, 'id');
  // Only a new source is refused the name: one stored before the name was reserved must stay removable.
  if (RESERVED_TOOL_SOURCE_IDENTIFIERS.includes(id)) {
    throw new ToolSourceInputError('id', `"${id}" is reserved for the host's own tools.`);
  }
  checkUrls(request.source);
  let source: ToolSourceDescription;
  try {
    // A copy, because the description's document is read after the first `await` and the caller owns the original.
    source = parseToolSourceDescription(copyOfJson(request.source));
  } catch (error) {
    if (error instanceof ToolSourceDescriptionError) {
      throw new ToolSourceInputError('source', error.message);
    }
    throw error;
  }
  if (source.id !== id) {
    throw new ToolSourceInputError('source.id', 'expected the identifier the request addresses.');
  }
  if (isLocalCommand(source) && request.principal !== owner) {
    throw new ToolSourceOwnerOnlyError();
  }
  return { id, source };
}

/** OAuth state that lives only as long as a probe: nothing it learns is kept. */
function probeTokenStorage(): McpOAuthTokenStorage {
  let state: Awaited<ReturnType<McpOAuthTokenStorage['load']>> = {};
  return {
    load: () => ({ ...state }),
    save: (patch) => {
      state = { ...state, ...patch };
    },
    clear: (keys) => {
      const next = { ...state };
      for (const key of keys) delete next[key];
      state = next;
    },
  };
}

/** Create the manager. It loads nothing until {@link ToolSourceManager.start}. */
export function createToolSourceManager(options: ToolSourceManagerOptions): ToolSourceManager {
  const { bungalow } = options;
  const location = bungalow.configurationLocation;
  const owner = options.owner ?? ANONYMOUS_LOCAL_OWNER;
  const configurationQueue = options.configurationQueue ?? createConfigurationQueue();
  const vault: ToolSourceVault = createToolSourceVault({ bungalow, keys: options.keys });
  const timeout = options.loadTimeoutMilliseconds ?? DEFAULT_LOAD_TIMEOUT_MILLISECONDS;
  const probeTimeout = options.probeTimeoutMilliseconds ?? DEFAULT_PROBE_TIMEOUT_MILLISECONDS;
  const warn = options.warn ?? (() => undefined);
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((expire: () => void, milliseconds: number) => {
      // poll-reason: timer
      const timer = setTimeout(expire, milliseconds);
      return () => clearTimeout(timer);
    });
  const fetchOption = options.fetch === undefined ? {} : { fetch: options.fetch };
  let closed = false;
  /** The loads that have not settled, which closing the host abandons. */
  const loading = new Set<AbortController>();

  /** What the last start made of each source: its standing, and the description it loaded. */
  const booted = new Map<
    string,
    { standing: ToolSourceStanding; description: string; settings: string }
  >();
  const loadedSources: LoadedToolSource[] = [];
  /** The connection each source loaded at boot holds, so a removal can close it. */
  const loadedById = new Map<string, LoadedToolSource>();
  const catalog: Record<string, Tool> = {};
  /**
   * The sources whose loaded incarnation was removed, or replaced by one that goes somewhere
   * else, since the host started. Their tools stay in the catalog until a restart, but every one
   * refuses to run ({@link refusingWhen}, applied where the tools are built), so none can reach
   * its server or use a credential the loader captured at load: not an OpenAPI key or token read
   * once, a local command's environment, or an open MCP session. They are also denied the
   * credentials and sign-in the source now holds, which belong to the new address.
   */
  const retired = new Set<string>();

  const lockReason = (): SettingLockReason | undefined => hostWriteLocks(bungalow).configuration;
  const assertWritable = (): void => {
    const reason = lockReason();
    if (reason !== undefined) throw new ToolSourceWriteLockedError(reason);
  };
  const serialized = <Result>(work: () => Promise<Result>): Promise<Result> =>
    configurationQueue.run(() => {
      if (closed) throw new Error('The host is shutting down.');
      return work();
    });

  async function readText(): Promise<string | undefined> {
    try {
      return await bungalow.readConfiguration();
    } catch {
      throw new ProviderConfigurationError(location, 'the file', 'it could not be read.');
    }
  }

  /** The configuration as an object whose other keys a write keeps, and the sources it lists. */
  async function readDocument(): Promise<{
    text: string | undefined;
    document: Record<string, unknown>;
    sources: readonly ConfiguredToolSource[];
  }> {
    const text = await readText();
    // Parsed first as the host reads it, so a file that is already invalid is refused, not overwritten.
    if (text !== undefined) parseProviderConfiguration(text, location);
    const sources = readToolSourcesConfiguration(text, location);
    const parsed: unknown = text === undefined ? {} : JSON.parse(text);
    return { text, document: isPlainObject(parsed) ? parsed : {}, sources };
  }

  const resolveCredential = async ({
    sourceId,
    credential,
  }: {
    sourceId: string;
    credential: string;
  }): Promise<string | undefined> => {
    const secrets = await vault.read(sourceId);
    return secrets.credentials.get(credential);
  };

  /** The credentials of a source loaded at boot: none once that incarnation is {@link retired}. */
  const resolveForLoaded =
    (loaded: ToolSourceDescription): typeof resolveCredential =>
    async (request) => {
      if (retired.has(request.sourceId)) return undefined;
      // A file edited by hand can drop the source and add one of the same id elsewhere: the tools
      // loaded under the old description are not given the new source's credentials.
      const { sources } = await readDocument();
      const current = sources.find((entry) => entry.source.id === request.sourceId);
      if (current === undefined || recipientOf(current.source) !== recipientOf(loaded)) {
        return undefined;
      }
      return resolveCredential(request);
    };

  /** A source's sign-in state for a load at boot: empty and read-only once that incarnation is {@link retired}. */
  function storageForLoaded(sourceId: string): McpOAuthTokenStorage {
    const storage = vault.tokenStorage(sourceId);
    return {
      load: () => (retired.has(sourceId) ? Promise.resolve({}) : storage.load()),
      save: (patch) => (retired.has(sourceId) ? undefined : storage.save(patch)),
      clear: (names) => (retired.has(sourceId) ? undefined : storage.clear?.(names)),
    };
  }

  /** The OAuth pieces for a load or a completion: storage in the vault, and the callback on this host's origin. */
  function oauthOptions(
    onAuthorizationRequired: ToolSourceOAuthOptions['onAuthorizationRequired'],
    turn: TokenStorageTurn = 'take',
    storage: (sourceId: string) => McpOAuthTokenStorage = (sourceId) =>
      vault.tokenStorage(sourceId, turn),
  ): ToolSourceOAuthOptions {
    return {
      tokenStorage: storage,
      redirectUrl: (sourceId) => `${options.origin()}${oauthCallbackPath(sourceId)}`,
      onAuthorizationRequired,
    };
  }

  function standingOf(
    entry: ConfiguredToolSource,
    state: ToolSourceState,
    extra: Partial<
      Pick<
        ToolSourceStanding,
        'message' | 'tools' | 'skipped' | 'unmatchedSettings' | 'tokensRejected'
      >
    > = {},
  ): ToolSourceStanding {
    return {
      id: entry.source.id,
      kind: entry.source.kind,
      localCommand: isLocalCommand(entry.source),
      state,
      tools: [],
      skipped: [],
      unmatchedSettings: [],
      credentials: [],
      ...extra,
    };
  }

  /**
   * Load a source, or reject with a {@link LoadTimeoutError} after the load timeout. At the
   * deadline the load is aborted, which stops the child process or connection it opened rather
   * than leaving it to the SDK's own, much longer, timeout; a source that arrives late is closed.
   * Closing the host aborts it too.
   */
  async function within(
    start: (signal: AbortSignal) => Promise<LoadedToolSource>,
    milliseconds: number = timeout,
  ): Promise<LoadedToolSource> {
    const controller = new AbortController();
    loading.add(controller);
    const work = start(controller.signal);
    let timedOut = false;
    let cancel = (): void => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      cancel = schedule(() => {
        timedOut = true;
        reject(new LoadTimeoutError());
        controller.abort();
      }, milliseconds);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      cancel();
      loading.delete(controller);
      if (timedOut || controller.signal.aborted) void closeLate(work);
    }
  }

  /** Load one source at boot. Never throws: a failure is the source's own standing. */
  async function loadOne(entry: ConfiguredToolSource): Promise<void> {
    const { source } = entry;
    const description = JSON.stringify(source);
    const settings = settingsRevision(entry);
    const remember = (standing: ToolSourceStanding): void => {
      booted.set(source.id, { standing, description, settings });
    };
    // Whether tokens were stored when the load began, so a refusal of them is told from no sign-in.
    let hadTokens = false;
    // A saved source must not stop the host: its tools would collide with a built-in plugin's namespace.
    if (RESERVED_TOOL_SOURCE_IDENTIFIERS.includes(source.id)) {
      const message = `The identifier "${source.id}" is reserved for the host's own tools, so this source is not loaded. Remove it.`;
      warn(`Tool source "${source.id}" did not load: ${message}`);
      remember(standingOf(entry, 'failed', { message }));
      return;
    }
    try {
      if (isOAuth(source)) {
        const secrets = await vault.read(source.id);
        // No tokens: starting would register a client and begin a sign-in nobody is waiting for.
        if (secrets.oauth?.tokens === undefined) {
          remember(standingOf(entry, 'needs-authorization'));
          return;
        }
        hadTokens = true;
      }
      // A sign-in is never started here: the URL the loader hands over is dropped, and the
      // source reports `needs-authorization` for a person to start it.
      const loaded = await within((signal) =>
        loadToolSource(source, {
          resolveCredential: resolveForLoaded(source),
          oauth: oauthOptions(() => undefined, 'take', storageForLoaded),
          signal,
          ...fetchOption,
        }),
      );
      if (closed) {
        await loaded.close().catch(() => undefined);
        return;
      }
      loadedSources.push(loaded);
      loadedById.set(source.id, loaded);
      const tools: ToolSourceToolStanding[] = [];
      const skipped: { tool: string; reason: string }[] = [];
      // The names are settled for the whole listing before any is taken, so the order the
      // server lists its tools in never decides which tool a stored name means.
      const names = qualifyToolNames(
        source.id,
        loaded.tools.map((tool) => tool.name),
      );
      skipped.push(...names.skipped);
      const byName = new Map(names.named.map(({ tool, name }) => [tool, name]));
      for (const tool of loaded.tools) {
        const name = byName.get(tool.name);
        if (name === undefined) continue;
        // Only a tool the owner flagged gets `acceptsSecrets`; every other keeps the metadata the loader gave it.
        const acceptsSecrets = entry.tools.get(tool.name)?.acceptsSecrets === true;
        // Every saved source's tool is rebuilt behind this gate, so a retired source's tool cannot
        // run. The rebuild copies the configuration whole, so the loader's version survives it.
        const offered = acceptsSecrets ? withAcceptsSecrets(tool) : tool;
        catalog[name] = refusingWhen(offered, () =>
          retired.has(source.id)
            ? `Tool source "${source.id}" was removed or changed, so this tool no longer runs. Start the host again: a changed source then loads as it now stands, and a removed one is gone.`
            : undefined,
        );
        tools.push({
          name,
          tool: tool.name,
          acceptsSecrets,
          savedAcceptsSecrets: acceptsSecrets,
          tier: resolveCapabilityTier(tool.metadata, tool.tags) ?? null,
        });
      }
      const unmatchedSettings = unmatchedToolSettings(
        entry.tools,
        loaded.tools.map((tool) => tool.name),
        skipped,
      );
      for (const { tool, message } of unmatchedSettings) {
        warn(
          `Tool source "${source.id}" has a setting for "${tool}" that reaches no tool: ${message}`,
        );
      }
      remember(standingOf(entry, 'loaded', { tools, skipped, unmatchedSettings }));
    } catch (error) {
      if (error instanceof ToolSourceAuthorizationRequiredError) {
        remember(
          standingOf(entry, 'needs-authorization', hadTokens ? { tokensRejected: true } : {}),
        );
        return;
      }
      const message = describeFailure(error);
      warn(`Tool source "${source.id}" did not load: ${message}`);
      remember(standingOf(entry, 'failed', { message }));
    }
  }

  async function standingWithSecrets(
    entry: ConfiguredToolSource,
    standing: ToolSourceStanding,
  ): Promise<ToolSourceStanding> {
    let credentials: readonly string[] = [];
    let authorized: boolean | undefined;
    try {
      credentials = vault.credentialNames(entry.source.id);
      if (isOAuth(entry.source)) {
        const secrets = await vault.read(entry.source.id);
        authorized = secrets.oauth?.tokens !== undefined;
      }
    } catch {
      // Unreadable credentials are reported by the load, not by the listing.
    }
    return { ...standing, credentials, ...(authorized === undefined ? {} : { authorized }) };
  }

  /** The tool names the host loaded from the source `id`: the ones an agent file lists. */
  function loadedToolNames(id: string): string[] {
    return (booted.get(id)?.standing.tools ?? []).map((tool) => tool.name);
  }

  /**
   * The agent files that name a tool of the source `id`: one the host loaded from it, or any name
   * that starts with `<id>__`, which belongs to this source alone (`tool-sources-configuration.ts`).
   * A source that failed, awaits a sign-in, or was added since the host started loaded nothing,
   * but an agent file may name its tools all the same.
   */
  async function agentsUsing(id: string): Promise<AffectedAgent[]> {
    if (options.agentToolUse === undefined) return [];
    const loaded = new Set(loadedToolNames(id));
    const prefix = `${id}__`;
    return affectedAgents(
      await options.agentToolUse(),
      (name) => loaded.has(name) || name.startsWith(prefix),
    );
  }

  /** The source `id` as the file lists it, or the refusal for one it does not. */
  async function configured(id: string): Promise<ConfiguredToolSource> {
    const { sources } = await readDocument();
    const entry = sources.find((candidate) => candidate.source.id === id);
    if (entry === undefined) {
      throw new ToolSourceInputError('source', 'not a configured source.', 'unknown-source');
    }
    return entry;
  }

  async function record(
    type: ToolSourceAuditEntry['type'],
    source: ToolSourceDescription,
    access: { readonly granted?: readonly string[]; readonly revoked?: readonly string[] } = {},
    affected?: readonly AffectedAgent[],
  ): Promise<void> {
    const commandLine = commandLineOf(source);
    try {
      await options.audit({
        runId: auditTrailToolSourceOwnerId(source.id),
        type,
        principal: owner,
        detail: {
          sourceId: source.id,
          kind: source.kind,
          owner,
          ...(commandLine === undefined ? {} : { commandLine }),
          ...(affected === undefined
            ? {}
            : {
                affectedAgents: affected.map((agent) => agent.id).join(','),
                affectedAgentCount: affected.length,
              }),
          // Tool names only: never an argument, a reference, or a value.
          ...(access.granted === undefined || access.granted.length === 0
            ? {}
            : { granted: access.granted }),
          ...(access.revoked === undefined || access.revoked.length === 0
            ? {}
            : { revoked: access.revoked }),
        },
      });
    } catch {
      throw new ToolSourceAuditError(source.id);
    }
  }

  /**
   * Whether the source `id` is still listed with the description `revision` names. Asked under
   * the source's turn, where every change to the source's secret and configuration also takes its
   * turn, so the answer holds for the write that follows it.
   */
  async function isCurrent(id: string, revision: string): Promise<boolean> {
    try {
      const entry = await configured(id);
      return revisionOf(entry.source) === revision;
    } catch {
      return false;
    }
  }

  /**
   * Refuse a sign-in whose source was removed or replaced while it ran. The sign-in's OAuth
   * storage is fenced ({@link isCurrent}), so it stored nothing and erased nothing of whatever
   * holds the id now; this only tells the caller.
   */
  async function assertCurrent(id: string, revision: string): Promise<void> {
    const current = await configured(id);
    if (revisionOf(current.source) !== revision) {
      throw new ToolSourceInputError('source', 'changed while the sign-in was starting.');
    }
  }

  /** Write `text` as the configuration, and say whether the file holds it afterwards. */
  async function writeConfiguration(text: string): Promise<boolean> {
    try {
      bungalow.writeConfiguration(text);
      return true;
    } catch {
      // Bungalow renames the file and then syncs the directory, so a throw may follow a write
      // that took. Read the disk back instead of assuming.
      try {
        return (await bungalow.readConfiguration()) === text;
      } catch {
        return false;
      }
    }
  }

  const startedSources = (): readonly LoadedToolSource[] => loadedSources;

  return {
    tools: () => catalog,
    lockReason,
    async start() {
      const { sources } = await readDocument();
      await Promise.all(sources.map((entry) => loadOne(entry)));
    },
    async snapshot() {
      const { sources } = await readDocument();
      const standings = await Promise.all(
        sources.map((entry) => {
          const previous = booted.get(entry.source.id);
          if (previous === undefined || previous.description !== JSON.stringify(entry.source)) {
            return standingWithSecrets(entry, standingOf(entry, 'pending-restart'));
          }
          const { standing } = previous;
          // Judged against the saved settings as they are now, and the tools the source listed when it loaded.
          const unmatchedSettings =
            standing.state === 'loaded'
              ? unmatchedToolSettings(
                  entry.tools,
                  [
                    ...standing.tools.map(({ tool }) => tool),
                    ...standing.skipped.map(({ tool }) => tool),
                  ],
                  standing.skipped,
                )
              : [];
          return standingWithSecrets(entry, {
            ...standing,
            // The saved settings as they are now, not as they were when the host loaded the source.
            tools: standing.tools.map((tool) => ({
              ...tool,
              savedAcceptsSecrets: entry.tools.get(tool.tool)?.acceptsSecrets === true,
            })),
            unmatchedSettings,
            ...(previous.settings === settingsRevision(entry)
              ? {}
              : { settingsPending: true as const }),
          });
        }),
      );
      const reason = lockReason();
      return { sources: standings, ...(reason === undefined ? {} : { lockReason: reason }) };
    },
    // The request is checked, as `connect` checks it, before anything is contacted. Nothing is
    // stored, written to the configuration, put in the audit trail, or taken from the vault: the
    // credentials live in this call, and a source that answers is closed before it returns.
    async probe(request) {
      assertWritable();
      const { id, source } = checkedDescription(request, owner);
      const supplied = checkedCredentials(request.credentials, referencedCredentials(source));
      for (const name of referencedCredentials(source)) {
        if (!supplied.has(name)) {
          throw new ToolSourceInputError(`credentials.${name}`, 'a value is required.');
        }
      }
      if (closed) throw new Error('The host is shutting down.');
      // One storage for the whole probe: the loader asks for it more than once.
      const storage = probeTokenStorage();
      let loaded: LoadedToolSource;
      try {
        loaded = await within(
          (signal) =>
            loadToolSource(source, {
              resolveCredential: ({ credential }) => supplied.get(credential),
              oauth: oauthOptions(
                () => undefined,
                'take',
                () => storage,
              ),
              signal,
              ...fetchOption,
            }),
          probeTimeout,
        );
      } catch (error) {
        if (error instanceof ToolSourceAuthorizationRequiredError) {
          return { outcome: 'needs-authorization' as const };
        }
        // Nothing from the failure is repeated: it may hold the address, the command, or a value.
        return { outcome: 'failed' as const, message: describeFailure(error) };
      }
      try {
        const names = qualifyToolNames(
          id,
          loaded.tools.map((tool) => tool.name),
        );
        const byName = new Map(names.named.map(({ tool, name }) => [tool, name]));
        const tools: ToolSourceProbeTool[] = [];
        for (const tool of loaded.tools) {
          const name = byName.get(tool.name);
          if (name === undefined) continue;
          tools.push({
            name,
            tool: tool.name,
            tier: resolveCapabilityTier(tool.metadata, tool.tags) ?? null,
          });
        }
        return { outcome: 'listed' as const, tools, skipped: names.skipped };
      } finally {
        await loaded.close().catch(() => undefined);
      }
    },
    // The request is read, checked, and copied before the first `await`: the caller owns it, and
    // may change it while this waits its turn.
    async connect(request) {
      assertWritable();
      const { id, source } = checkedDescription(request, owner);
      const referenced = referencedCredentials(source);
      const supplied = checkedCredentials(request.credentials, referenced);
      return serialized(() =>
        vault.exclusive(id, async () => {
          const { text: currentText, document, sources } = await readDocument();
          const existing = sources.find((entry) => entry.source.id === id);
          if (request.createOnly === true && existing !== undefined) {
            throw new ToolSourceExistsError(id);
          }
          // What is held is carried over only for the same source going to the same place. A new
          // source starts with nothing, whatever an earlier source of the same id left in its
          // secret, and a source that now points elsewhere does not send the old credentials there.
          const sameRecipient =
            existing !== undefined && recipientOf(existing.source) === recipientOf(source);
          let previous: ToolSourceSecrets = NO_SECRETS;
          let unreadable = false;
          if (sameRecipient) {
            try {
              previous = await vault.read(id);
            } catch (error) {
              // Credentials that cannot be read are replaced, so every one must be supplied again.
              if (!(error instanceof ToolSourceSecretsUnreadableError)) throw error;
              unreadable = true;
            }
          }
          const credentials = new Map<string, string>();
          for (const name of referenced) {
            const value = supplied.get(name) ?? previous.credentials.get(name);
            if (value === undefined) {
              throw new ToolSourceInputError(
                `credentials.${name}`,
                existing !== undefined && !sameRecipient
                  ? 'a value is required, because the source now goes somewhere else.'
                  : 'a value is required.',
              );
            }
            credentials.set(name, value);
          }
          // Sign-in state belongs to the server it was made with: keep it only for the same OAuth server.
          const keepsSignIn =
            existing !== undefined &&
            isOAuth(existing.source) &&
            isOAuth(source) &&
            JSON.stringify(existing.source) === JSON.stringify(source);
          // Per-tool settings, `acceptsSecrets` among them, were granted for the server the source
          // went to: they are kept only while it still goes to the same place, like credentials.
          const tools = sameRecipient && existing !== undefined ? existing.tools : new Map();
          const next: ConfiguredToolSource = { source, tools };
          const revoked =
            existing === undefined || sameRecipient ? [] : acceptingTools(existing.tools);
          const nextSources =
            existing === undefined
              ? [...sources, next]
              : sources.map((entry) => (entry === existing ? next : entry));
          const nextDocument = { ...document, toolSources: serializeToolSources(nextSources) };
          const text = `${JSON.stringify(nextDocument, null, 2)}\n`;
          // The same checks the next start applies, before a byte is written.
          parseProviderConfiguration(text, location);
          parseToolSourcesConfiguration(nextDocument.toolSources, location);
          const unchanged =
            existing !== undefined &&
            JSON.stringify(existing.source) === JSON.stringify(source) &&
            supplied.size === 0 &&
            // A secret that cannot be read is replaced by this request, even one that names no credential.
            !unreadable;
          if (unchanged) return { id, changed: false, restartRequired: true as const };

          // A new source has no previous text to put back: writing it replaces any orphan, and a
          // failed change leaves the orphan cleared rather than restored.
          const previousText = existing === undefined ? undefined : vault.stored(id);
          // A write that throws may still have replaced the secret, so both steps put the previous
          // text back (an empty value reads as no secret) when the change does not complete.
          // The loaded incarnation stops being given credentials before the new ones are stored,
          // since it is still connected to the old address; a change that does not complete
          // puts the previous ones back and lifts the fence with them.
          const fences = existing !== undefined && !sameRecipient && !retired.has(id);
          if (fences) retired.add(id);
          const putPreviousBack = (): void => {
            try {
              vault.restore(id, previousText);
            } catch {
              throw new ToolSourcePartialChangeError(id, 'credentials-not-restored');
            }
            if (fences) retired.delete(id);
          };
          try {
            await vault.write(id, {
              credentials,
              oauth: keepsSignIn ? previous.oauth : undefined,
              signIn: keepsSignIn ? previous.signIn : undefined,
            });
          } catch (error) {
            putPreviousBack();
            throw error;
          }
          // A rotation of credentials alone leaves the file as it is: nothing to write or repair.
          if (text !== currentText && !(await writeConfiguration(text))) {
            // The configuration is not the one meant: the file still describes the previous credentials.
            putPreviousBack();
            throw new Error('The tool-source configuration could not be written.');
          }
          await record('tool.source.connected', source, { revoked });
          return { id, changed: true, restartRequired: true as const };
        }),
      );
    },
    async configureTools(request) {
      assertWritable();
      const id = checkedIdentifier(request.id, 'id');
      const incoming = checkedToolSettings(request.tools);
      return serialized(async () => {
        const { text: currentText, document, sources } = await readDocument();
        const existing = sources.find((entry) => entry.source.id === id);
        if (existing === undefined) {
          throw new ToolSourceInputError('source', 'not a configured source.', 'unknown-source');
        }
        const tools = new Map(existing.tools);
        for (const [name, settings] of incoming) {
          // The default is no entry at all, so a tool turned back off leaves nothing behind.
          if (settings.acceptsSecrets === true) tools.set(name, settings);
          else tools.delete(name);
        }
        const next: ConfiguredToolSource = { source: existing.source, tools };
        const nextSources = sources.map((entry) => (entry === existing ? next : entry));
        const nextDocument = { ...document, toolSources: serializeToolSources(nextSources) };
        const text = `${JSON.stringify(nextDocument, null, 2)}\n`;
        // The same checks the next start applies, before a byte is written.
        parseProviderConfiguration(text, location);
        parseToolSourcesConfiguration(nextDocument.toolSources, location);
        if (text === currentText) return { id, changed: false, restartRequired: true as const };
        if (!(await writeConfiguration(text))) {
          throw new Error('The tool-source configuration could not be written.');
        }
        const before = new Set(acceptingTools(existing.tools));
        const after = new Set(acceptingTools(tools));
        await record('tool.source.tools-configured', existing.source, {
          granted: [...after].filter((name) => !before.has(name)).sort(),
          revoked: [...before].filter((name) => !after.has(name)).sort(),
        });
        return { id, changed: true, restartRequired: true as const };
      });
    },
    async remove(request) {
      assertWritable();
      const id = checkedIdentifier(request.id, 'id');
      return serialized(() =>
        vault.exclusive(id, async () => {
          const { document, sources } = await readDocument();
          const existing = sources.find((entry) => entry.source.id === id);
          if (existing === undefined) {
            throw new ToolSourceInputError('source', 'not a configured source.', 'unknown-source');
          }
          // Read before anything is written: a failure here changes nothing. Agent files are only read.
          const affected = await agentsUsing(id);
          const remaining = sources.filter((entry) => entry !== existing);
          const { toolSources: _removed, ...rest } = document;
          const nextDocument =
            remaining.length === 0
              ? rest
              : { ...rest, toolSources: serializeToolSources(remaining) };
          const text = `${JSON.stringify(nextDocument, null, 2)}\n`;
          parseProviderConfiguration(text, location);
          if (!(await writeConfiguration(text))) {
            throw new Error('The tool-source configuration could not be written.');
          }
          retired.add(id);
          booted.delete(id);
          // Its connection was opened with credentials a removal cannot take back (a local command
          // got them in its environment), so it is closed: the tools fail until the next start.
          const connection = loadedById.get(id);
          if (connection !== undefined) {
            loadedById.delete(id);
            loadedSources.splice(loadedSources.indexOf(connection), 1);
            await connection.close().catch(() => undefined);
          }
          try {
            vault.clear(id);
          } catch {
            throw new ToolSourcePartialChangeError(id, 'credentials-not-cleared');
          }
          await record('tool.source.removed', existing.source, {}, affected);
          return { id, changed: true, restartRequired: true as const, affectedAgents: affected };
        }),
      );
    },
    async affectedAgents(rawId) {
      const id = checkedIdentifier(rawId, 'id');
      await configured(id);
      return { id, tools: loadedToolNames(id).toSorted(), affectedAgents: await agentsUsing(id) };
    },
    async authorize(rawId) {
      assertWritable();
      const id = checkedIdentifier(rawId, 'source');
      const entry = await configured(id);
      if (!isOAuth(entry.source)) {
        throw new ToolSourceInputError('source', 'does not sign in with OAuth.');
      }
      const revision = revisionOf(entry.source);
      let authorizationUrl: URL | undefined;
      try {
        const loaded = await within((signal) =>
          loadToolSource(entry.source, {
            resolveCredential,
            oauth: oauthOptions(
              (_sourceId, url) => {
                authorizationUrl = url;
              },
              'take',
              (sourceId) =>
                vault.tokenStorage(sourceId, 'take', () => isCurrent(sourceId, revision)),
            ),
            signal,
            ...fetchOption,
          }),
        );
        // The tokens already work: there is nothing to sign in to.
        await loaded.close().catch(() => undefined);
        await assertCurrent(id, revision);
        return { authorized: true };
      } catch (error) {
        if (
          error instanceof ToolSourceAuthorizationRequiredError &&
          authorizationUrl !== undefined
        ) {
          // The sign-in is good for this description and for a while: the callback checks both.
          const recorded = await vault.beginSignIn(id, { startedAt: now(), revision }, () =>
            isCurrent(id, revision),
          );
          if (!recorded) {
            await assertCurrent(id, revision);
            throw new ToolSourceInputError('source', 'changed while the sign-in was starting.');
          }
          return { authorized: false, authorizationUrl: authorizationUrl.href };
        }
        throw error;
      }
    },
    // Taken in turn with every other change to the configuration and to this source's secret: a
    // removal or a change that arrives during the token exchange waits for it, and one that came
    // first is seen here, so the tokens are never written for a source that is gone or different.
    async completeAuthorization(rawId, callbackUrl) {
      assertWritable();
      const id = checkedIdentifier(rawId, 'source');
      return serialized(() =>
        vault.exclusive(id, async () => {
          const entry = await configured(id);
          if (!isOAuth(entry.source)) {
            throw new ToolSourceInputError('source', 'does not sign in with OAuth.');
          }
          const { oauth: waiting, signIn } = await vault.read(id);
          // Armorer skips the `state` check when none was recorded, so a callback with no flow in
          // progress is refused here before it can reach the token endpoint.
          if (
            waiting?.state === undefined ||
            waiting.codeVerifier === undefined ||
            signIn === undefined
          ) {
            throw new ToolSourceInputError('callback', 'no sign-in is waiting for this source.');
          }
          // This call holds the source's turn, so the loader's storage must not wait for it.
          const storage = vault.tokenStorage(id, 'held');
          const elapsed = now() - signIn.startedAt;
          const refusal =
            signIn.revision !== revisionOf(entry.source)
              ? 'the source changed since the sign-in started.'
              : !(elapsed >= 0 && elapsed <= SIGN_IN_TIME_TO_LIVE_MILLISECONDS)
                ? 'the sign-in has expired.'
                : undefined;
          if (refusal !== undefined) {
            // A sign-in that cannot finish is dropped, so a replay finds none waiting.
            await storage.clear?.(['codeVerifier', 'state']);
            throw new ToolSourceInputError('callback', refusal);
          }
          // The exchange holds the configuration queue, so it is bounded: at the deadline the
          // request is cancelled and the exchange fails, instead of stalling every writer.
          const controller = new AbortController();
          const cancel = schedule(() => controller.abort(), timeout);
          const baseFetch = options.fetch ?? fetch;
          const bounded: typeof fetch = Object.assign(
            (input: RequestInfo | URL, init?: RequestInit) =>
              baseFetch(input, {
                ...init,
                signal:
                  init?.signal === undefined || init.signal === null
                    ? controller.signal
                    : AbortSignal.any([init.signal, controller.signal]),
              }),
            baseFetch,
          );
          try {
            await completeToolSourceAuthorization(entry.source, {
              oauth: oauthOptions(() => undefined, 'held'),
              callbackUrl,
              fetch: bounded,
            });
          } catch {
            // Nothing from the failure is repeated: it may hold a URL, a code, or the server's words.
            throw new ToolSourceInputError('callback', 'the sign-in could not be completed.');
          } finally {
            cancel();
          }
          // The recorded state and verifier are good for one sign-in. Clearing them makes the next
          // start a new one, and a replayed callback finds none waiting.
          await storage.clear?.(['codeVerifier', 'state']);
          // The tokens the server refused at load are replaced, so the page stops asking to sign in again.
          const previous = booted.get(id);
          if (previous?.standing.tokensRejected === true) {
            const { tokensRejected: _replaced, ...standing } = previous.standing;
            booted.set(id, { ...previous, standing });
          }
          await record('tool.source.authorized', entry.source);
          return { id, changed: true, restartRequired: true as const };
        }),
      );
    },
    async close() {
      closed = true;
      // A source still connecting holds a child process or a socket nobody is waiting for.
      for (const controller of loading) controller.abort();
      await Promise.allSettled(startedSources().map((loaded) => loaded.close()));
    },
  };
}
