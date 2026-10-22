/**
 * The persisted revision of each file-based agent (COR-1584).
 *
 * A file agent's external identity is `(name, definitionRevision)`, and a client that fences on it
 * has to see every change to the definition. The revision therefore has to outlive the process and
 * only ever go up, which an in-memory counter cannot promise across a restart.
 *
 * ## The record
 *
 * `bureau-agent-revision:v1:<identifier>` holds `{ "revision": <n>, "hash": "<hex>" }` as JSON, in
 * that key order: the revision, and the SHA-256 of the file's bytes (64 lowercase hex digits; any
 * other hash makes the record malformed) it was last raised for. An
 * identifier cannot hold `:`, so the key needs no encoding. There is one record per identifier,
 * and nothing else is stored: not the history of hashes, and not the definition (the snapshot
 * store holds those).
 *
 * ## Raising it
 *
 * {@link AgentRevisionStore.advance} reads the record and compares its hash with the file's:
 *
 * - no record: the file is a first sighting, and revision 1 is written on condition that the key
 *   is still absent;
 * - the same hash: nothing is written, and the record's revision is the answer;
 * - a different hash: `revision + 1` and the new hash are written on condition that the record is
 *   still the exact text that was read. Content that returns to an earlier hash still counts as a
 *   change, because only the last hash is kept.
 *
 * A write that loses its condition read the record again. If the record then holds the file's
 * hash, another writer (another Bureau process on the same store) made the same change, and its
 * revision is the answer, so two processes that see one change produce one increment. If it holds
 * a different hash, the change is raised from that record in turn.
 *
 * A record that cannot be read, or that is not a valid record, is an error and is never replaced:
 * reading it as absent would write revision 1 over a higher one, which is going backwards.
 *
 * Deleting a file leaves its record, so recreating the identifier continues from the last
 * revision.
 *
 * @module agent-revision-store
 */

import type { ConditionalTextValueStore } from '@lostgradient/weft';

export const AGENT_REVISION_KEY_PREFIX = 'bureau-agent-revision:v1:';

/** What the record holds: the revision, and the hash of the file content it was raised for. */
export interface AgentRevisionRecord {
  readonly revision: number;
  readonly hash: string;
}

export interface AgentRevisionStore {
  /**
   * The record for `id`, or `undefined` when there is none. Rejects when the store cannot be read
   * or the record is not valid.
   */
  read(id: string): Promise<AgentRevisionRecord | undefined>;
  /**
   * Make the record for `id` describe `hash`, raising the revision if it described other content,
   * and resolve the record that results. Rejects when the store cannot be read or written, or the
   * record is not valid.
   */
  advance(id: string, hash: string): Promise<AgentRevisionRecord>;
}

export interface AgentRevisionStoreOptions {
  readonly store: ConditionalTextValueStore;
}

/**
 * How many times a write that lost its condition reads again before giving up. Each loss means
 * another writer changed the record in between, so reaching the bound takes a sustained run of
 * distinct edits to one file from other processes.
 */
const MAXIMUM_CONFLICTS = 16;

/** What `hashAgentFileBytes` returns: a SHA-256 in lowercase hex. Anything else is not a hash. */
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function keyOf(id: string): string {
  return `${AGENT_REVISION_KEY_PREFIX}${id}`;
}

function encode(record: AgentRevisionRecord): string {
  return JSON.stringify({ revision: record.revision, hash: record.hash });
}

function parse(id: string, text: string): AgentRevisionRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`The revision record of agent "${id}" is not valid JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`The revision record of agent "${id}" is not an object.`);
  }
  const { revision, hash } = value as Record<string, unknown>;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`The revision record of agent "${id}" does not hold a positive revision.`);
  }
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    throw new Error(
      `The revision record of agent "${id}" does not hold a SHA-256 hash in lowercase hex.`,
    );
  }
  return { revision, hash };
}

export function createAgentRevisionStore(options: AgentRevisionStoreOptions): AgentRevisionStore {
  const { store } = options;

  async function readText(id: string): Promise<string | null> {
    return store.get(keyOf(id));
  }

  return {
    async read(id) {
      const text = await readText(id);
      return text === null ? undefined : parse(id, text);
    },

    async advance(id, hash) {
      if (!HASH_PATTERN.test(hash)) {
        throw new Error(`The file hash given for agent "${id}" is not a SHA-256 in lowercase hex.`);
      }
      const key = keyOf(id);
      for (let conflicts = 0; conflicts <= MAXIMUM_CONFLICTS; conflicts += 1) {
        // The condition is the text exactly as it was read, not an encoding of the parsed record.
        const text = await readText(id);
        const current = text === null ? undefined : parse(id, text);
        if (current?.hash === hash) return current;
        const next: AgentRevisionRecord = { revision: (current?.revision ?? 0) + 1, hash };
        if (!Number.isSafeInteger(next.revision)) {
          throw new Error(`The revision of agent "${id}" cannot be raised any further.`);
        }
        const committed = await store.conditionalBatch(
          [{ key, expectedValue: text }],
          [{ type: 'set', key, value: encode(next) }],
        );
        if (committed) return next;
      }
      throw new Error(
        `The revision record of agent "${id}" kept changing under ${MAXIMUM_CONFLICTS + 1} attempts to raise it.`,
      );
    },
  };
}
