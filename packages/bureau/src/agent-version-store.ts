/**
 * The saved versions of each file-based agent (COR-1815): one record per definition revision,
 * kept apart from the runs that used it.
 *
 * `agent-snapshot-store.ts` keeps the definitions that have *run*, for as long as a retained run
 * references them. A revision that was saved and never ran has no snapshot, so an editor that
 * offers "restore the version from last Tuesday" needs its own history. That history lives here.
 *
 * ## The record
 *
 * `bureau-agent-version:v1:<identifier>:<revision>` holds, as JSON, a {@link AgentVersionRecord}:
 *
 * - `revision` and `hash`: the definition revision (`agent-revision-store.ts`) this version
 *   describes and the SHA-256 of the file's bytes it was raised for;
 * - `savedAt`: when the revision was raised, from the Bureau's clock;
 * - `savedBy`: the principal that saved it through the writer (`create`, `update`, or a restore),
 *   or `null` for an edit made outside the writer that the directory watcher found;
 * - `owner`: the owner of record of the agent (v1 is single-user, and every new record carries
 *   its owner so a later release can add users without migrating this family);
 * - `definition`: the whole definition, validated on read (`agentFileDefinitionSchema`). It holds
 *   the `references` paths and never the documents' text;
 * - `referenceDigests` (COR-1866): for an agent with references, the path and SHA-256 of each
 *   document as it was read when the revision was raised, in the file's order. Absent when the
 *   agent has none. A record never holds a document's content, so a document that changed since
 *   cannot be restored, only named; restoring a version writes its definition (its `references`
 *   list included) and the documents are whatever the paths name then. `hash` is then the agent's
 *   identity hash (`agent-reference-documents.ts`), not the file's;
 * - `changedKeys`: the keys of the definition that differ from the previous version's, in the
 *   definition's own order. A change to the instructions only gives `["instructions"]`. A change
 *   to a document alone (same paths, a new digest) gives `["references"]`. A first
 *   version, or one whose predecessor is not stored, lists every key the definition has.
 *
 * An identifier cannot hold `:` and a revision is a decimal integer, so the key needs no encoding
 * and `versions(id)` is one prefix list.
 *
 * ## Writing and pruning
 *
 * A version is never written by itself. {@link AgentRevisionStore.advance} adds it to the same
 * conditional batch that raises the revision record, so the two cannot disagree: a batch that
 * does not commit leaves neither, and a batch that commits leaves both. Only the process whose
 * batch commits writes the version, so two Bureaus that see one change produce one version.
 *
 * The same batch removes the oldest versions beyond {@link AGENT_VERSION_LIMIT}, oldest first by
 * revision, skipping any revision a retained run references and the version being written. A
 * referenced version is therefore kept even when it is the oldest, and an agent can hold more than
 * the limit while its runs are retained. Which revisions are referenced is read before the batch
 * and is not part of its condition: a run cannot start on a revision older than the current one,
 * so a reference to an old revision can only be dropped in between, which keeps one version a
 * little longer than needed and is repaired by the next prune.
 *
 * @module agent-version-store
 */

import { isDeepStrictEqual } from 'node:util';

import type { TextValueStore } from '@lostgradient/storage';

import {
  AGENT_FILE_DEFINITION_KEYS,
  type AgentFileDefinition,
  agentFileDefinitionSchema,
} from './agent-file';
import {
  type AgentReferenceDigest,
  agentReferenceDigestSchema,
  sameDigests,
} from './agent-reference-documents';

export const AGENT_VERSION_KEY_PREFIX = 'bureau-agent-version:v1:';

/** How many versions of one agent are kept, beyond those a retained run references. */
export const AGENT_VERSION_LIMIT = 50;

/** One saved version of a file agent's definition. */
export interface AgentVersionRecord {
  /** The definition revision this version describes. */
  readonly revision: number;
  /** The SHA-256 of the file's bytes the revision was raised for, in lowercase hex. */
  readonly hash: string;
  /** When the revision was raised, as an ISO timestamp from the Bureau's clock. */
  readonly savedAt: string;
  /** Who saved it through the writer, or `null` for an edit the directory watcher found. */
  readonly savedBy: string | null;
  /** The owner of record of the agent when the version was saved. */
  readonly owner: string;
  /** The definition as of this revision. */
  readonly definition: AgentFileDefinition;
  /** The documents the definition's `references` named, as they were read. Absent when it has none. */
  readonly referenceDigests?: readonly AgentReferenceDigest[];
  /** The definition keys that differ from the previous version's. */
  readonly changedKeys: readonly string[];
}

/** What {@link AgentRevisionStore.advance} is given to record when it raises a revision. */
export interface AgentVersionInput {
  readonly definition: AgentFileDefinition;
  /** The documents the definition's `references` named, as they were read. Omit it for none. */
  readonly referenceDigests?: readonly AgentReferenceDigest[] | undefined;
  readonly savedAt: string;
  readonly savedBy: string | null;
  readonly owner: string;
  /**
   * The revisions of this agent that a retained run references, which a prune must keep. Read
   * only when a version is about to be written. Omit it to protect none.
   */
  readonly retainedRevisions?: (() => Promise<ReadonlySet<number>>) | undefined;
}

/** The key of the version of `id` at `revision`. */
export function agentVersionKey(id: string, revision: number): string {
  return `${AGENT_VERSION_KEY_PREFIX}${id}:${revision}`;
}

/** The prefix every version key of `id` starts with. */
export function agentVersionKeyPrefix(id: string): string {
  return `${AGENT_VERSION_KEY_PREFIX}${id}:`;
}

/**
 * The keys of `next` that differ from `previous`. With no `previous`, every key `next` has.
 * An absent key and a key set to `undefined` are the same.
 */
export function changedDefinitionKeys(
  previous: AgentFileDefinition | undefined,
  next: AgentFileDefinition,
  digests?: {
    readonly previous: readonly AgentReferenceDigest[] | undefined;
    readonly next: readonly AgentReferenceDigest[] | undefined;
  },
): string[] {
  const documentsChanged = digests !== undefined && !sameDigests(digests.previous, digests.next);
  return AGENT_FILE_DEFINITION_KEYS.filter((key) =>
    previous === undefined
      ? next[key] !== undefined
      : !isDeepStrictEqual(previous[key], next[key]) || (key === 'references' && documentsChanged),
  );
}

/** The record as it is stored: keys in a fixed order, and no key set to `undefined`. */
export function encodeAgentVersion(record: AgentVersionRecord): string {
  return JSON.stringify({
    revision: record.revision,
    hash: record.hash,
    savedAt: record.savedAt,
    savedBy: record.savedBy,
    owner: record.owner,
    definition: record.definition,
    ...(record.referenceDigests === undefined || record.referenceDigests.length === 0
      ? {}
      : { referenceDigests: record.referenceDigests }),
    changedKeys: record.changedKeys,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A stored record, or `undefined` when `text` is not a valid one. A record whose definition no
 * longer validates is not a version anyone can restore, so it reads as absent.
 */
export function parseAgentVersion(text: string | null): AgentVersionRecord | undefined {
  if (text === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { revision, hash, savedAt, savedBy, owner, changedKeys } = value;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    return undefined;
  }
  if (typeof hash !== 'string' || typeof savedAt !== 'string' || typeof owner !== 'string') {
    return undefined;
  }
  if (savedBy !== null && typeof savedBy !== 'string') return undefined;
  if (!Array.isArray(changedKeys) || changedKeys.some((key) => typeof key !== 'string')) {
    return undefined;
  }
  const definition = agentFileDefinitionSchema.safeParse(value['definition']);
  if (!definition.success) return undefined;
  const digests =
    value['referenceDigests'] === undefined
      ? undefined
      : agentReferenceDigestSchema.array().safeParse(value['referenceDigests']);
  if (digests !== undefined && !digests.success) return undefined;
  return {
    revision,
    hash,
    savedAt,
    savedBy,
    owner,
    definition: definition.data as AgentFileDefinition,
    ...(digests === undefined || digests.data.length === 0
      ? {}
      : { referenceDigests: digests.data }),
    changedKeys: changedKeys as string[],
  };
}

/** The revision a version key of `id` names, or `undefined` for a key that names none. */
function revisionOfKey(id: string, key: string): number | undefined {
  const suffix = key.slice(agentVersionKeyPrefix(id).length);
  if (!/^[1-9][0-9]*$/u.test(suffix)) return undefined;
  const revision = Number(suffix);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

/**
 * The keys of the versions to remove so that, once the version at `newest` is written, no more
 * than `limit` remain: the oldest revisions first (compared as numbers, because a prefix list is
 * in text order and "10" sorts before "9"), skipping `newest` and every revision in `retained`.
 */
export function versionKeysToPrune(input: {
  readonly id: string;
  readonly existingKeys: readonly string[];
  readonly newest: number;
  readonly retained: ReadonlySet<number>;
  readonly limit?: number;
}): string[] {
  const { id, existingKeys, newest, retained, limit = AGENT_VERSION_LIMIT } = input;
  const held = existingKeys
    .map((key) => ({ key, revision: revisionOfKey(id, key) }))
    .filter((entry): entry is { key: string; revision: number } => entry.revision !== undefined);
  const total = held.filter((entry) => entry.revision !== newest).length + 1;
  const candidates = held
    .filter((entry) => entry.revision !== newest && !retained.has(entry.revision))
    .toSorted((left, right) => left.revision - right.revision);
  return candidates.slice(0, Math.max(0, total - limit)).map((entry) => entry.key);
}

/** Reads the stored versions of file agents. Writing goes through the revision store. */
export interface AgentVersionStore {
  /** Every stored version of `id`, newest revision first. A record that is not valid is skipped. */
  list(id: string): Promise<readonly AgentVersionRecord[]>;
  /** The version of `id` at `revision`, or `undefined` when none is stored (or it is not valid). */
  read(id: string, revision: number): Promise<AgentVersionRecord | undefined>;
}

export function createAgentVersionStore(options: {
  readonly store: Pick<TextValueStore, 'get' | 'list'>;
}): AgentVersionStore {
  const { store } = options;
  return {
    async list(id) {
      const found: AgentVersionRecord[] = [];
      for (const key of await store.list(agentVersionKeyPrefix(id))) {
        const record = parseAgentVersion(await store.get(key));
        if (record !== undefined && revisionOfKey(id, key) === record.revision) found.push(record);
      }
      return found.toSorted((left, right) => right.revision - left.revision);
    },

    async read(id, revision) {
      return parseAgentVersion(await store.get(agentVersionKey(id, revision)));
    },
  };
}
