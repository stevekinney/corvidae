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
 *   by the owner. A change that changes nothing writes and records nothing.
 * - **Local only.** A remote home keeps its configuration in a bucket the host cannot write, so a
 *   change there is refused with the lock reason `deployment` ({@link SkillWriteLockedError}).
 * - **A catalog is replaced, never edited.** Each discovery makes a new revision; a skill client
 *   keeps the revision it was built with.
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
import { discoverSkills } from '@lostgradient/bureau/skills';

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
  /** Appends one record to the audit trail; resolves without writing when the Bureau keeps none. */
  readonly audit: (entry: SkillAuditEntry) => Promise<void>;
  /** The owner a change is made by. Defaults to the local owner, the one principal of a single-user host. */
  readonly owner?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Create the manager and discover the first catalog from the configuration as it is now. */
export async function createSkillManager(options: SkillManagerOptions): Promise<SkillManager> {
  const { bungalow } = options;
  const location = bungalow.configurationLocation;
  const owner = options.owner ?? ANONYMOUS_LOCAL_OWNER;
  const configurationQueue = options.configurationQueue ?? createConfigurationQueue();
  let closed = false;
  let current: SkillsStanding | undefined;

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
    const sources = toSkillSources(configuration);
    const catalog = await discoverSkills({
      sources,
      trustPolicy: trustPolicyOf(configuration),
      ...(current === undefined ? {} : { revision: current.catalog.revision + 1 }),
    });
    const trusted = new Set(configuration.trusted);
    const standing: SkillsStanding = {
      catalog,
      sources: sources.map((source): SkillSourceStanding => ({
        id: source.id,
        kind: source.kind,
        location: source.location,
        trust: trusted.has(source.id) ? 'trusted' : 'untrusted',
        trustReason: trusted.has(source.id)
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
        bungalow.writeConfiguration(next);
        const standing = await discover(applied);
        try {
          await options.audit({
            runId: auditTrailSkillSourceOwnerId(source),
            type: trusted ? 'skill.source.trusted' : 'skill.source.untrusted',
            principal: owner,
            detail: { sourceId: source, trusted, owner },
          });
        } catch {
          throw new SkillAuditError(source, trusted);
        }
        return { source, trusted, changed: true, revision: standing.catalog.revision };
      });
    },
  };
}
