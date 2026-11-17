import type { WorkspaceIdentity } from '@lostgradient/weft';
import {
  createLocalHostMutationContext,
  HostMutationError,
  type HostMutationContext,
} from './host-mutation-context.ts';
import { secretPublicationDigest } from './secret-publication-digest.ts';
import { createToolSourceOAuthAuthority } from './tool-source-oauth-authority.ts';
import type { ToolSourceOAuthBinding } from './tool-source-oauth-session.ts';
import type { WorkspaceSecrets } from './workspace-secrets.ts';
import { SecretPublicationError } from './workspace-secrets.ts';
/**
 * The host's saved tool sources while it runs (COR-1930): the MCP servers and OpenAPI services
 * `toolSources` in `configuration.json` names (`tool-sources-configuration.ts`), whose tools an
 * agent file may list by name, and the ways a person changes them.
 *
 * - **Loaded at boot; an added source at once.** {@link ToolSourceManager.start} loads every
 *   configured source through Armorer's loader (`armorer/tool-sources`) before the Bureau is
 *   built, and {@link ToolSourceManager.tools} is the catalog the Bureau is built with. Once the
 *   host is live ({@link ToolSourceManager.goLive}), a source {@link ToolSourceManager.connect}
 *   adds is loaded at once and its tools join the Bureau's catalog with no restart (COR-2009), as
 *   does an OAuth source when its first sign-in completes. A source that is changed or removed
 *   afterwards shows in {@link ToolSourceManager.snapshot} as `pending-restart` until the host
 *   starts again.
 * - **A tool can be off (COR-2009).** A tool whose settings say `enabled: false` is listed on its
 *   source and offered to no agent, so a source can be connected with a dangerous tool left off.
 * - **One source never blocks another, or the host.** A source that fails to connect, names a
 *   credential nobody stored, has credentials that cannot be read, or does not answer within
 *   {@link ToolSourceManagerOptions.loadTimeoutMilliseconds} is reported on its own entry and the
 *   rest load. An OAuth source with no tokens is not contacted at boot: it reports
 *   `needs-authorization` until a person signs in ({@link ToolSourceManager.authorize}).
 * - **The last listing is kept (COR-2435).** Each load or test that lists a source's tools keeps
 *   the listing in the host's storage ({@link ToolSourceManagerOptions.listings}), bound to the
 *   source's description; a failure never replaces it. A source that is not loaded reports it as
 *   `lastListing`, so its tools still show, none of them offered to an agent. A removal forgets it.
 * - **Credentials are never plaintext.** A value arrives in a request, goes straight into the
 *   encrypted vault (`tool-source-vault.ts`, Bungalow secret `tool-source-<id>`), and is read back
 *   only to hand to Armorer's loader through `resolveCredential` and the OAuth token storage.
 *   Nothing here returns, logs, audits or puts in an error a credential, a URL, or an environment
 *   value, with one exception (COR-2022): {@link ToolSourceManager.snapshot} reports a source's
 *   `address` for a person to recognise it, cut to its origin and path so a query or fragment,
 *   where a key could sit, never leaves; a URL never holds a username or password.
 * - **Labels and Default asks (COR-2022).** An entry may carry a `name` and a `description` beside
 *   `source`, and each tool an `approval`, its Default asks level. They are saved and reported;
 *   none needs a restart, and none changes a tool's name or what the running host applies.
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
 *   request carries, and answers with the tools it lists. A credential the request leaves out is
 *   read from the vault only for a saved source of that id that still goes to the same place, as
 *   a save would keep it (COR-2436, Edit connection); otherwise it is required. It stores,
 *   writes and records nothing, closes the connection before it answers, runs against its own
 *   deadline ({@link DEFAULT_PROBE_TIMEOUT_MILLISECONDS}), and reports a source that does not
 *   answer as a sentence that holds no address, command or value. An OAuth server that asks for
 *   a sign-in is reported as `needs-authorization`, unless the probe names a sign-in of the source
 *   made before it was saved.
 * - **A sign-in before the source is saved (COR-2436).** {@link ToolSourceManager.beginSignIn}
 *   keeps the sign-in in memory (`tool-source-pending-sign-ins.ts`) for the administrator who
 *   started it, with a `state` the host generated; the callback settles it once
 *   ({@link ToolSourceManager.completePendingSignIn}), refusing a stale, a second or a forged one;
 *   and {@link ToolSourceManager.connect} takes its tokens by reference, once, writing them to the
 *   vault with the source and bound to that administrator, as a saved source's sign-in leaves them.
 *   Nothing is written before that save, and a restart cancels the sign-ins in progress.
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
 *   tools, in `tools` or only in `approvals`, before anything is removed; {@link
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

import { type Bungalow, type ConfigurationSnapshot } from '@lostgradient/bungalow';
import {
  ANONYMOUS_LOCAL_OWNER,
  auditTrailToolSourceOwnerId,
  type AnswerEncryptionKeys,
  type SettingLockReason,
  type WorkspaceMembershipOptions,
} from '@lostgradient/bureau';
import {
  readToolShortDescription,
  readToolTitle,
  resolveCapabilityTier,
  type McpOAuthTokenStorage,
  type Tool,
} from 'armorer';
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
import {
  sourceListingOwner,
  type RememberedToolInput,
  type ToolListingMemory,
} from './tool-listing-memory.ts';
import { affectedAgents, type AffectedAgent, type AgentToolUse } from './tool-source-agents.ts';
import {
  copiedTokenStorage,
  createPendingSignIns,
  pendingTokenStorage,
  providerReason,
  randomToken,
  sameOwner,
  savedOAuthState,
  type PendingSignIn,
  type PendingSignInOutcome,
  type PendingSignInReason,
} from './tool-source-pending-sign-ins.ts';
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
  isSourceToolApproval,
  MAXIMUM_TOOL_SOURCE_DESCRIPTION_LENGTH,
  MAXIMUM_TOOL_SOURCE_NAME_LENGTH,
  parseToolSourcesConfiguration,
  qualifyToolNames,
  readToolSourcesConfiguration,
  RESERVED_TOOL_SOURCE_IDENTIFIERS,
  serializeToolSources,
  sourceLabelProblem,
  sourceToolApprovalProblem,
  tierApproval,
  TOOL_SOURCE_IDENTIFIER,
  type ConfiguredToolSettings,
  type ConfiguredToolSource,
  type SourceToolApproval,
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

/** Why the Connect tools page cannot edit a saved source (COR-2436). */
export type ToolSourceNotEditableReason =
  /** It runs a command on this machine, whose command line the host never sends to a page. */
  | 'local-command'
  /** An address holds a query or fragment, where a key could sit, which the host never sends. */
  | 'address-query'
  /** It sets something the page does not show, so saving the page's form would drop it. */
  | 'unshown-settings';

/** A saved source the Connect tools page cannot edit: change it in `configuration.json`. */
export class ToolSourceNotEditableError extends Error {
  /** Why. */
  readonly reason: ToolSourceNotEditableReason;

  constructor(reason: ToolSourceNotEditableReason) {
    super(
      reason === 'local-command'
        ? 'This source runs a command on this machine. Change it in configuration.json.'
        : reason === 'address-query'
          ? 'An address of this source holds a query, which the page does not show. Change it in configuration.json.'
          : 'This source sets something the page does not show. Change it in configuration.json.',
    );
    this.name = 'ToolSourceNotEditableError';
    this.reason = reason;
  }
}

/** What the Connect tools page edits a saved source from (COR-2436): its description and labels. */
export type ToolSourceEditing = {
  /** The source's identifier, which an edit keeps. */
  readonly id: string;
  /** The saved description: credentials named, never held. */
  readonly source: ToolSourceDescription;
  /** Its saved name, or `null`. */
  readonly name: string | null;
  /** Its saved sentence, or `null`. */
  readonly description: string | null;
  /** The names of the credentials the host holds for it, never their values. */
  readonly credentials: readonly string[];
  /** The configuration revision the description was read at: the save is fenced on it. */
  readonly configurationRevision: string | null;
};

/** Whether `value` is an http(s) URL with no query or fragment. */
function plainAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

/**
 * Why the Connect tools page cannot represent `source` exactly, or `undefined` when it can. The
 * page builds a description from its fields alone, so a description that sets anything else
 * (another credential name, an OAuth scope, `allowOperations`, a name prefix) would lose it on save.
 */
function notEditableReason(source: ToolSourceDescription): ToolSourceNotEditableReason | undefined {
  if (isLocalCommand(source)) return 'local-command';
  if (source.kind === 'mcp') {
    const { transport } = source;
    if (transport.type !== 'http') return 'local-command';
    if (!plainAddress(transport.url)) return 'address-query';
    const authentication = transport.authentication;
    if (
      authentication !== undefined &&
      !(authentication.type === 'bearer' && authentication.credential === 'token') &&
      !(
        authentication.type === 'oauth' &&
        authentication.scope === undefined &&
        authentication.clientName === undefined
      )
    ) {
      return 'unshown-settings';
    }
    return undefined;
  }
  if (source.specification.type === 'url' && !plainAddress(source.specification.url)) {
    return 'address-query';
  }
  if (source.baseUrl === undefined) return 'unshown-settings';
  if (!plainAddress(source.baseUrl)) return 'address-query';
  if (source.allowOperations !== undefined || source.namePrefix !== undefined) {
    return 'unshown-settings';
  }
  const authentication = source.authentication;
  if (
    authentication !== undefined &&
    !(authentication.type === 'bearer' && authentication.credential === 'token') &&
    !(authentication.type === 'api-key' && authentication.credential === 'key')
  ) {
    return 'unshown-settings';
  }
  return undefined;
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
    readonly workspaceId?: string;
    readonly actorId?: string;
    readonly membershipRevision?: string;
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
  /**
   * Whether the running host offers the tool (COR-2009): `false` for a tool the owner turned off,
   * which no agent can be given.
   */
  readonly enabled: boolean;
  /** Whether the saved settings turn the tool on: what `enabled` becomes at the next start. */
  readonly savedEnabled: boolean;
  /** Its capability tier (`read-only`, `mutating`, `dangerous`), or `null` when it has none. */
  readonly tier: string | null;
  /**
   * The tool's Default asks level (COR-2022), from the saved settings as they are now: the one the
   * source's owner picked, or, when they picked none, the one its tier gives (`tierApproval`:
   * Never for a tool that only reads, Always for a dangerous one, On changes otherwise). It is
   * saved and reported here; an agent's own `approvals` entry for the tool, Blocked among them, is
   * that agent's override of it.
   */
  readonly approval: SourceToolApproval;
  /** Whether {@link ToolSourceToolStanding.approval} is the owner's own pick rather than the tier's. */
  readonly approvalSaved: boolean;
};

/** One source in a {@link ToolSourceSnapshot}. */
export type ToolSourceStanding = {
  /** The source's identifier. */
  readonly id: string;
  /** `mcp` or `openapi`. */
  readonly kind: ToolSourceDescription['kind'];
  /** What a person calls the source ("GitHub"), as saved, or `null` when none was given: show its `id` (COR-2022). */
  readonly name: string | null;
  /** One sentence about the source, as saved, or `null` when none was given (COR-2022). */
  readonly description: string | null;
  /**
   * Where the source is, for a person to recognise it (COR-2022): an MCP server's URL, or an
   * OpenAPI spec's address (its base URL when the spec was uploaded), each cut to its origin and
   * path, so a query or fragment, where a key could sit, is never repeated. A URL never holds a
   * username or password (the host refuses one). `null` for a local command, whose command line
   * stays out of every answer, and for an uploaded spec with no base URL.
   */
  readonly address: string | null;
  /**
   * When the running host last reached the source as it is now saved, as an ISO 8601 time: a load
   * at start, a load when it was added, or a test ({@link ToolSourceManager.test}) that listed its
   * tools (COR-2022). Absent until one has; kept in memory, so a restart starts it again with the
   * load. A failed attempt does not move it.
   */
  readonly lastTested?: string;
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
  /**
   * For a source that is not loaded (it failed, waits for a sign-in, or waits for a restart): the
   * tools it listed the last time the host loaded it as it is saved now, kept across restarts
   * (`tool-listing-memory.ts`, COR-2435), with the saved settings as they are now. None of them is
   * offered to an agent. Absent when the source is loaded, or no listing of it is known.
   */
  readonly lastListing?: {
    /** When the listing was made, as an ISO 8601 time. */
    readonly listedAt: string;
    /** The tools it listed, as {@link ToolSourceStanding.tools} reports them, with what a person reads of each. */
    readonly tools: readonly ToolSourceRememberedTool[];
    /** True when the listing held more than the host keeps, so some tools or schemas were left out. */
    readonly truncated: boolean;
  };
};

/** One tool of a source's last listing: its standing, with its name for a person and what it does. */
export type ToolSourceRememberedTool = ToolSourceToolStanding & {
  /** Its name for a person ("Create issue"), or `null` when it has none. */
  readonly title: string | null;
  /** What the model was told about it, cut to a bound. */
  readonly description: string;
  /** Its one line for a person, or `null` when it declares none. */
  readonly shortDescription: string | null;
  /** What it takes, as a JSON Schema, or `null` when that is not known. */
  readonly inputSchema: Readonly<Record<string, unknown>> | null;
};

/** The saved tool sources as the host holds them, with no credential. */
export type ToolSourceSnapshot = {
  /** Opaque committed configuration revision used by explicit mutations. */
  readonly configurationRevision: string | null;
  /** The configured sources, in the order the file lists them. */
  readonly sources: readonly ToolSourceStanding[];
  /** Present when changes are refused, with the reason. */
  readonly lockReason?: SettingLockReason;
  /** Present when configuration may be writable but credential publication is unavailable. */
  readonly credentialLockReason?: SettingLockReason;
};

/** What a probe asks for. Every field is `unknown` because it arrives from a request: the manager checks it. */
export type ToolSourceProbeRequest = {
  /** The description (`armorer/tool-sources`), as {@link ToolSourceConnection.source}. */
  readonly source: unknown;
  /**
   * Credential name to value, for every credential the description names. One left out is read
   * from the vault only for a saved source of the same id that still goes to the same place.
   */
  readonly credentials?: unknown;
  /** The identifier the request addresses, which the description's `id` must equal. */
  readonly id: unknown;
  /** Who is asking. A local command is spawned only for the owner. */
  readonly principal: string;
  /**
   * A sign-in of this source that succeeded before it was saved (COR-2436): the probe uses a copy
   * of the tokens it got, for its owner only, and keeps nothing.
   */
  readonly signIn?: unknown;
};

/** What starting a sign-in of a source that is not saved reports (COR-2436). */
export type ToolSourcePendingSignInStart =
  /** The server asked for no sign-in: there is nothing to sign in to. */
  | { readonly authorized: true }
  /** Open `authorizationUrl`; `signIn` is the reference a probe, a save and a read of the outcome name. */
  | { readonly authorized: false; readonly signIn: string; readonly authorizationUrl: string };

/** Where a sign-in of a source that is not saved stands, for its owner (COR-2436). */
export type ToolSourcePendingSignInStanding = {
  readonly signIn: string;
  readonly outcome: PendingSignInOutcome;
  readonly reason?: PendingSignInReason;
};

/** What the callback of a sign-in of a source that is not saved settled (COR-2436). */
export type ToolSourcePendingCallback = ToolSourcePendingSignInStanding & {
  /** The origin of the page that started it: the only place the outcome is posted to. */
  readonly openerOrigin: string;
};

/** One tool a probe found, under the name an agent file would use once the source is saved. */
export type ToolSourceProbeTool = {
  /** The name an agent file lists (`<id>__<tool>`). */
  readonly name: string;
  /** The tool's own name at the source. */
  readonly tool: string;
  /** Its capability tier (`read-only`, `mutating`, `dangerous`), or `null` when it has none. */
  readonly tier: string | null;
  /** Its name for a person ("List issues"), or `null` when the source gives none (COR-2009). */
  readonly title: string | null;
  /** What it does, as the source describes it. */
  readonly description: string;
};

/**
 * The call a probe of an OpenAPI source makes to show that its key works (COR-2009): the first tool
 * that reads (`GET`) and needs no input, the same operation `inspectOpenApiSpec` names as
 * `testOperation`. `passed` is false, with the reason, when the service answered an error.
 */
export type ToolSourceProbeTest = {
  /** The tool's own name at the source. */
  readonly tool: string;
  /** Its name for a person ("List refunds"), or `null`. */
  readonly title: string | null;
  /** Whether the service answered the call without an error. */
  readonly passed: boolean;
  /** Why the call failed, in words that hold no address or value; absent when it passed. */
  readonly message?: string;
};

/**
 * What an MCP server said of itself when a probe reached it (COR-2436), so Connect tools fills in
 * Name after the test: its name for a person, one line within the length a saved name may have,
 * and its instructions, cut. The server's own untrusted text; `null` when it gave none.
 */
export type ToolSourceProbeServer = {
  readonly name: string | null;
  readonly instructions: string | null;
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
      /** For an OpenAPI source with a tool that reads and needs no input: the call made with the key. */
      readonly test?: ToolSourceProbeTest;
      /** For an MCP server that said what it is when it connected (COR-2436). */
      readonly server?: ToolSourceProbeServer;
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
  /**
   * The host's settings per tool for a source this request adds (COR-2009), as
   * {@link ToolSourceToolSettingsChange.tools} takes them: `{ "delete_branch": { "enabled": false } }`
   * leaves a tool off, and `{ "create_issue": { "approval": "on-changes" } }` picks its Default asks
   * level (COR-2022). This is the selection a person makes when they connect: it replaces every
   * per-tool setting the source had. Omitted, a new source's tools are all on at the level their
   * tier gives, and a changed source keeps its own.
   */
  readonly tools?: unknown;
  /**
   * What a person calls the source (COR-2022): non-empty text of at most
   * `MAXIMUM_TOOL_SOURCE_NAME_LENGTH` characters, saved trimmed. Omitted, the saved name is kept.
   */
  readonly name?: unknown;
  /**
   * One sentence about the source (COR-2022), at most `MAXIMUM_TOOL_SOURCE_DESCRIPTION_LENGTH`
   * characters, saved trimmed. Empty text or `null` clears it; omitted, the saved one is kept.
   */
  readonly description?: unknown;
  /**
   * A sign-in of this source that succeeded before it was saved (COR-2436): the source is saved
   * with the tokens that sign-in got, taken from the host by reference, never sent by the page.
   * Only its owner may name it, only for the description it began for, and only once: a retry of
   * the same save, under the same operation id, takes it again.
   */
  readonly signIn?: unknown;
};

/** What a change to the per-tool settings of a source asks for. Every field is `unknown` because it arrives from a request. */
export type ToolSourceToolSettingsChange = {
  /** The identifier of a configured source. */
  readonly id: unknown;
  /**
   * Tool name (as the server lists it, not the `<id>__<tool>` name) to the settings to change. Each
   * field a request names is set and each it leaves out is kept (COR-2022), so a page that saves
   * one control at once, the On checkbox or the Default asks select, never resets another; tools
   * not named are kept. A field set back to its default (`acceptsSecrets: false`,
   * `enabled: true`, `approval: null`, which returns the tool to the level its tier gives) leaves
   * nothing behind, and a tool with nothing left has no entry.
   */
  readonly tools: unknown;
};

/** What a change reports. */
export type ToolSourceChange = {
  /** The source the change was for. */
  readonly id: string;
  /** Whether the stored configuration changed. */
  readonly changed: boolean;
  /**
   * True when the host lists the change at its next start. A source a connection adds is loaded at
   * once instead, when the host is live ({@link ToolSourceManager.goLive}): then this is `false`
   * and {@link ToolSourceChange.available} names its tools (COR-2009).
   */
  readonly restartRequired: boolean;
  /**
   * The names an agent file uses for the tools the added source made available now, each one that
   * is on; absent when nothing was loaded at once.
   */
  readonly available?: readonly string[];
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
  /** The agent files that name any of them, in `tools` or in `approvals`. */
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
  probe(request: ToolSourceProbeRequest, mutation?: HostMutationContext): Promise<ToolSourceProbe>;
  /**
   * Store a source's credentials and list the source in the configuration. A source this adds is
   * loaded at once when the host is live, and its tools are available without a restart.
   */
  connect(request: ToolSourceConnection, mutation?: HostMutationContext): Promise<ToolSourceChange>;
  /**
   * From now on, load each source {@link connect} adds at once (and an OAuth source once its first
   * sign-in completes) and hand the tools it offers, the ones that are on, to `add`, by the name an
   * agent file uses: the host passes the Bureau's `agents.addTools` once the Bureau is built
   * (COR-2009). A source that was removed since the host started is left for the next start.
   */
  goLive(add: (tools: Readonly<Record<string, Tool>>) => Promise<void>): void;
  /**
   * Contact a saved source the way the host loads it, with the credentials and sign-in it holds,
   * and report the tools it lists, as {@link probe} reports them (COR-2022, Test connection on a
   * saved source). It changes nothing saved and holds no connection afterwards; a source that
   * listed its tools moves {@link ToolSourceStanding.lastTested}. The running host's tools are not
   * touched, whatever the answer.
   */
  test(id: unknown, mutation?: HostMutationContext): Promise<ToolSourceProbe>;
  /**
   * Set the per-tool settings (`acceptsSecrets`, `enabled`, `approval`) of a configured source, a
   * field at a time ({@link ToolSourceToolSettingsChange.tools}). Loaded at the next start.
   */
  configureTools(
    request: ToolSourceToolSettingsChange,
    mutation?: HostMutationContext,
  ): Promise<ToolSourceChange>;
  /** Remove a source from the configuration and clear its credentials. No agent file is changed. */
  remove(
    request: { readonly id: unknown; readonly principal: string },
    mutation?: HostMutationContext,
  ): Promise<ToolSourceRemoval>;
  /** The agent files a removal of the source would leave invalid. Changes nothing, and works on a remote home. */
  affectedAgents(id: unknown): Promise<ToolSourceRemovalPreview>;
  /**
   * The saved source as the Connect tools page edits it (COR-2436): its description, labels and
   * credential names, never a credential's value. Checked as a change is, before the source is
   * looked up; refused on a remote home, and with {@link ToolSourceNotEditableError} for a source
   * the page cannot represent exactly (a local command, an address with a query, or settings the
   * page does not show), so a save never drops what it did not show.
   */
  editing(id: unknown, mutation?: HostMutationContext): Promise<ToolSourceEditing>;
  /** Start an MCP OAuth sign-in for a configured source. */
  authorize(id: unknown, mutation?: HostMutationContext): Promise<ToolSourceAuthorization>;
  /**
   * Start an MCP OAuth sign-in for a source that is not saved (COR-2436): the host generates the
   * `state`, keeps the sign-in in memory for its owner, and answers the authorization URL to open
   * with a reference to it. `openerOrigin` is the origin of the page that asks, where the outcome
   * is posted.
   */
  beginSignIn(
    request: {
      readonly id: unknown;
      readonly source: unknown;
      readonly principal: string;
      readonly openerOrigin: unknown;
    },
    mutation?: HostMutationContext,
  ): Promise<ToolSourcePendingSignInStart>;
  /** Where the sign-in `signIn` stands, for its owner; anyone else is answered as if there were none. */
  pendingSignIn(
    signIn: unknown,
    mutation?: HostMutationContext,
  ): Promise<ToolSourcePendingSignInStanding>;
  /**
   * Settle the sign-in of a source that is not saved that the callback URL's `state` names, or
   * answer `undefined` when it names none (the callback is then a saved source's). Never throws for
   * a callback it settles: a refusal is an outcome with its reason.
   */
  completePendingSignIn(
    id: unknown,
    callbackUrl: string,
  ): Promise<ToolSourcePendingCallback | undefined>;
  /** Finish a sign-in from the URL the browser came back to. */
  completeAuthorization(
    id: unknown,
    callbackUrl: string,
    mutation?: HostMutationContext,
  ): Promise<ToolSourceChange>;
  /** Refuse every later change and close every connection the sources hold. The host calls it as it shuts down. */
  close(): Promise<void>;
};

/** What {@link createToolSourceManager} reads. */
export type ToolSourceManagerOptions = {
  /** Injected hosts resolve the initiating administrator before every OAuth exchange. */
  readonly workspace?: WorkspaceMembershipOptions;
  /** Shared activation/recovery service for this host. */
  readonly workspaceSecrets?: WorkspaceSecrets;
  /** The open home. Its mode decides whether a write is allowed. */
  readonly bungalow: Pick<
    Bungalow,
    | 'mode'
    | 'configurationLocation'
    | 'readConfiguration'
    | 'writeConfiguration'
    | 'workspaceId'
    | 'secretProvider'
    | 'configurationWriteCapability'
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
  /**
   * Where each source's last tool listing is kept across restarts (COR-2435). Omitted, none is
   * kept, and a source that does not load reports no `lastListing`.
   */
  readonly listings?: ToolListingMemory;
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

/**
 * The origin of the page that starts a sign-in (COR-2436): an `http` or `https` origin exactly,
 * where the outcome is posted, never anywhere else.
 */
function checkedOrigin(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value) {
        return value;
      }
    } catch {
      // Refused below.
    }
  }
  throw new ToolSourceInputError('origin', 'expected the origin of the page that signs in.');
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
  return JSON.stringify([acceptingTools(entry.tools), offTools(entry.tools)]);
}

/** The names of the tools turned off (`enabled: false`), sorted (COR-2009). */
function offTools(tools: ReadonlyMap<string, ConfiguredToolSettings>): string[] {
  return [...tools]
    .filter(([, settings]) => settings.enabled === false)
    .map(([name]) => name)
    .sort();
}

/**
 * `settings` with only what differs from the default kept, `acceptsSecrets: true`,
 * `enabled: false` and a picked `approval` (COR-2022), or `undefined` when nothing does: the
 * default is no entry at all, so a tool set back to it leaves nothing behind. A picked `approval`
 * is kept even when it equals the tier's: the tier is the server's to change, the pick is the
 * owner's.
 */
function nonDefaultSettings(settings: ConfiguredToolSettings): ConfiguredToolSettings | undefined {
  const kept: ConfiguredToolSettings = {
    ...(settings.acceptsSecrets === true ? { acceptsSecrets: true } : {}),
    ...(settings.enabled === false ? { enabled: false } : {}),
    ...(settings.approval === undefined ? {} : { approval: settings.approval }),
  };
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * One tool's settings as a request names them: a field it leaves out is `undefined`, and
 * `approval: null` asks for the level the tool's tier gives (COR-2022).
 */
type ToolSettingsChange = {
  readonly acceptsSecrets?: boolean;
  readonly enabled?: boolean;
  readonly approval?: SourceToolApproval | null;
};

/**
 * `current` with each field `change` names set, and each it leaves out kept (COR-2022). `null`
 * drops a picked `approval`. The result still carries defaults: {@link nonDefaultSettings} drops them.
 */
function mergedSettings(
  current: ConfiguredToolSettings | undefined,
  change: ToolSettingsChange,
): ConfiguredToolSettings {
  const acceptsSecrets = change.acceptsSecrets ?? current?.acceptsSecrets;
  const enabled = change.enabled ?? current?.enabled;
  const approval = change.approval === null ? undefined : (change.approval ?? current?.approval);
  return {
    ...(acceptsSecrets === undefined ? {} : { acceptsSecrets }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(approval === undefined ? {} : { approval }),
  };
}

/** The Default asks level a tool stands at (COR-2022): the owner's pick, else its tier's. */
function approvalStanding(
  settings: ConfiguredToolSettings | undefined,
  tier: string | null,
): Pick<ToolSourceToolStanding, 'approval' | 'approvalSaved'> {
  const saved = settings?.approval;
  return saved === undefined
    ? { approval: tierApproval(tier), approvalSaved: false }
    : { approval: saved, approvalSaved: true };
}

/** An address cut to its origin and path, or `null` for one that is not a URL (COR-2022). */
function publicAddress(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    // The query and the fragment are dropped: a key could sit in either.
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Where a source is, for a person (COR-2022): the MCP server's URL, the OpenAPI spec's address or,
 * for an uploaded spec, its base URL. A local command is `null`: its command line is never answered.
 */
function addressOf(source: ToolSourceDescription): string | null {
  if (source.kind === 'mcp') {
    return source.transport.type === 'http' ? publicAddress(source.transport.url) : null;
  }
  return publicAddress(
    source.specification.type === 'url' ? source.specification.url : source.baseUrl,
  );
}

/** The labels and address of a saved source, as {@link ToolSourceStanding} carries them (COR-2022). */
function labelsOf(
  entry: ConfiguredToolSource,
): Pick<ToolSourceStanding, 'name' | 'description' | 'address'> {
  return {
    name: entry.name ?? null,
    description: entry.description ?? null,
    address: addressOf(entry.source),
  };
}

/**
 * The labels a connection names (COR-2022), checked before the first `await`: `undefined` keeps
 * the saved one, `null` clears a description, and text sets it, trimmed.
 */
function checkedLabels(request: Pick<ToolSourceConnection, 'name' | 'description'>): {
  readonly name: string | undefined;
  readonly description: string | null | undefined;
} {
  let name: string | undefined;
  if (request.name !== undefined) {
    const problem = sourceLabelProblem(request.name, MAXIMUM_TOOL_SOURCE_NAME_LENGTH, true);
    if (problem !== undefined || typeof request.name !== 'string') {
      throw new ToolSourceInputError('name', problem ?? 'expected text.');
    }
    name = request.name.trim();
  }
  let description: string | null | undefined;
  if (request.description === null) {
    description = null;
  } else if (request.description !== undefined) {
    const problem = sourceLabelProblem(
      request.description,
      MAXIMUM_TOOL_SOURCE_DESCRIPTION_LENGTH,
      false,
    );
    if (problem !== undefined || typeof request.description !== 'string') {
      throw new ToolSourceInputError('description', problem ?? 'expected text.');
    }
    const trimmed = request.description.trim();
    description = trimmed === '' ? null : trimmed;
  }
  return { name, description };
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
function checkedToolSettings(value: unknown): Map<string, ToolSettingsChange> {
  const copy = copyOfJson(value);
  if (!isPlainObject(copy)) throw new ToolSourceInputError('tools', 'expected an object.');
  const settings = new Map<string, ToolSettingsChange>();
  for (const [name, entry] of Object.entries(copy)) {
    if (name === '') throw new ToolSourceInputError('tools', 'a tool name cannot be empty.');
    if (!isPlainObject(entry)) {
      throw new ToolSourceInputError(`tools.${name}`, 'expected an object.');
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'acceptsSecrets' && key !== 'enabled' && key !== 'approval') {
        throw new ToolSourceInputError(`tools.${name}.${key}`, 'not a known field.');
      }
    }
    // The same values the file's reader takes (`sourceToolApprovalProblem`), and `null` for the tier's.
    const approval = entry['approval'];
    if (approval !== undefined && approval !== null && !isSourceToolApproval(approval)) {
      throw new ToolSourceInputError(
        `tools.${name}.approval`,
        sourceToolApprovalProblem(approval) ?? 'expected never, on-changes or always.',
      );
    }
    const accepts = entry['acceptsSecrets'];
    if (accepts !== undefined && typeof accepts !== 'boolean') {
      throw new ToolSourceInputError(`tools.${name}.acceptsSecrets`, 'expected true or false.');
    }
    const enabled = entry['enabled'];
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new ToolSourceInputError(`tools.${name}.enabled`, 'expected true or false.');
    }
    settings.set(name, {
      ...(accepts === undefined ? {} : { acceptsSecrets: accepts }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(approval === undefined ? {} : { approval }),
    });
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

/**
 * The tool an OpenAPI probe calls (COR-2009): the first, in the order the spec lists them, that
 * reads (`GET`) and needs no input, as `inspectOpenApiSpec` picks its `testOperation`.
 */
function testToolOf(tools: readonly Tool[]): Tool | undefined {
  return tools.find((tool) => {
    if (!(tool.tags ?? []).includes('get')) return false;
    try {
      const required: unknown = tool.toJSON().input['required'];
      return !Array.isArray(required) || required.length === 0;
    } catch {
      return false;
    }
  });
}

/**
 * What a probe, or a test of a saved source, answers for the tools `loaded` that source `id`
 * listed: each under the name an agent file would use, the ones skipped with the reason, and for an
 * OpenAPI source the call {@link testCall} makes with its key.
 */
async function listedProbe(
  id: string,
  source: ToolSourceDescription,
  loaded: readonly Tool[],
  information?: LoadedToolSource['server'],
): Promise<ToolSourceProbe> {
  const server = probeServerOf(information);
  const names = qualifyToolNames(
    id,
    loaded.map((tool) => tool.name),
  );
  const byName = new Map(names.named.map(({ tool, name }) => [tool, name]));
  const tools: ToolSourceProbeTool[] = [];
  for (const tool of loaded) {
    const name = byName.get(tool.name);
    if (name === undefined) continue;
    tools.push({
      name,
      tool: tool.name,
      tier: resolveCapabilityTier(tool.metadata, tool.tags) ?? null,
      title: readToolTitle(tool.metadata) ?? null,
      description: tool.description,
    });
  }
  const test = source.kind === 'openapi' ? await testCall(loaded) : undefined;
  return {
    outcome: 'listed' as const,
    tools,
    skipped: names.skipped,
    ...(test === undefined ? {} : { test }),
    ...(server === undefined ? {} : { server }),
  };
}

/** The longest server instructions a probe repeats, in characters. */
const MAXIMUM_PROBE_INSTRUCTIONS_LENGTH = 2000;

/**
 * What a probe repeats of what an MCP server said of itself (COR-2436): its name for a person
 * (`title`, else `name`), cut to the length a saved name may have, and its instructions, cut. Both
 * are the server's own untrusted text: a page shows them as text and a person may change them.
 */
function probeServerOf(information: LoadedToolSource['server']): ToolSourceProbeServer | undefined {
  if (information === undefined) return undefined;
  // A control character, a line break among them, never reaches a label.
  // eslint-disable-next-line no-control-regex -- a control character is what this removes.
  const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const name = oneLine(information.title ?? information.name).slice(
    0,
    MAXIMUM_TOOL_SOURCE_NAME_LENGTH,
  );
  const instructions = information.instructions?.trim().slice(0, MAXIMUM_PROBE_INSTRUCTIONS_LENGTH);
  return {
    name: name === '' ? null : name,
    instructions: instructions === undefined || instructions === '' ? null : instructions,
  };
}

/**
 * Call the OpenAPI tool {@link testToolOf} picks with no input, so a wrong key shows before the
 * source is saved. The answer names no address or value: an error answer is reported by its status.
 */
async function testCall(tools: readonly Tool[]): Promise<ToolSourceProbeTest | undefined> {
  const tool = testToolOf(tools);
  if (tool === undefined) return undefined;
  const title = readToolTitle(tool.metadata) ?? null;
  const named = title ?? tool.name;
  try {
    const run = await tool.configuration.execute;
    await run({});
    return { tool: tool.name, title, passed: true };
  } catch (error) {
    const status =
      error instanceof Error ? /failed with status (\d{3})/.exec(error.message)?.[1] : undefined;
    return {
      tool: tool.name,
      title,
      passed: false,
      message:
        status === undefined
          ? `${named} got no answer from the service.`
          : `${named} answered ${status}, so the key or the address may be wrong.`,
    };
  }
}

/** Create the manager. It loads nothing until {@link ToolSourceManager.start}. */
export function createToolSourceManager(options: ToolSourceManagerOptions): ToolSourceManager {
  const { bungalow } = options;
  const location = bungalow.configurationLocation;
  const owner = options.owner ?? ANONYMOUS_LOCAL_OWNER;
  const configurationQueue = options.configurationQueue ?? createConfigurationQueue();
  const vault: ToolSourceVault = createToolSourceVault({
    bungalow,
    keys: options.keys,
    ...(options.workspaceSecrets === undefined
      ? {}
      : { workspaceSecrets: options.workspaceSecrets }),
  });
  const oauthAuthority = createToolSourceOAuthAuthority({
    vault,
    home: bungalow,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  });
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
  /**
   * When the host last reached each source, and the description it reached (COR-2022): a load at
   * start or when added, or a test that listed its tools. Reported as `lastTested` only while the
   * saved description is still the one reached.
   */
  const reached = new Map<string, { description: string; at: number }>();
  /** Sign-ins of sources that are not saved yet (COR-2436), in memory only. */
  const pendingSignIns = createPendingSignIns(now, SIGN_IN_TIME_TO_LIVE_MILLISECONDS);

  /**
   * The pending sign-in `raw` names, for `identity` and source `id`, or the refusal: a reference
   * that is not one, names no record, names another owner's or another source's, or one that did
   * not succeed, is the same refusal, so it says nothing of what exists.
   */
  function ownedSignIn(
    raw: unknown,
    identity: { readonly workspaceId: string; readonly actorId: string; readonly owner: string },
    id: string,
    source: ToolSourceDescription,
    operationId?: string,
  ): PendingSignIn {
    const refuse = (problem: string): never => {
      throw new ToolSourceInputError('signIn', problem);
    };
    if (typeof raw !== 'string' || raw === '' || raw.length > 128) {
      return refuse('expected the sign-in this page started.');
    }
    const pending = pendingSignIns.get(raw);
    if (pending === undefined || !sameOwner(pending.binding, identity) || pending.sourceId !== id) {
      return refuse('no sign-in of yours is waiting for this source. Sign in again.');
    }
    if (pending.revision !== revisionOf(source)) {
      return refuse('the sign-in was for another address or sign-in. Sign in again.');
    }
    if (pending.outcome !== 'succeeded')
      return refuse('the sign-in did not succeed. Sign in again.');
    const settled = pending.settledAt ?? pending.startedAt;
    if (!(now() - settled <= SIGN_IN_TIME_TO_LIVE_MILLISECONDS)) {
      return refuse('the sign-in has expired. Sign in again.');
    }
    if (pending.consumedBy !== undefined && pending.consumedBy !== operationId) {
      return refuse('the sign-in was already used. Sign in again.');
    }
    return pending;
  }
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

  async function assertMutation(
    mutation: HostMutationContext,
    source?: ToolSourceDescription,
  ): Promise<WorkspaceIdentity> {
    const identity = await mutation.revalidate();
    if (
      mutation.workspaceId !== bungalow.workspaceId ||
      (source !== undefined &&
        isLocalCommand(source) &&
        !identity.capabilities.includes('deployment:operate'))
    )
      throw new HostMutationError('forbidden');
    return identity;
  }

  async function readSnapshot() {
    try {
      return await bungalow.readConfiguration();
    } catch {
      throw new ProviderConfigurationError(location, 'the file', 'it could not be read.');
    }
  }

  /** The configuration as an object whose other keys a write keeps, and the sources it lists. */
  async function readDocument(): Promise<{
    text: string | undefined;
    revision: string | null;
    document: Record<string, unknown>;
    sources: readonly ConfiguredToolSource[];
  }> {
    const { text, revision } = await readSnapshot();
    // Parsed first as the host reads it, so a file that is already invalid is refused, not overwritten.
    if (text !== undefined) parseProviderConfiguration(text, location);
    const sources = readToolSourcesConfiguration(text, location);
    const parsed: unknown = text === undefined ? {} : JSON.parse(text);
    return { text, revision, document: isPlainObject(parsed) ? parsed : {}, sources };
  }

  const resolveCredential = async (
    { sourceId, credential }: { sourceId: string; credential: string },
    snapshot?: ConfigurationSnapshot,
  ): Promise<string | undefined> => {
    const secrets = await vault.read(sourceId, snapshot);
    return secrets.credentials.get(credential);
  };

  /** The credentials of a source loaded at boot: none once that incarnation is {@link retired}. */
  const resolveForLoaded =
    (loaded: ToolSourceDescription): typeof resolveCredential =>
    async (request) => {
      if (retired.has(request.sourceId)) return undefined;
      // A file edited by hand can drop the source and add one of the same id elsewhere: the tools
      // loaded under the old description are not given the new source's credentials.
      const snapshot = await readDocument();
      const current = snapshot.sources.find((entry) => entry.source.id === request.sourceId);
      if (current === undefined || recipientOf(current.source) !== recipientOf(loaded)) {
        return undefined;
      }
      return resolveCredential(request, snapshot);
    };

  /** Every persistent loader shares one fenced storage/admission session. */
  function oauthForSource(
    source: ToolSourceDescription,
    onAuthorizationRequired: ToolSourceOAuthOptions['onAuthorizationRequired'],
    turn: TokenStorageTurn = 'take',
    binding?: ToolSourceOAuthBinding,
  ): ToolSourceOAuthOptions {
    const revision = revisionOf(source);
    let pending: ReturnType<typeof oauthAuthority.session> | undefined;
    const session = () =>
      (pending ??= oauthAuthority.session(
        source.id,
        revision,
        async (snapshot) =>
          !retired.has(source.id) && (await isCurrent(source.id, revision, snapshot)),
        turn,
        binding,
      ));
    const storage: McpOAuthTokenStorage = {
      load: async () => {
        const current = await session();
        return current.tokenStorage.load();
      },
      save: async (input) => {
        const patch = structuredClone(input);
        const current = await session();
        await current.tokenStorage.save(patch);
      },
      clear: async (input) => {
        const keys = [...input];
        const current = await session();
        await current.tokenStorage.clear?.(keys);
      },
    };
    return {
      tokenStorage: (id) => {
        if (id !== source.id) throw new HostMutationError('forbidden');
        return storage;
      },
      redirectUrl: (id) => `${options.origin()}${oauthCallbackPath(id)}`,
      onAuthorizationRequired,
      beforeTokenRequest: async (id, request) => {
        if (id !== source.id) throw new HostMutationError('forbidden');
        const snapshot = { ...request };
        const current = await session();
        return current.beforeTokenRequest(snapshot);
      },
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
      ...labelsOf(entry),
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

  /**
   * Keep what `source` just listed as its last listing (COR-2435): called only after a listing
   * succeeded, so a failure never replaces it. Best effort: a write that fails is a warning, and
   * never fails the load or test it follows.
   */
  async function rememberListing(
    source: ToolSourceDescription,
    loaded: readonly Tool[],
  ): Promise<void> {
    const memory = options.listings;
    if (memory === undefined) return;
    const names = qualifyToolNames(
      source.id,
      loaded.map((tool) => tool.name),
    );
    const byName = new Map(names.named.map(({ tool, name }) => [tool, name]));
    const tools: RememberedToolInput[] = [];
    for (const tool of loaded) {
      const name = byName.get(tool.name);
      if (name === undefined) continue;
      let inputSchema: Readonly<Record<string, unknown>> | null;
      try {
        inputSchema = { ...tool.toJSON().input };
      } catch {
        inputSchema = null;
      }
      tools.push({
        name,
        tool: tool.name,
        title: readToolTitle(tool.metadata) ?? null,
        description: tool.description,
        shortDescription: readToolShortDescription(tool.metadata) ?? null,
        tier: resolveCapabilityTier(tool.metadata, tool.tags) ?? null,
        inputSchema,
      });
    }
    try {
      await memory.remember(sourceListingOwner(source.id), revisionOf(source), tools);
    } catch {
      warn(`Tool source "${source.id}" listed its tools, but the listing could not be kept.`);
    }
  }

  /**
   * The last listing of `entry` as {@link ToolSourceStanding.lastListing} reports it, with the saved
   * settings as they are now, or `undefined` when none is known for the source as it is saved.
   */
  async function lastListingOf(
    entry: ConfiguredToolSource,
  ): Promise<ToolSourceStanding['lastListing']> {
    const memory = options.listings;
    if (memory === undefined) return undefined;
    const listing = await memory.read(
      sourceListingOwner(entry.source.id),
      revisionOf(entry.source),
    );
    if (listing === undefined) return undefined;
    return {
      listedAt: listing.listedAt,
      truncated: listing.truncated,
      tools: listing.tools.map((tool) => {
        const settings = entry.tools.get(tool.tool);
        // Nothing of it runs: what it shows is what the saved settings would load.
        const acceptsSecrets = settings?.acceptsSecrets === true;
        const enabled = settings?.enabled !== false;
        return {
          name: tool.name,
          tool: tool.tool,
          acceptsSecrets,
          savedAcceptsSecrets: acceptsSecrets,
          enabled,
          savedEnabled: enabled,
          tier: tool.tier,
          ...approvalStanding(settings, tool.tier),
          title: tool.title,
          description: tool.description,
          shortDescription: tool.shortDescription,
          inputSchema: tool.inputSchema,
        };
      }),
    };
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
          oauth: oauthForSource(source, () => undefined),
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
        // A tool the owner turned off (COR-2009) is listed on its source and offered to no agent.
        const enabled = entry.tools.get(tool.name)?.enabled !== false;
        if (enabled) {
          // Every saved source's tool is rebuilt behind this gate, so a retired source's tool cannot
          // run. The rebuild copies the configuration whole, so the loader's version survives it.
          const offered = acceptsSecrets ? withAcceptsSecrets(tool) : tool;
          catalog[name] = refusingWhen(offered, () =>
            retired.has(source.id)
              ? `Tool source "${source.id}" was removed or changed, so this tool no longer runs. Start the host again: a changed source then loads as it now stands, and a removed one is gone.`
              : undefined,
          );
        }
        const tier = resolveCapabilityTier(tool.metadata, tool.tags) ?? null;
        tools.push({
          name,
          tool: tool.name,
          acceptsSecrets,
          savedAcceptsSecrets: acceptsSecrets,
          enabled,
          savedEnabled: enabled,
          tier,
          ...approvalStanding(entry.tools.get(tool.name), tier),
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
      reached.set(source.id, { description, at: now() });
      remember(standingOf(entry, 'loaded', { tools, skipped, unmatchedSettings }));
      await rememberListing(source, loaded.tools);
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
      credentials = await vault.credentialNames(entry.source.id);
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
    identity?: WorkspaceIdentity,
  ): Promise<void> {
    const commandLine = commandLineOf(source);
    try {
      await options.audit({
        runId: auditTrailToolSourceOwnerId(source.id),
        type,
        principal: identity?.owner ?? owner,
        detail: {
          sourceId: source.id,
          kind: source.kind,
          owner: identity?.owner ?? owner,
          ...(identity === undefined
            ? {}
            : {
                workspaceId: identity.workspaceId,
                actorId: identity.actorId,
                membershipRevision: identity.membershipRevision,
              }),
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
  async function isCurrent(
    id: string,
    revision: string,
    snapshot?: ConfigurationSnapshot,
  ): Promise<boolean> {
    try {
      const entry =
        snapshot === undefined
          ? await configured(id)
          : readToolSourcesConfiguration(snapshot.text, location).find(
              (candidate) => candidate.source.id === id,
            );
      return entry !== undefined && revisionOf(entry.source) === revision;
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

  /** Await a conditional write; uncertainty never takes the credential-rollback path. */
  /** Where a source added while the host runs hands its tools: the Bureau's catalog, once it is built. */
  let live: ((tools: Readonly<Record<string, Tool>>) => Promise<void>) | undefined;

  /**
   * Load the configured source `id` now and hand its tools that are on to {@link live} (COR-2009),
   * so they are available without a restart. Answers the change to report, or `undefined` when the
   * host is not live, the source was removed since the host started (its old tools still answer to
   * its names until then), or it is no longer configured: the next start loads it. A source that
   * does not load, or waits for a sign-in, is reported on its own standing and needs no restart.
   */
  async function loadLive(id: string): Promise<ToolSourceChange | undefined> {
    const add = live;
    if (add === undefined || closed || retired.has(id)) return undefined;
    const { sources } = await readDocument();
    const entry = sources.find((candidate) => candidate.source.id === id);
    if (entry === undefined) return undefined;
    await loadOne(entry);
    const standing = booted.get(id)?.standing;
    if (standing === undefined) return undefined;
    if (standing.state !== 'loaded') return { id, changed: true, restartRequired: false };
    const offered = standing.tools.filter((tool) => tool.enabled);
    const tools: Record<string, Tool> = {};
    for (const { name } of offered) {
      const tool = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
      if (tool !== undefined) tools[name] = tool;
    }
    try {
      await add(tools);
    } catch {
      warn(
        `Tool source "${id}" loaded, but its tools could not be offered until the host starts again.`,
      );
      return { id, changed: true, restartRequired: true };
    }
    return {
      id,
      changed: true,
      restartRequired: false,
      available: offered.map(({ name }) => name),
    };
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
      const { sources, revision } = await readDocument();
      const standings = await Promise.all(
        sources.map((entry) => {
          const description = JSON.stringify(entry.source);
          const tested = reached.get(entry.source.id);
          // When the host last reached the source as it is now saved; a source since pointed elsewhere was not.
          const lastTested =
            tested !== undefined && tested.description === description
              ? { lastTested: new Date(tested.at).toISOString() }
              : {};
          const previous = booted.get(entry.source.id);
          if (previous === undefined || previous.description !== description) {
            return standingWithSecrets(entry, {
              ...standingOf(entry, 'pending-restart'),
              ...lastTested,
            });
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
            // The labels as they are now: a change of name or description needs no restart.
            ...labelsOf(entry),
            ...lastTested,
            // The saved settings as they are now, not as they were when the host loaded the source.
            tools: standing.tools.map((tool) => ({
              ...tool,
              savedAcceptsSecrets: entry.tools.get(tool.tool)?.acceptsSecrets === true,
              savedEnabled: entry.tools.get(tool.tool)?.enabled !== false,
              ...approvalStanding(entry.tools.get(tool.tool), tool.tier),
            })),
            unmatchedSettings,
            ...(previous.settings === settingsRevision(entry)
              ? {}
              : { settingsPending: true as const }),
          });
        }),
      );
      // A source that is not loaded shows the tools it listed last (COR-2435); none of them runs.
      const withListings = await Promise.all(
        standings.map(async (standing, index) => {
          const entry = sources[index];
          if (standing.state === 'loaded' || entry === undefined) return standing;
          const lastListing = await lastListingOf(entry);
          return lastListing === undefined ? standing : { ...standing, lastListing };
        }),
      );
      const reason = lockReason();
      return {
        configurationRevision: revision,
        sources: withListings,
        ...(reason === undefined ? {} : { lockReason: reason }),
        ...(hostWriteLocks(bungalow).providerKeys === undefined
          ? {}
          : { credentialLockReason: 'deployment' as const }),
      };
    },
    // The request is checked, as `connect` checks it, before anything is contacted. Nothing is
    // stored, written to the configuration or put in the audit trail, and the vault is read only
    // for a credential an edit left blank, of a source still going to the same place: the
    // credentials live in this call, and a source that answers is closed before it returns.
    async probe(request, input) {
      assertWritable();
      const { id, source } = checkedDescription(request, input?.owner ?? owner);
      const supplied = checkedCredentials(request.credentials, referencedCredentials(source));
      const missing = referencedCredentials(source).filter((name) => !supplied.has(name));
      // Read before the first `await`: the caller owns the request.
      const signInReference = request.signIn;
      if (closed) throw new Error('The host is shutting down.');
      const mutation = input ?? (await createLocalHostMutationContext(bungalow));
      const identity = await assertMutation(mutation, source);
      // One storage for the whole probe: the loader asks for it more than once. A sign-in of this
      // source that succeeded before it is saved lends a copy of its tokens, which a refresh in the
      // probe could not use: the probe admits no token request, and keeps nothing (COR-2436).
      const storage =
        signInReference === undefined
          ? probeTokenStorage()
          : copiedTokenStorage(savedOAuthState(ownedSignIn(signInReference, identity, id, source)));
      // An edit of a saved source may leave a stored credential blank (COR-2436): the probe uses
      // the stored value, as the save would, but only while the source still goes to the same
      // place, so a stored credential is never sent to an address a request just typed.
      if (missing.length > 0) {
        const { sources: savedSources } = await readDocument();
        const saved = savedSources.find((entry) => entry.source.id === id);
        const stored =
          saved !== undefined && recipientOf(saved.source) === recipientOf(source)
            ? await vault.read(id).catch(() => NO_SECRETS)
            : NO_SECRETS;
        for (const name of missing) {
          const value = stored.credentials.get(name);
          if (value === undefined) {
            throw new ToolSourceInputError(
              `credentials.${name}`,
              saved !== undefined && recipientOf(saved.source) !== recipientOf(source)
                ? 'a value is required, because the source now goes somewhere else.'
                : 'a value is required.',
            );
          }
          supplied.set(name, value);
        }
      }
      let loaded: LoadedToolSource;
      try {
        loaded = await within(
          (signal) =>
            loadToolSource(source, {
              resolveCredential: ({ credential }) => supplied.get(credential),
              oauth: {
                tokenStorage: () => storage,
                redirectUrl: (sourceId) => `${options.origin()}${oauthCallbackPath(sourceId)}`,
                onAuthorizationRequired: () => undefined,
                beforeTokenRequest: () => {
                  throw new HostMutationError('forbidden');
                },
              },
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
        return await listedProbe(id, source, loaded.tools, loaded.server);
      } finally {
        await loaded.close().catch(() => undefined);
      }
    },
    // A saved source, loaded as the host loads it, with what the vault holds for it. Nothing is
    // written; the connection is closed before it answers, and the catalog is not touched.
    async test(requestedId, input) {
      const id = checkedIdentifier(requestedId, 'id');
      if (closed) throw new Error('The host is shutting down.');
      const { source } = await configured(id);
      const mutation = input ?? (await createLocalHostMutationContext(bungalow));
      // A local command is run only for whoever may run one, as a probe and a connection are.
      await assertMutation(mutation, source);
      if (RESERVED_TOOL_SOURCE_IDENTIFIERS.includes(id)) {
        return {
          outcome: 'failed' as const,
          message: `The identifier "${id}" is reserved for the host's own tools, so this source is not loaded. Remove it.`,
        };
      }
      const description = JSON.stringify(source);
      try {
        // No tokens: contacting the server would begin a sign-in nobody is waiting for.
        if (isOAuth(source)) {
          const stored = await vault.read(id);
          if (stored.oauth?.tokens === undefined) {
            return { outcome: 'needs-authorization' as const };
          }
        }
      } catch (error) {
        return { outcome: 'failed' as const, message: describeFailure(error) };
      }
      let loaded: LoadedToolSource;
      try {
        loaded = await within(
          (signal) =>
            loadToolSource(source, {
              // The credentials of the source as it is saved now, and only while it still goes to
              // the place this test reaches: an edit made meanwhile does not send them elsewhere.
              resolveCredential: async (request) => {
                const snapshot = await readDocument();
                const current = snapshot.sources.find(
                  (entry) => entry.source.id === request.sourceId,
                );
                if (current === undefined || recipientOf(current.source) !== recipientOf(source)) {
                  return undefined;
                }
                return resolveCredential(request, snapshot);
              },
              oauth: oauthForSource(source, () => undefined),
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
        const listed = await listedProbe(id, source, loaded.tools, loaded.server);
        // Stamped with the description reached: `snapshot` reports it only while that is the one saved.
        reached.set(id, { description, at: now() });
        await rememberListing(source, loaded.tools);
        return listed;
      } finally {
        await loaded.close().catch(() => undefined);
      }
    },
    // The request is read, checked, and copied before the first `await`: the caller owns it, and
    // may change it while this waits its turn.
    async connect(request, input) {
      assertWritable();
      const { id, source } = checkedDescription(request, input?.owner ?? owner);
      const referenced = referencedCredentials(source);
      const supplied = checkedCredentials(request.credentials, referenced);
      const createOnly = request.createOnly === true;
      const incomingTools =
        request.tools === undefined ? undefined : checkedToolSettings(request.tools);
      const labels = checkedLabels(request);
      // Read before the first `await`, as the rest of the request is: the caller owns it.
      const signInReference = request.signIn;
      // Set inside the source's turn: whether this connection added the source, which is loaded at once.
      let added = false;
      const change = await serialized(() =>
        vault.exclusive(id, async () => {
          const mutation = input ?? (await createLocalHostMutationContext(bungalow));
          let identity = await assertMutation(mutation, source);
          const { revision, document, sources } = await readDocument();
          const existing = sources.find((entry) => entry.source.id === id);
          const operationId = mutation.operationIdFor('tool-source-connect', id);
          const priorOperation = await bungalow.secretProvider.getOperation(operationId);
          if (createOnly && existing !== undefined && priorOperation === undefined) {
            throw new ToolSourceExistsError(id);
          }
          // A sign-in made before the source was saved (COR-2436) is taken from the host by
          // reference, for its owner, for this description, once: only a source this request
          // adds, or a retry of the same save, may take it.
          const pendingSignIn =
            signInReference === undefined
              ? undefined
              : ownedSignIn(signInReference, identity, id, source, operationId);
          if (pendingSignIn !== undefined) {
            if (!isOAuth(source)) {
              throw new ToolSourceInputError('signIn', 'the source does not sign in with OAuth.');
            }
            if (existing !== undefined && priorOperation === undefined) {
              throw new ToolSourceInputError(
                'signIn',
                'the source is already saved. Sign in from its page instead.',
              );
            }
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
          // Settings the request names replace them (COR-2009: a tool left off when it is added).
          const tools =
            incomingTools !== undefined
              ? new Map(
                  [...incomingTools].flatMap(([name, settings]) => {
                    const kept = nonDefaultSettings(mergedSettings(undefined, settings));
                    return kept === undefined ? [] : [[name, kept] as const];
                  }),
                )
              : sameRecipient && existing !== undefined
                ? existing.tools
                : new Map<string, ConfiguredToolSettings>();
          // A label the request leaves out is kept, whatever the source now points at: it names, and grants nothing.
          const name = labels.name ?? existing?.name;
          const description =
            labels.description === null ? undefined : (labels.description ?? existing?.description);
          const next: ConfiguredToolSource = {
            source,
            tools,
            ...(name === undefined ? {} : { name }),
            ...(description === undefined ? {} : { description }),
          };
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
          // The whole entry as it would be written: a request that changes only a label or a
          // Default asks level is a change, which `settingsRevision` alone would miss (COR-2022).
          const unchanged =
            existing !== undefined &&
            JSON.stringify(serializeToolSources([existing])) ===
              JSON.stringify(serializeToolSources([next])) &&
            supplied.size === 0 &&
            // A secret that cannot be read is replaced by this request, even one that names no credential.
            !unreadable;
          if (unchanged && priorOperation === undefined)
            return { id, changed: false, restartRequired: true };

          // Fence the old recipient before activation; credentials and description commit together.
          const fences = existing !== undefined && !sameRecipient && !retired.has(id);
          if (fences) retired.add(id);
          try {
            const publication = await vault.write(
              id,
              pendingSignIn !== undefined
                ? {
                    // The tokens and client the sign-in got, bound to the administrator who
                    // signed in, as a sign-in of a saved source leaves them; never its one-use
                    // state or verifier.
                    credentials,
                    oauth: savedOAuthState(pendingSignIn),
                    signIn: undefined,
                    oauthBinding: pendingSignIn.binding,
                    oauthClaim: undefined,
                  }
                : {
                    credentials,
                    oauth: keepsSignIn ? previous.oauth : undefined,
                    signIn: keepsSignIn ? previous.signIn : undefined,
                    oauthBinding: keepsSignIn ? previous.oauthBinding : undefined,
                    oauthClaim: keepsSignIn ? previous.oauthClaim : undefined,
                  },
              { text, revision: mutation.expectedRevision },
              async () => {
                identity = await assertMutation(mutation, source);
              },
              {
                operationId,
                requestDigest: secretPublicationDigest({
                  operation: 'tool-source-connect',
                  target: id,
                  expectedRevision: mutation.expectedRevision,
                  payload: {
                    source,
                    credentials: Object.fromEntries(supplied),
                    createOnly,
                    tools:
                      incomingTools === undefined ? undefined : Object.fromEntries(incomingTools),
                    // A retry that names other labels is another request, not a replay of this one.
                    name: labels.name,
                    description: labels.description,
                    // The sign-in taken, by reference: a retry that names another is another request.
                    signIn: pendingSignIn?.id,
                  },
                }),
              },
            );
            // Taken once the save holds it: a retry of this same save may take it again.
            if (pendingSignIn !== undefined) pendingSignIn.consumedBy = operationId;
            if (publication.publishedNow !== true) {
              if (fences) retired.delete(id);
              return { id, changed: false, restartRequired: true };
            }
          } catch (error) {
            // No compensation writes. A definite unchanged configuration can safely lift the fence.
            const standing = await bungalow.readConfiguration();
            if (
              fences &&
              error instanceof SecretPublicationError &&
              error.definitelyRejected &&
              standing.revision === revision
            )
              retired.delete(id);
            throw error;
          }
          await record('tool.source.connected', source, { revoked }, undefined, identity);
          added = existing === undefined;
          return { id, changed: true, restartRequired: true };
        }),
      );
      // Loaded after the source's turn is over, because loading reads its credentials in a turn of its own.
      return added ? ((await loadLive(id)) ?? change) : change;
    },
    goLive(add) {
      live = add;
    },
    async configureTools(request, input) {
      assertWritable();
      const id = checkedIdentifier(request.id, 'id');
      const incoming = checkedToolSettings(request.tools);
      return serialized(async () => {
        const mutation = input ?? (await createLocalHostMutationContext(bungalow));
        let identity = await assertMutation(mutation);
        const { text: currentText, document, sources } = await readDocument();
        const existing = sources.find((entry) => entry.source.id === id);
        if (existing === undefined) {
          throw new ToolSourceInputError('source', 'not a configured source.', 'unknown-source');
        }
        const tools = new Map(existing.tools);
        for (const [name, change] of incoming) {
          // A field the request leaves out keeps its saved value (COR-2022), and the default is no
          // entry at all, so a tool set back to it leaves nothing behind.
          const kept = nonDefaultSettings(mergedSettings(tools.get(name), change));
          if (kept === undefined) tools.delete(name);
          else tools.set(name, kept);
        }
        // The rest of the entry, its labels among them, is the one saved.
        const next: ConfiguredToolSource = { ...existing, tools };
        const nextSources = sources.map((entry) => (entry === existing ? next : entry));
        const nextDocument = { ...document, toolSources: serializeToolSources(nextSources) };
        const text = `${JSON.stringify(nextDocument, null, 2)}\n`;
        // The same checks the next start applies, before a byte is written.
        parseProviderConfiguration(text, location);
        parseToolSourcesConfiguration(nextDocument.toolSources, location);
        if (text === currentText) return { id, changed: false, restartRequired: true };
        identity = await assertMutation(mutation, existing.source);
        const publication = await bungalow.writeConfiguration(text, {
          expectedRevision: mutation.expectedRevision,
        });
        if (publication.outcome !== 'committed')
          throw new SecretPublicationError(publication.outcome);
        const before = new Set(acceptingTools(existing.tools));
        const after = new Set(acceptingTools(tools));
        await record(
          'tool.source.tools-configured',
          existing.source,
          {
            granted: [...after].filter((name) => !before.has(name)).sort(),
            revoked: [...before].filter((name) => !after.has(name)).sort(),
          },
          undefined,
          identity,
        );
        return { id, changed: true, restartRequired: true };
      });
    },
    async remove(request, input) {
      assertWritable();
      const id = checkedIdentifier(request.id, 'id');
      return serialized(() =>
        vault.exclusive(id, async () => {
          const mutation = input ?? (await createLocalHostMutationContext(bungalow));
          let identity = await assertMutation(mutation);
          const operationId = mutation.operationIdFor('tool-source-remove', id);
          const receipt = {
            operationId,
            requestDigest: secretPublicationDigest({
              operation: 'tool-source-remove',
              target: id,
              expectedRevision: mutation.expectedRevision,
              payload: {},
            }),
          };
          const { document, sources } = await readDocument();
          const existing = sources.find((entry) => entry.source.id === id);
          if (existing === undefined) {
            const prior = await bungalow.secretProvider.getOperation(operationId);
            if (prior !== undefined && prior.state !== 'prepared') {
              await vault.clear(
                id,
                { text: JSON.stringify(document), revision: mutation.expectedRevision },
                async () => {
                  await assertMutation(mutation);
                },
                receipt,
              );
              return { id, changed: false, restartRequired: true, affectedAgents: [] };
            }
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
          const publication = await vault.clear(
            id,
            { text, revision: mutation.expectedRevision },
            async () => {
              identity = await assertMutation(mutation);
            },
            receipt,
          );
          if (publication.publishedNow !== true)
            return { id, changed: false, restartRequired: true, affectedAgents: affected };
          retired.add(id);
          booted.delete(id);
          // A source added later under this id starts with no listing: its revision would not
          // match anyway, so a failure to forget only leaves an unreadable record behind.
          await options.listings?.forget(sourceListingOwner(id)).catch(() => undefined);
          // Its connection was opened with credentials a removal cannot take back (a local command
          // got them in its environment), so it is closed: the tools fail until the next start.
          const connection = loadedById.get(id);
          if (connection !== undefined) {
            loadedById.delete(id);
            loadedSources.splice(loadedSources.indexOf(connection), 1);
            await connection.close().catch(() => undefined);
          }
          await record('tool.source.removed', existing.source, {}, affected, identity);
          return { id, changed: true, restartRequired: true, affectedAgents: affected };
        }),
      );
    },
    async editing(rawId, input) {
      assertWritable();
      const id = checkedIdentifier(rawId, 'id');
      // Who asks is checked before the source is looked up, so a caller who may not change
      // sources learns nothing of which exist.
      const mutation = input ?? (await createLocalHostMutationContext(bungalow));
      await assertMutation(mutation);
      const { sources, revision } = await readDocument();
      const entry = sources.find((candidate) => candidate.source.id === id);
      if (entry === undefined) {
        throw new ToolSourceInputError('source', 'not a configured source.', 'unknown-source');
      }
      const reason = notEditableReason(entry.source);
      if (reason !== undefined) throw new ToolSourceNotEditableError(reason);
      let credentials: readonly string[] = [];
      try {
        credentials = await vault.credentialNames(id);
      } catch {
        // Unreadable credentials read as none: the page then asks for every one again.
      }
      return {
        id,
        source: entry.source,
        name: entry.name ?? null,
        description: entry.description ?? null,
        credentials,
        configurationRevision: revision,
      };
    },
    async affectedAgents(rawId) {
      const id = checkedIdentifier(rawId, 'id');
      await configured(id);
      return { id, tools: loadedToolNames(id).toSorted(), affectedAgents: await agentsUsing(id) };
    },
    async authorize(rawId, input) {
      assertWritable();
      const mutation = input ?? (await createLocalHostMutationContext(bungalow));
      await mutation.revalidate();
      const id = checkedIdentifier(rawId, 'source');
      const entry = await configured(id);
      if (!isOAuth(entry.source)) {
        throw new ToolSourceInputError('source', 'does not sign in with OAuth.');
      }
      const revision = revisionOf(entry.source);
      const binding = await oauthAuthority.begin(id, revision, mutation);
      const waiting = await vault.read(id);
      if (
        waiting.oauthBinding?.flowId === binding.flowId &&
        waiting.signIn?.authorizationUrl !== undefined &&
        waiting.oauth?.state !== undefined
      ) {
        const elapsed = now() - waiting.signIn.startedAt;
        if (
          waiting.signIn.revision !== revision ||
          !(elapsed >= 0 && elapsed <= SIGN_IN_TIME_TO_LIVE_MILLISECONDS)
        )
          throw new ToolSourceInputError(
            'source',
            'the sign-in has expired or changed. Start a new operation.',
          );
        return { authorized: false, authorizationUrl: waiting.signIn.authorizationUrl };
      }
      let authorizationUrl: URL | undefined;
      try {
        const loaded = await within((signal) =>
          loadToolSource(entry.source, {
            resolveCredential,
            oauth: oauthForSource(
              entry.source,
              (_sourceId, url) => {
                authorizationUrl = url;
              },
              'take',
              binding,
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
        await assertCurrent(id, revision);
        if (
          error instanceof ToolSourceAuthorizationRequiredError &&
          authorizationUrl !== undefined
        ) {
          // The sign-in is good for this description and for a while: the callback checks both.
          await oauthAuthority.recordSignIn(
            id,
            binding,
            { startedAt: now(), revision, authorizationUrl: authorizationUrl.href },
            (snapshot) => isCurrent(id, revision, snapshot),
          );
          return { authorized: false, authorizationUrl: authorizationUrl.href };
        }
        if (error instanceof HostMutationError) throw error;
        throw new ToolSourceInputError('source', 'the sign-in could not be started.');
      }
    },
    // Taken in turn with every other change to the configuration and to this source's secret: a
    // removal or a change that arrives during the token exchange waits for it, and one that came
    // first is seen here, so the tokens are never written for a source that is gone or different.
    // A sign-in for a source that is not saved (COR-2436). Nothing is written: the record lives in
    // memory, for its owner, until a save takes it or it expires.
    async beginSignIn(request, input) {
      assertWritable();
      const { id, source } = checkedDescription(request, input?.owner ?? owner);
      const openerOrigin = checkedOrigin(request.openerOrigin);
      if (!isOAuth(source))
        throw new ToolSourceInputError('source', 'does not sign in with OAuth.');
      if (closed) throw new Error('The host is shutting down.');
      const mutation = input ?? (await createLocalHostMutationContext(bungalow));
      await assertMutation(mutation, source);
      // A saved source signs in from its own page, with the sign-in the vault keeps.
      const { sources } = await readDocument();
      if (sources.some((entry) => entry.source.id === id)) throw new ToolSourceExistsError(id);
      const binding: ToolSourceOAuthBinding = {
        workspaceId: mutation.workspaceId,
        actorId: mutation.actorId,
        owner: mutation.owner,
        flowId: mutation.operationIdFor('tool-source-pending-sign-in', id),
      };
      // Only an administrator who may manage the workspace starts one, as for a saved source.
      await oauthAuthority.identity(binding);
      const pending: PendingSignIn = {
        id: randomToken(),
        sourceId: id,
        source,
        revision: revisionOf(source),
        binding,
        openerOrigin,
        startedAt: now(),
        state: randomToken(),
        storage: {},
        outcome: 'waiting',
        callbackTaken: false,
        exchanged: false,
      };
      // The state the authorization URL carries is the host's: Armorer reads a stored one first.
      pending.storage = { state: pending.state };
      let authorizationUrl: URL | undefined;
      try {
        const loaded = await within(
          (signal) =>
            loadToolSource(source, {
              resolveCredential: () => undefined,
              oauth: {
                tokenStorage: () => pendingTokenStorage(pending),
                redirectUrl: (sourceId) => `${options.origin()}${oauthCallbackPath(sourceId)}`,
                onAuthorizationRequired: (_sourceId, url) => {
                  authorizationUrl = url;
                },
                // Starting a sign-in exchanges nothing.
                beforeTokenRequest: () => {
                  throw new HostMutationError('forbidden');
                },
              },
              signal,
              ...fetchOption,
            }),
          probeTimeout,
        );
        await loaded.close().catch(() => undefined);
        return { authorized: true };
      } catch (error) {
        if (error instanceof HostMutationError) throw error;
        if (
          !(error instanceof ToolSourceAuthorizationRequiredError) ||
          authorizationUrl === undefined ||
          authorizationUrl.searchParams.get('state') !== pending.state
        ) {
          throw new ToolSourceInputError('source', 'the sign-in could not be started.');
        }
      }
      pendingSignIns.add(pending);
      return { authorized: false, signIn: pending.id, authorizationUrl: authorizationUrl.href };
    },
    async pendingSignIn(raw, input) {
      const mutation = input ?? (await createLocalHostMutationContext(bungalow));
      const identity = await assertMutation(mutation);
      const pending = typeof raw === 'string' ? pendingSignIns.get(raw) : undefined;
      // Someone else's sign-in reads as none.
      if (pending === undefined || !sameOwner(pending.binding, identity)) {
        throw new ToolSourceInputError('signIn', 'no such sign-in.', 'unknown-source');
      }
      if (
        pending.outcome === 'waiting' &&
        !pending.callbackTaken &&
        !(now() - pending.startedAt <= SIGN_IN_TIME_TO_LIVE_MILLISECONDS)
      ) {
        pending.outcome = 'expired';
        pending.reason = 'expired';
      }
      return {
        signIn: pending.id,
        outcome: pending.outcome,
        ...(pending.reason === undefined ? {} : { reason: pending.reason }),
      };
    },
    async completePendingSignIn(rawId, callbackUrl) {
      const id = checkedIdentifier(rawId, 'source');
      let parameters: URLSearchParams;
      try {
        parameters = new URL(callbackUrl).searchParams;
      } catch {
        return undefined;
      }
      const states = parameters.getAll('state');
      if (states.length !== 1 || states[0] === undefined || states[0] === '') return undefined;
      const pending = pendingSignIns.byState(id, states[0]);
      if (pending === undefined) return undefined;
      const answer = (): ToolSourcePendingCallback => ({
        signIn: pending.id,
        outcome: pending.outcome,
        ...(pending.reason === undefined ? {} : { reason: pending.reason }),
        openerOrigin: pending.openerOrigin,
      });
      // One callback settles a sign-in: a second one, even while the first is still exchanging,
      // is refused and changes nothing. Taken before the first `await`, so two cannot both pass.
      if (pending.outcome !== 'waiting' || pending.callbackTaken) {
        return {
          signIn: pending.id,
          outcome: 'refused',
          reason: 'used',
          openerOrigin: pending.openerOrigin,
        };
      }
      pending.callbackTaken = true;
      const settle = (outcome: PendingSignInOutcome, reason?: PendingSignInReason) => {
        pending.outcome = outcome;
        if (reason === undefined) delete pending.reason;
        else pending.reason = reason;
        pending.settledAt = now();
        // The one-use state and verifier go with the settling, whatever it was.
        const { state: _state, codeVerifier: _verifier, ...kept } = pending.storage;
        pending.storage = kept;
        return answer();
      };
      if (!(now() - pending.startedAt <= SIGN_IN_TIME_TO_LIVE_MILLISECONDS)) {
        return settle('expired', 'expired');
      }
      const error = parameters.get('error');
      if (error !== null) {
        // The provider's own words are never repeated: only its code, read into a closed set.
        const { outcome, reason } = providerReason(error);
        return settle(outcome, reason);
      }
      try {
        // The administrator who started it must still manage the workspace.
        await oauthAuthority.identity(pending.binding);
      } catch {
        return settle('refused', 'not-allowed');
      }
      const description = pending.source;
      const controller = new AbortController();
      const cancel = schedule(() => controller.abort(), timeout);
      const baseFetch = options.fetch ?? fetch;
      const bounded: typeof fetch = Object.assign(
        (address: RequestInfo | URL, init?: RequestInit) =>
          baseFetch(address, {
            ...init,
            signal:
              init?.signal === undefined || init.signal === null
                ? controller.signal
                : AbortSignal.any([init.signal, controller.signal]),
          }),
        baseFetch,
      );
      try {
        await completeToolSourceAuthorization(description, {
          oauth: {
            tokenStorage: () => pendingTokenStorage(pending),
            redirectUrl: (sourceId) => `${options.origin()}${oauthCallbackPath(sourceId)}`,
            onAuthorizationRequired: () => undefined,
            // One authorization-code exchange, once: no refresh, no second code.
            beforeTokenRequest: (_sourceId, tokenRequest) => {
              if (pending.exchanged || tokenRequest.grantType !== 'authorization_code') {
                throw new HostMutationError('forbidden');
              }
              pending.exchanged = true;
            },
          },
          callbackUrl,
          fetch: bounded,
        });
      } catch {
        // Nothing from the failure is repeated: it may hold a URL, a code, or the server's words.
        return settle('refused', 'exchange-failed');
      } finally {
        cancel();
      }
      return settle(
        pending.storage.tokens === undefined ? 'refused' : 'succeeded',
        pending.storage.tokens === undefined ? 'exchange-failed' : undefined,
      );
    },
    async completeAuthorization(rawId, callbackUrl, input) {
      assertWritable();
      const id = checkedIdentifier(rawId, 'source');
      const change = await serialized(() =>
        vault.exclusive(id, async () => {
          const entry = await configured(id);
          if (!isOAuth(entry.source)) {
            throw new ToolSourceInputError('source', 'does not sign in with OAuth.');
          }
          const { oauth: waiting, signIn, oauthBinding } = await vault.read(id);
          if (
            oauthBinding === undefined ||
            (input !== undefined &&
              (oauthBinding.workspaceId !== input.workspaceId ||
                oauthBinding.actorId !== input.actorId ||
                oauthBinding.owner !== input.owner))
          )
            throw new HostMutationError('forbidden');
          // Armorer skips the `state` check when none was recorded, so a callback with no flow in
          // progress is refused here before it can reach the token endpoint.
          if (
            waiting?.state === undefined ||
            waiting.codeVerifier === undefined ||
            signIn === undefined
          ) {
            throw new ToolSourceInputError('callback', 'no sign-in is waiting for this source.');
          }
          const parameters = new URL(callbackUrl).searchParams;
          if (parameters.getAll('state').length !== 1 || parameters.get('state') !== waiting.state)
            throw new ToolSourceInputError('callback', 'the sign-in state is invalid.');
          const identity = await oauthAuthority.identity(oauthBinding);
          if (input !== undefined) await input.revalidate();
          // This call holds the source's turn, so the loader's storage must not wait for it.
          const oauth = oauthForSource(entry.source, () => undefined, 'held', oauthBinding);
          const storage = oauth.tokenStorage(id);
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
            (address: RequestInfo | URL, init?: RequestInit) =>
              baseFetch(address, {
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
              oauth,
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
          await record('tool.source.authorized', entry.source, {}, undefined, identity);
          return { id, changed: true, restartRequired: true };
        }),
      );
      // A source that waited for its first sign-in has loaded nothing yet: it loads now (COR-2009).
      const standing = booted.get(id)?.standing.state;
      return standing === undefined || standing === 'needs-authorization'
        ? ((await loadLive(id)) ?? change)
        : change;
    },
    async close() {
      closed = true;
      // A source still connecting holds a child process or a socket nobody is waiting for.
      for (const controller of loading) controller.abort();
      await Promise.allSettled(startedSources().map((loaded) => loaded.close()));
    },
  };
}
