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
 * - **Local only.** A remote home keeps its configuration in a bucket the host cannot write, so a
 *   change there is refused with the lock reason `deployment` ({@link SkillWriteLockedError}).
 * - **A catalog is replaced, never edited.** Each discovery makes a new revision. A skill client
 *   offers the revision it was built with and, given `currentCatalog` (COR-1926), checks a skill
 *   against the current catalog when the skill is used. The host does not build a skill client for
 *   its agents' runs yet, so `standing` is what such a client would be given as `currentCatalog`;
 *   until file agents can declare skills, nothing in the host consumes it.
 *
 * @module skill-manager
 */

import type { Bungalow } from '@lostgradient/bungalow';
import {
  ANONYMOUS_LOCAL_OWNER,
  auditTrailSkillSourceOwnerId,
  type SettingLockReason,
  type SkillSourceStanding,
  type SkillsStanding,
} from '@lostgradient/bureau';
import { discoverSkills, type SkillSource } from '@lostgradient/bureau/skills';

import { createConfigurationQueue, type ConfigurationQueue } from './configuration-queue.ts';
import { hostWriteLocks } from './locations.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { parseProviderConfiguration } from './providers.ts';
import {
  parseSkillsConfiguration,
  readSkillsConfiguration,
  toSkillSources,
  trustPolicyOf,
  type SkillsConfiguration,
} from './skills-configuration.ts';

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
  setTrust(request: SkillTrustRequest): Promise<SkillTrustChange>;
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
    'mode' | 'configurationLocation' | 'readConfiguration' | 'writeConfiguration'
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
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Create the manager and discover the first catalog from the configuration as it is now. */
export async function createSkillManager(options: SkillManagerOptions): Promise<SkillManager> {
  const { bungalow } = options;
  const location = bungalow.configurationLocation;
  const owner = options.owner ?? ANONYMOUS_LOCAL_OWNER;
  const now = options.now ?? Date.now;
  const configurationQueue = options.configurationQueue ?? createConfigurationQueue();
  let closed = false;
  let current: SkillsStanding | undefined;
  /** Changes that were applied and not recorded, oldest first. In memory: a restart drops them. */
  const unrecorded: SkillAuditEntry[] = [];

  const lockReason = (): SettingLockReason | undefined => hostWriteLocks(bungalow).configuration;
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

  /** Discover the catalog `configuration` describes and make it the current one. */
  async function discover(configuration: SkillsConfiguration): Promise<SkillsStanding> {
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
    current = standing;
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

  const trustOf = (source: string) => current?.sources.find((entry) => entry.id === source)?.trust;

  await discover(readSkillsConfiguration(await readText(), location));

  return {
    standing: standingNow,
    lockReason,
    close() {
      closed = true;
    },
    refresh: () =>
      serialized(async () => {
        const standing = await discover(readSkillsConfiguration(await readText(), location));
        // A refresh answers for the catalog, so a trail that is still down is left for the next trust request.
        for (const source of new Set(unrecorded.map((entry) => entry.detail.sourceId))) {
          await recordUnrecorded(source);
        }
        return { revision: standing.catalog.revision };
      }),
    // The request is read, checked, and copied before the first `await`: the caller owns it, and
    // may change it while this waits its turn.
    async setTrust(request) {
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
        const text = await readText();
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
        const entry: SkillAuditEntry = {
          runId: auditTrailSkillSourceOwnerId(source),
          type: trusted ? 'skill.source.trusted' : 'skill.source.untrusted',
          principal: owner,
          timestampMs: now(),
          detail: { sourceId: source, trusted, owner },
        };
        let written = true;
        try {
          bungalow.writeConfiguration(next);
        } catch (error) {
          // A write that throws may still have replaced the file, so the disk decides what is served.
          written = false;
          await readBackAfterFailure();
          if (trustOf(source) !== (trusted ? 'trusted' : 'untrusted')) throw error;
        }
        const standing = written ? await discover(applied) : standingNow();
        // The change is applied now. It is queued behind what is already owed so the trail keeps its
        // order, and it stays owed if the trail cannot take it.
        unrecorded.push(entry);
        if (!(await recordUnrecorded(source))) throw new SkillAuditError(source, trusted);
        return { source, trusted, changed: true, revision: standing.catalog.revision };
      });
    },
  };
}
