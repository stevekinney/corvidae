/**
 * The host's executable skills while it runs (COR-1818): the catalog it discovered from the
 * `skills` sources in `configuration.json`, and the one way a person changes it, which is deciding
 * whether a source is trusted.
 *
 * - **Discovered by the host.** The host reads the configured directories, trusts exactly the
 *   sources `skills.trusted` lists (`trustPolicyOf`), and hands the catalog to Bureau's handler for
 *   `bureau.skills.list`. A skill from an untrusted source is listed and cannot be activated: the
 *   skill client answers `source-untrusted`.
 * - **A trust change is a configuration write.** {@link SkillManager.setTrust} changes
 *   `skills.trusted` in `configuration.json` through the queue every writer of the file shares
 *   (`configuration-queue.ts`), reads the result back through the same checks the next start
 *   applies, discovers the catalog again, and then records the change in the audit trail as
 *   `skill.source.trusted` or `skill.source.untrusted`, filed under `skill-source:<id>` and made
 *   by the owner. A change that changes nothing writes and records nothing, unless an earlier
 *   change to that source was applied and could not be recorded (below).
 * - **A change that could not be recorded is retried.** When the audit write fails, the change
 *   stands and {@link SkillAuditError} reports it, naming the trust that was asked for. The manager
 *   keeps the entry with the time of the change, in memory only (it does not survive a restart).
 *   Every later request for that source applies its own change first, so a trail that is down never
 *   stops a source from being revoked, and then records what is owed in order. The same request
 *   again answers `changed: false` once the record is made, and {@link SkillAuditError} again while
 *   the trail is still failing.
 * - **A failed write is read back.** When `writeConfiguration` throws, the file may still have been
 *   replaced (Bungalow renames it, then syncs the directory), so the manager reads the file back
 *   and serves what a restart would. A write that did not take is reported as the original failure.
 *   One that did take is a change like any other: it is recorded, or owed to the trail if that
 *   fails.
 * - **Explicit write capability.** Read-only backends refuse changes. Trusting filesystem skill
 *   sources requires current deployment authority immediately before the configuration CAS.
 * - **Watched while the host runs (COR-2100).** Every local source's directory (the configured ones
 *   and each running plugin's `content/skills`) is watched with a recursive `fs.watch`, which is
 *   only a trigger, and rescanned every {@link DIRECTORY_POLL_INTERVAL_MILLISECONDS} whether or not
 *   a native event arrived: `watch` follows the host's `directoryWatch`, `true` arming both, `'poll'`
 *   the rescan alone, `false` neither. A rescan is a {@link SkillManager.refresh} that keeps its
 *   catalog and revision when the digest is the same, so each poll re-reads `configuration.json`
 *   and the running plugins, and a hand edit of `skills.trusted` takes effect within a poll without
 *   an audit record (as it already did at the next refresh). One rescan runs at a time; a burst of
 *   events is one more. After each discovery the directories are watched again, so a plugin that
 *   started, or a root made after the host did, is picked up.
 * - **Changes are announced after the catalog is replaced.** {@link SkillManagerOptions.onChange}
 *   hears the names a discovery added, changed, removed and rejected (`diffSkillCatalogs`), once
 *   `standing()` already answers the new catalog, so a run started on the report binds the new
 *   revision. The first discovery is a baseline and is not announced; an empty difference is not
 *   announced; a refresh and a trust change are announced like a rescan.
 * - **A catalog is replaced, never edited.** Each discovery makes a new revision. A skill client
 *   offers the revision it was built with and, given `currentCatalog` (COR-1926), checks a skill
 *   against the current catalog when the skill is used. A file agent that lists `skills`
 *   (COR-1975) gets a skill client per run: Bureau reads `standing` for the revision the run is
 *   bound to, for that check, and when a write grants a skill. The manager needs the Bureau, and
 *   Bureau recovers durable runs before `createBureau` returns, so a run recovered then reads
 *   {@link discoverFirstSkills} instead, or it would find no catalog and lose the skills it held.
 *
 * @module skill-manager
 */

import type { Bungalow } from '@lostgradient/bungalow';
import {
  auditTrailSkillSourceOwnerId,
  type SettingLockReason,
  type SkillSourceStanding,
  type SkillsStanding,
} from '@lostgradient/bureau';
import {
  diffSkillCatalogs,
  discoverSkills,
  type SkillCatalogChange,
  type SkillCatalogRevision,
  type SkillSource,
  type SkillSourceKind,
} from '@lostgradient/bureau/skills';
import {
  DIRECTORY_POLL_INTERVAL_MILLISECONDS,
  type DirectoryWatchMode,
} from '@lostgradient/bureau/sources';
import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/operative';
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';

import { createConfigurationQueue, type ConfigurationQueue } from './configuration-queue.ts';
import {
  createLocalHostMutationContext,
  HostMutationError,
  type HostMutationContext,
} from './host-mutation-context.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { parseProviderConfiguration } from './providers.ts';
import {
  parseSkillsConfiguration,
  readSkillsConfiguration,
  toSkillSources,
  trustPolicyOf,
  type SkillsConfiguration,
} from './skills-configuration.ts';
import { SecretPublicationError } from './workspace-secrets.ts';

/**
 * Which kinds of skill source live in a directory on this machine, and so can be watched with
 * `fs.watch`. A table keyed by the kind, not a comparison against a name, so a new kind of source
 * does not compile until it says whether it has a directory (COR-2468, `home-branches.test.ts`).
 */
const WATCHED_SOURCE_KINDS: Readonly<Record<SkillSourceKind, boolean>> = {
  project: true,
  user: true,
  'built-in': true,
  plugin: true,
  remote: false,
  storage: false,
};

/** A write the home does not allow: the reason is the one `settings.get` reports for a locked key. */
export class SkillWriteLockedError extends Error {
  /** Why the write is refused. A remote home is `deployment`: the deployment, not the host, holds the file. */
  readonly reason: SettingLockReason;

  constructor(reason: SettingLockReason) {
    super(
      'This host runs on remote storage, where the skill configuration belongs to the deployment. Change it there; the host cannot write it.',
    );
    this.name = 'SkillWriteLockedError';
    this.reason = reason;
  }
}

/** A request the host cannot act on. The message names the field and never repeats its value. */
export class SkillInputError extends Error {
  /** The field of the request that cannot be used. */
  readonly field: string;
  /** `source` when the request names a source the configuration does not list. */
  readonly kind: 'invalid' | 'unknown-source';

  constructor(field: string, problem: string, kind: 'invalid' | 'unknown-source' = 'invalid') {
    super(`Invalid ${field}: ${problem}`);
    this.name = 'SkillInputError';
    this.field = field;
    this.kind = kind;
  }
}

/**
 * A trust change that was written to the configuration and applied, but could not be recorded in
 * the audit trail. The change stands; the record is what is missing.
 */
export class SkillAuditError extends Error {
  /** The source whose trust changed. */
  readonly sourceId: string;
  /** Whether the source is trusted now. */
  readonly trusted: boolean;

  constructor(sourceId: string, trusted: boolean) {
    super(
      `The trust of source "${sourceId}" was changed to ${trusted ? 'trusted' : 'untrusted'} and applied, but the change could not be recorded in the audit trail.`,
    );
    this.name = 'SkillAuditError';
    this.sourceId = sourceId;
    this.trusted = trusted;
  }
}

/** What a trust change asks for. */
export type SkillTrustRequest = {
  /** The identifier of a configured source. Typed `unknown` because it arrives from a request: the manager checks it. */
  readonly source: unknown;
  /** Whether the source is to be trusted. Typed `unknown` for the same reason. */
  readonly trusted: unknown;
};

/** What a trust change reports. */
export type SkillTrustChange = {
  /** The source the request named. */
  readonly source: string;
  /** Whether the source is trusted now. */
  readonly trusted: boolean;
  /** False when the source already had the trust asked for, so nothing was written or recorded. */
  readonly changed: boolean;
  /** The revision of the catalog after the change. */
  readonly revision: number;
};

/** One record the manager writes to the audit trail. */
export type SkillAuditEntry = {
  /** The synthetic resource the record is filed under, `skill-source:<id>`. */
  readonly runId: string;
  /** `skill.source.trusted` or `skill.source.untrusted`. */
  readonly type: 'skill.source.trusted' | 'skill.source.untrusted';
  /** The owner who made the change. */
  readonly principal: string;
  /** When the change was made, in milliseconds, so a record retried later keeps its own time. */
  readonly timestampMs: number;
  /** The source, the decision, and the owner. */
  readonly detail: { readonly sourceId: string; readonly trusted: boolean; readonly owner: string };
};

/** The skills a running host offers and how their trust changes. See the module comment. */
export type SkillManager = {
  /** What the host discovered and decided now. Read it at the moment of use, not once: a change replaces it. */
  standing(): SkillsStanding;
  /** Why a trust change is refused, or `undefined` when it is allowed. */
  lockReason(): SettingLockReason | undefined;
  /** Decide whether a configured source is trusted, write the decision, apply it, and record it. */
  setTrust(request: SkillTrustRequest, mutation?: HostMutationContext): Promise<SkillTrustChange>;
  /** Read the configuration again and discover the catalog again, for a person who edited the file or a directory by hand. */
  refresh(): Promise<{ readonly revision: number }>;
  /** Refuse every later change. The host calls it as it shuts down. */
  close(): void;
};

/** What {@link createSkillManager} reads. */
export type SkillManagerOptions = {
  /** The open home. Its mode decides whether a write is allowed. */
  readonly bungalow: Pick<
    Bungalow,
    | 'mode'
    | 'workspaceId'
    | 'configurationLocation'
    | 'readConfiguration'
    | 'writeConfiguration'
    | 'configurationWriteCapability'
  >;
  /** The queue every writer of `configuration.json` shares. Defaults to a new one. */
  readonly configurationQueue?: ConfigurationQueue;
  /**
   * Appends one record to the audit trail; resolves without writing when the Bureau keeps none.
   * It must reject when the record cannot be written, so the manager can report and retry it.
   */
  readonly audit: (entry: SkillAuditEntry) => Promise<void>;
  /**
   * The skill sources the running plugins ship (COR-1977), read on every discovery so a plugin that
   * stopped running is no longer offered. They are trusted by kind and are not configurable. Defaults to none.
   */
  readonly pluginSources?: () => readonly SkillSource[] | Promise<readonly SkillSource[]>;
  /** The owner a change is made by. Defaults to the local owner, the one principal of a single-user host. */
  readonly owner?: string;
  /** The clock a change is stamped with, in milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * COR-2100 — how the skill directories are watched: `true` (the default) arms a recursive
   * `fs.watch` on each local source and a rescan every {@link DIRECTORY_POLL_INTERVAL_MILLISECONDS},
   * `'poll'` the rescan alone, `false` neither, which leaves reloading to `refresh()`. The host passes
   * its `directoryWatch`.
   */
  readonly watch?: DirectoryWatchMode;
  /** Reports a failure the manager can only report: a rescan that failed, a watcher that could not be opened. Defaults to the console. */
  readonly warn?: (message: string, cause?: unknown) => void;
  /** The runtime whose timers drive the rescan, so a test advances it by hand. Defaults to the real one. */
  readonly runtime?: RuntimeServices;
  /**
   * COR-2100 — told what each discovery after the first added, changed, removed and rejected, by
   * name, once `standing()` answers the new catalog. Never called with an empty difference.
   */
  readonly onChange?: (change: SkillCatalogChange) => void;
  /** Opens a recursive native watcher on a directory. Defaults to `fs.watch` that does not keep the process alive. */
  readonly openWatcher?: (
    path: string,
    listener: (event: string, filename: string | null) => void,
  ) => FSWatcher;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The catalog the configuration describes, discovered before the Bureau exists. It serves only the
 * window until {@link createSkillManager} has a catalog of its own, in which the runs Bureau
 * recovers at boot are composed. `pluginSources` are what the plugins that are to run will ship.
 */
export async function discoverFirstSkills(
  options: Pick<SkillManagerOptions, 'bungalow' | 'pluginSources'>,
): Promise<SkillCatalogRevision> {
  const { bungalow } = options;
  const location = bungalow.configurationLocation;
  let text: string | undefined;
  try {
    const snapshot = await bungalow.readConfiguration();
    text = snapshot.text;
  } catch {
    throw new ProviderConfigurationError(location, 'the file', 'it could not be read.');
  }
  const configuration = readSkillsConfiguration(text, location);
  return discoverSkills({
    sources: [...toSkillSources(configuration), ...((await options.pluginSources?.()) ?? [])],
    trustPolicy: trustPolicyOf(configuration),
  });
}

/** Create the manager and discover the first catalog from the configuration as it is now. */
export async function createSkillManager(options: SkillManagerOptions): Promise<SkillManager> {
  const { bungalow } = options;
  const location = bungalow.configurationLocation;
  const now = options.now ?? Date.now;
  const configurationQueue = options.configurationQueue ?? createConfigurationQueue();
  let closed = false;
  let current: SkillsStanding | undefined;
  /** Changes that were applied and not recorded, oldest first. In memory: a restart drops them. */
  const unrecorded: SkillAuditEntry[] = [];

  const lockReason = (): SettingLockReason | undefined =>
    bungalow.configurationWriteCapability === 'writable' ? undefined : 'deployment';
  const serialized = <Result>(work: () => Promise<Result>): Promise<Result> =>
    configurationQueue.run(() => {
      if (closed) throw new Error('The host is shutting down.');
      return work();
    });

  async function readText(): Promise<string | undefined> {
    try {
      const snapshot = await bungalow.readConfiguration();
      return snapshot.text;
    } catch {
      throw new ProviderConfigurationError(location, 'the file', 'it could not be read.');
    }
  }

  const watchMode = options.watch ?? true;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const openWatcher =
    options.openWatcher ??
    ((path: string, listener: (event: string, filename: string | null) => void) =>
      watch(path, { recursive: true, persistent: false }, listener));
  /**
   * The native watchers that are open, by the directory each watches, with the directory's inode when
   * it was opened: a root removed and made again is a different directory, and a watcher of the old
   * one would see nothing of the new.
   */
  const watchers = new Map<
    string,
    { readonly watcher: FSWatcher; readonly inode: number | bigint }
  >();
  /** The directories a watcher could not be opened for, for a reason other than being absent: reported once each. */
  const unwatchable = new Set<string>();
  let pollRuntime: RuntimeServices | undefined;
  let pollTimer: unknown;
  /** Set when something asked for a rescan; the loop clears it as it starts one. */
  let dirty = false;
  let scanning: Promise<void> | undefined;
  /** The text of the last warning about a failed rescan, until a rescan succeeds. */
  let lastRescanWarning: string | undefined;

  /** Opens a watcher on `path`; a directory that is not there has none, and the next discovery tries again. */
  function openNativeWatcher(path: string, inode: number | bigint): void {
    try {
      const watcher = openWatcher(path, () => trigger());
      watcher.on('error', () => {
        // Re-armed by the next discovery, which the failure asks for.
        if (watchers.get(path)?.watcher === watcher) watchers.delete(path);
        watcher.close();
        trigger();
      });
      watchers.set(path, { watcher, inode });
    } catch (error) {
      const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR' || unwatchable.has(path)) return;
      unwatchable.add(path);
      warn(`The skill directory ${path} could not be watched.`, error);
    }
  }

  /** Watches the local sources' directories and starts the rescan timer, as `watch` says. */
  async function arm(sources: readonly SkillSource[]): Promise<void> {
    if (closed || watchMode === false) return;
    if (pollTimer === undefined) {
      pollRuntime = options.runtime ?? createDefaultRuntimeServices();
      // The native watcher is only a trigger and can miss an event (or be unavailable), so the rescan backs it.
      // poll-reason: fallback
      pollTimer = pollRuntime.timers.setInterval(trigger, DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    }
    if (watchMode === 'poll') return;
    const wanted = new Set(
      sources
        .filter((source) => WATCHED_SOURCE_KINDS[source.kind])
        .map((source) => source.location),
    );
    const inodes = new Map<string, number | bigint>();
    for (const path of wanted) {
      const info = await stat(path).catch(() => undefined);
      if (info?.isDirectory() === true) inodes.set(path, info.ino);
    }
    // `close()` may have landed while the directories were looked at: open nothing then.
    if (closed) return;
    for (const [path, held] of watchers) {
      if (inodes.get(path) === held.inode) continue;
      held.watcher.close();
      watchers.delete(path);
    }
    for (const [path, inode] of inodes) if (!watchers.has(path)) openNativeWatcher(path, inode);
  }

  /** Stops the rescan timer and closes the watchers. */
  function disarm(): void {
    if (pollTimer !== undefined) pollRuntime?.timers.clearInterval(pollTimer);
    pollTimer = undefined;
    for (const held of watchers.values()) held.watcher.close();
    watchers.clear();
  }

  /** Asks for a rescan: one runs at a time, and a request that comes while it does is one more. */
  function trigger(): void {
    if (closed) return;
    dirty = true;
    scanning ??= scanUntilQuiet();
  }

  async function scanUntilQuiet(): Promise<void> {
    while (dirty) {
      dirty = false;
      if (closed) break;
      try {
        await serialized(async () => {
          await rediscover('scan');
        });
        lastRescanWarning = undefined;
      } catch (error) {
        // The shutting-down error after `close()` is the host stopping, not a failure.
        if (closed) continue;
        const message = error instanceof Error ? error.message : String(error);
        if (message === lastRescanWarning) continue;
        lastRescanWarning = message;
        warn(`The skills could not be rescanned: ${message}`, error);
      }
    }
    scanning = undefined;
  }

  /** Tells {@link SkillManagerOptions.onChange} what `next` changed against `previous`, when it changed anything. */
  function announce(previous: SkillCatalogRevision, next: SkillCatalogRevision): void {
    const change = diffSkillCatalogs(previous, next);
    if (
      change.added.length +
        change.changed.length +
        change.removed.length +
        change.rejected.length ===
      0
    ) {
      return;
    }
    try {
      options.onChange?.(change);
    } catch (error) {
      warn('A skill change listener threw.', error);
    }
  }

  /**
   * Discover the catalog `configuration` describes and make it the current one, then announce what
   * it changed. A `scan` (a watcher or the poll) that finds the digest it already has keeps the
   * current catalog and its revision; anything else numbers a new revision.
   */
  async function discover(
    configuration: SkillsConfiguration,
    origin: 'scan' | 'explicit' = 'explicit',
  ): Promise<SkillsStanding> {
    const sources = [
      ...toSkillSources(configuration),
      ...((await options.pluginSources?.()) ?? []),
    ];
    const catalog = await discoverSkills({
      sources,
      trustPolicy: trustPolicyOf(configuration),
      ...(current === undefined ? {} : { revision: current.catalog.revision + 1 }),
    });
    const trusted = new Set(configuration.trusted);
    const isTrusted = (source: SkillSource): boolean =>
      source.kind === 'plugin' || trusted.has(source.id);
    const standing: SkillsStanding = {
      catalog,
      sources: sources.map((source): SkillSourceStanding => ({
        id: source.id,
        kind: source.kind,
        location: source.location,
        ...(source.plugin === undefined ? {} : { plugin: source.plugin }),
        trust: isTrusted(source) ? 'trusted' : 'untrusted',
        trustReason:
          source.kind === 'plugin'
            ? `Source '${source.id}' ships with the plugin '${source.plugin ?? ''}', which is trusted code the host loads.`
            : trusted.has(source.id)
              ? `Source '${source.id}' is listed in skills.trusted.`
              : `Source '${source.id}' is not listed in skills.trusted.`,
      })),
      ...(lockReason() === undefined ? {} : { trustLocked: lockReason() }),
    };
    // A host that is shutting down changes nothing and tells nobody.
    if (closed && current !== undefined) return current;
    const previous = current;
    // Armed from the sources just read, whether or not the catalog changed: a plugin that started, or
    // a directory that now exists, is watched from here.
    await arm(sources);
    if (origin === 'scan' && previous !== undefined && previous.catalog.digest === catalog.digest) {
      // The same catalog: its revision stays, and only what is listed beside it can have moved.
      const same = JSON.stringify(previous.sources) === JSON.stringify(standing.sources);
      current = same ? previous : { ...standing, catalog: previous.catalog };
      return current;
    }
    current = standing;
    if (previous !== undefined) announce(previous.catalog, catalog);
    return standing;
  }

  /** Read the configuration and discover again, and retry what the audit trail still owes. */
  async function rediscover(origin: 'scan' | 'explicit'): Promise<SkillsStanding> {
    const standing = await discover(readSkillsConfiguration(await readText(), location), origin);
    // A refresh answers for the catalog, so a trail that is still down is left for the next trust request.
    for (const source of new Set(unrecorded.map((entry) => entry.detail.sourceId))) {
      await recordUnrecorded(source);
    }
    return standing;
  }

  const standingNow = (): SkillsStanding => {
    if (current === undefined) throw new Error('The skill manager has discovered nothing.');
    return current;
  };

  /**
   * Record what changes to `source` left unrecorded, oldest first. Stops at the first failure and
   * leaves that entry and every later one owed; answers whether none is owed now.
   */
  async function recordUnrecorded(source: string): Promise<boolean> {
    while (true) {
      const index = unrecorded.findIndex((entry) => entry.detail.sourceId === source);
      const entry = unrecorded[index];
      if (entry === undefined) return true;
      try {
        await options.audit(entry);
      } catch {
        return false;
      }
      unrecorded.splice(index, 1);
    }
  }

  /** Read the file back after a write that threw, so the host serves what a restart would. */
  async function readBackAfterFailure(): Promise<void> {
    try {
      await discover(readSkillsConfiguration(await readText(), location));
    } catch {
      // The failure to report is the write's; a file that cannot be read back is reported on the next refresh.
    }
  }

  await discover(readSkillsConfiguration(await readText(), location));

  return {
    standing: standingNow,
    lockReason,
    close() {
      closed = true;
      disarm();
    },
    refresh: () =>
      serialized(async () => {
        const standing = await rediscover('explicit');
        return { revision: standing.catalog.revision };
      }),
    // The request is read, checked, and copied before the first `await`: the caller owns it, and
    // may change it while this waits its turn.
    async setTrust(request, suppliedMutation) {
      const reason = lockReason();
      if (reason !== undefined) throw new SkillWriteLockedError(reason);
      const source = request.source;
      if (typeof source !== 'string' || source === '') {
        throw new SkillInputError('source', 'expected the identifier of a configured source.');
      }
      const trusted = request.trusted;
      if (typeof trusted !== 'boolean') {
        throw new SkillInputError('trusted', 'expected true or false.');
      }
      return serialized(async () => {
        const mutation = suppliedMutation ?? (await createLocalHostMutationContext(bungalow));
        const authorize = async () => {
          const identity = await mutation.revalidate();
          if (
            identity.workspaceId !== bungalow.workspaceId ||
            !identity.capabilities.includes('deployment:operate')
          )
            throw new HostMutationError('forbidden');
          return identity;
        };
        await authorize();
        const snapshot = await bungalow.readConfiguration();
        if (snapshot.revision !== mutation.expectedRevision)
          throw new HostMutationError('conflict');
        const text = snapshot.text;
        // Parsed first as the host reads it, so a file that is already invalid is refused, not overwritten.
        if (text !== undefined) parseProviderConfiguration(text, location);
        const configuration = readSkillsConfiguration(text, location);
        if (!configuration.sources.some((entry) => entry.id === source)) {
          throw new SkillInputError('source', 'not a configured source.', 'unknown-source');
        }
        if (configuration.trusted.includes(source) === trusted) {
          // A repeated request answers for the record it still owes.
          if (!(await recordUnrecorded(source))) throw new SkillAuditError(source, trusted);
          return { source, trusted, changed: false, revision: standingNow().catalog.revision };
        }
        const nextTrusted = trusted
          ? [...configuration.trusted, source]
          : configuration.trusted.filter((entry) => entry !== source);
        const parsed: unknown = text === undefined ? {} : JSON.parse(text);
        const document = isPlainObject(parsed) ? parsed : {};
        const declared = isPlainObject(document['skills']) ? document['skills'] : {};
        const nextDocument = { ...document, skills: { ...declared, trusted: nextTrusted } };
        // The same check the next start applies, before a byte is written.
        const applied = parseSkillsConfiguration(nextDocument.skills, location);
        const next = `${JSON.stringify(nextDocument, null, 2)}\n`;
        const identity = await authorize();
        const owner = identity.owner;
        const entry: SkillAuditEntry = {
          runId: auditTrailSkillSourceOwnerId(source),
          type: trusted ? 'skill.source.trusted' : 'skill.source.untrusted',
          principal: owner,
          timestampMs: now(),
          detail: { sourceId: source, trusted, owner },
        };
        const result = await bungalow.writeConfiguration(next, {
          expectedRevision: snapshot.revision,
        });
        if (result.outcome !== 'committed') {
          await readBackAfterFailure();
          throw new SecretPublicationError(result.outcome);
        }
        const standing = await discover(applied);
        // The change is applied now. It is queued behind what is already owed so the trail keeps its
        // order, and it stays owed if the trail cannot take it.
        unrecorded.push(entry);
        if (!(await recordUnrecorded(source))) throw new SkillAuditError(source, trusted);
        return { source, trusted, changed: true, revision: standing.catalog.revision };
      });
    },
  };
}
