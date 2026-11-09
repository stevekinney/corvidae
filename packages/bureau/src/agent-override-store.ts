/**
 * The saved overrides of a built-in (code) agent, and their versions (COR-2009, coordinator call of
 * Nov 3).
 *
 * A code agent has no file, so an agent file's history (`agent-version-store.ts`) has nothing to
 * hold for it. What a person changes on a built-in agent (which tools it may use and how each asks,
 * its guardrails and budgets, its model, the models a chat may switch to, its effort and step
 * limit, and its instructions) is saved here instead, as a set of overrides over what the agent
 * states about itself. Every save is a new version, numbered from 1 for each agent, so the editor
 * can list them and restore one exactly as it does a file agent's. An agent nobody changed has no
 * versions, and the newest version is the overrides in force: there is no separate "current"
 * record that could disagree with it.
 *
 * ## The record
 *
 * `bureau-agent-override-version:v1:<identifier>:<version>` holds, as JSON, a
 * {@link AgentOverrideVersionRecord}: the `version`, the `hash` of its overrides (the SHA-256 of
 * {@link encodeAgentOverrides}, which a later save names as its `expectedHash`), when and by whom it
 * was saved, the owner of record, the `overrides` themselves, and the `changedKeys` that differ from
 * the version before it (every key it sets, for a first version). An identifier cannot hold `:`
 * and a version is a decimal integer, so the key needs no encoding and one prefix lists an agent.
 *
 * ## Writing
 *
 * A save is one conditional batch: the new version's key must be absent and the newest version's
 * record unchanged, so two saves that read the same newest version cannot both commit, and the loser
 * is answered as a stale write. The same batch removes the oldest versions beyond
 * {@link AGENT_OVERRIDE_VERSION_LIMIT}. A code agent has no run snapshots to protect, so none is
 * kept past the limit. A restore is a save of an older version's overrides: it appends a new
 * version and leaves the others as they were.
 *
 * @module agent-override-store
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import { z } from 'zod';

import {
  AgentFileConflictError,
  AgentFileError,
  storedAgentGuardrailSelectionsSchema,
  agentDefaultEffortSchema,
  agentLimitsSchema,
  agentToolApprovalSchema,
  withFoldedLegacyLimits,
} from './agent-file';

/** Where the override versions live. */
export const AGENT_OVERRIDE_VERSION_KEY_PREFIX = 'bureau-agent-override-version:v1:';

/** How many versions of one code agent's overrides are kept; the oldest go first. */
export const AGENT_OVERRIDE_VERSION_LIMIT = 50;

/**
 * The overrides one save of a built-in agent holds, each key in the order a version lists it. A key
 * that is absent is not overridden, and the agent's own value applies.
 */
export const agentOverridesSchema = z.strictObject({
  /** The instructions, in place of the agent's own. */
  instructions: z.string().min(1).optional(),
  /** The tools the agent may use, by the name the tool catalog holds; the Access tab's allowed set. */
  tools: z
    .array(z.string().min(1))
    .refine((names) => new Set(names).size === names.length, {
      message: 'tool names must be unique',
    })
    .optional(),
  /** When each tool asks a person first, by tool name: the Access tab's Asks column. */
  approvals: agentToolApprovalSchema.optional(),
  /**
   * The plugin guardrails a run applies, each `plugin:name` or `{ id, configuration }` (COR-2118).
   * A record written before COR-2118 holds ids alone and reads as it is; a save refuses a repeated
   * id (`code-agent-overrides.ts`), and one an older record repeats applies once.
   */
  guardrails: storedAgentGuardrailSelectionsSchema.optional(),
  /**
   * What a run may take, a run and a chat may spend (in US dollars), and a run's tools may use
   * (COR-2138): `steps`, `cost` and `tools`. Each limit named replaces the agent's own; one left out
   * keeps it.
   */
  limits: agentLimitsSchema
    .refine((limits) => Object.keys(limits).length > 0, {
      message: 'limits must set at least one of steps, cost or tools',
    })
    .optional(),
  /** The model a chat starts on, `<provider>/<model>`. */
  model: z.string().min(1).optional(),
  /** The models a chat may be switched to, `<provider>/<model>`. */
  models: z
    .array(z.string().min(1))
    .refine((names) => new Set(names).size === names.length, {
      message: 'model names must be unique',
    })
    .optional(),
  /** The reasoning effort a chat starts at. */
  effort: agentDefaultEffortSchema.optional(),
});

/** One save's overrides; see {@link agentOverridesSchema}. */
export type AgentOverrides = z.infer<typeof agentOverridesSchema>;

/** The keys an override set may hold, in the order a version lists and encodes them. */
export const AGENT_OVERRIDE_KEYS = Object.freeze(
  Object.keys(agentOverridesSchema.shape) as (keyof AgentOverrides)[],
);

/** One saved version of a built-in agent's overrides. */
export interface AgentOverrideVersionRecord {
  /** The version number, from 1 for the agent's first save. */
  readonly version: number;
  /** The SHA-256 of the encoded overrides, in lowercase hex: a later save's `expectedHash`. */
  readonly hash: string;
  /** When the version was saved, as an ISO timestamp from the Bureau's clock. */
  readonly savedAt: string;
  /** Who saved it. */
  readonly savedBy: string;
  /** The owner of record of the agent when the version was saved. */
  readonly owner: string;
  /** The overrides in force from this version on. */
  readonly overrides: AgentOverrides;
  /** The override keys that differ from the previous version's; every key it sets, for a first. */
  readonly changedKeys: readonly string[];
}

/** A built-in agent's overrides as they are now. */
export interface AgentOverrideState {
  /** The hash of the overrides in force (of none, for an agent never changed): a save's `expectedHash`. */
  readonly hash: string;
  /** The newest version, or `null` for an agent never changed. */
  readonly version: number | null;
  /** The overrides in force; empty for an agent never changed. */
  readonly overrides: AgentOverrides;
}

/** What a save or restore reports: the hash and version now in force. */
export interface AgentOverrideWriteResult {
  /** The agent's identifier. */
  readonly id: string;
  /** The hash of the overrides now in force. */
  readonly hash: string;
  /** The version now in force; `null` only for an agent that still has none. */
  readonly version: number | null;
}

/** Who saves a version, and for whom. */
export interface AgentOverrideSaveOptions {
  /** The hash the caller read ({@link AgentOverrideState.hash}); a different one is a stale write. */
  readonly expectedHash: string;
  /** The principal saving, recorded as the version's `savedBy`. */
  readonly savedBy: string;
  /** The owner of record of the agent. */
  readonly owner: string;
}

/** The stored override versions of the built-in agents. */
export interface AgentOverrideStore {
  /** The overrides of `id` in force now. */
  current(id: string): Promise<AgentOverrideState>;
  /** Every stored version of `id`, newest first. A record that is not valid is skipped. */
  list(id: string): Promise<readonly AgentOverrideVersionRecord[]>;
  /**
   * Saves `overrides` as the next version of `id`, if the overrides in force still hash to
   * `options.expectedHash`. Overrides equal to those in force write nothing and report the current
   * version. Fails with `AgentFileConflictError` `agent-file-changed`, carrying the current hash,
   * when they do not, or when another save committed first; nothing is written.
   */
  save(
    id: string,
    overrides: AgentOverrides,
    options: AgentOverrideSaveOptions,
  ): Promise<AgentOverrideWriteResult>;
  /**
   * Saves the overrides of version `version` of `id` again, as a new version, under the same rules
   * as {@link save}. Fails with `AgentFileError` `agent-version-not-found` when no such version is
   * stored.
   */
  restore(
    id: string,
    version: number,
    options: AgentOverrideSaveOptions,
  ): Promise<AgentOverrideWriteResult>;
}

/** What {@link createAgentOverrideStore} is built on. */
export interface AgentOverrideStoreOptions {
  /** Where the versions live; a memory store when absent, which a restart forgets. */
  readonly store?: ConditionalTextValueStore | undefined;
  /** The current time as an ISO 8601 instant, for {@link AgentOverrideVersionRecord.savedAt}. */
  readonly nowISO: () => string;
}

/** The key of version `version` of `id`. */
export function agentOverrideVersionKey(id: string, version: number): string {
  return `${AGENT_OVERRIDE_VERSION_KEY_PREFIX}${id}:${version}`;
}

function keyPrefixOf(id: string): string {
  return `${AGENT_OVERRIDE_VERSION_KEY_PREFIX}${id}:`;
}

/** The overrides as they are hashed and stored: keys in {@link AGENT_OVERRIDE_KEYS} order. */
export function encodeAgentOverrides(overrides: AgentOverrides): string {
  const ordered: Record<string, unknown> = {};
  for (const key of AGENT_OVERRIDE_KEYS) {
    if (overrides[key] !== undefined) ordered[key] = overrides[key];
  }
  return JSON.stringify(ordered);
}

/** The hash of `overrides`, a save's `expectedHash`. */
export function hashAgentOverrides(overrides: AgentOverrides): string {
  return createHash('sha256').update(encodeAgentOverrides(overrides)).digest('hex');
}

/** The keys of `next` that differ from `previous`; every key `next` sets when there is none. */
export function changedOverrideKeys(
  previous: AgentOverrides | undefined,
  next: AgentOverrides,
): string[] {
  return AGENT_OVERRIDE_KEYS.filter((key) =>
    previous === undefined ? next[key] !== undefined : !isDeepStrictEqual(previous[key], next[key]),
  );
}

function encodeRecord(record: AgentOverrideVersionRecord): string {
  return JSON.stringify({
    version: record.version,
    hash: record.hash,
    savedAt: record.savedAt,
    savedBy: record.savedBy,
    owner: record.owner,
    overrides: JSON.parse(encodeAgentOverrides(record.overrides)) as unknown,
    changedKeys: record.changedKeys,
  });
}

/**
 * The override keys that were renamed in COR-2137 and COR-2138, from the old name to the new one. A
 * record saved before then holds the old names; it reads under the new ones and is never written
 * back with them. `limits` is not here, because three old keys became one: see
 * {@link withFoldedLegacyLimits}.
 */
const RENAMED_OVERRIDE_KEYS: ReadonlyMap<string, string> = new Map([
  ['toolApproval', 'approvals'],
  ['defaultEffort', 'effort'],
]);

/**
 * `value` with each renamed override key under its new name. The new name wins when both are
 * present. Anything that is not a plain object is returned as it is, for the schema to refuse.
 */
function withRenamedOverrideKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const renamed: Record<string, unknown> = {};
  for (const [key, held] of Object.entries(value)) {
    if (!RENAMED_OVERRIDE_KEYS.has(key)) renamed[key] = held;
  }
  for (const [oldKey, newKey] of RENAMED_OVERRIDE_KEYS) {
    if (Object.hasOwn(value, oldKey) && !Object.hasOwn(renamed, newKey)) {
      renamed[newKey] = (value as Record<string, unknown>)[oldKey];
    }
  }
  return renamed;
}

/** The override key a stored `changedKeys` entry names now; the three old limits are all `limits`. */
function renamedChangedKey(key: string): string {
  return LEGACY_LIMIT_KEYS.has(key) ? 'limits' : (RENAMED_OVERRIDE_KEYS.get(key) ?? key);
}

/** The override keys that held one limit each before COR-2138, which `limits` now holds. */
const LEGACY_LIMIT_KEYS: ReadonlySet<string> = new Set(['stepLimit', 'costBudget', 'toolBudget']);

const recordSchema = z.object({
  version: z.number().int().positive(),
  hash: z.string().min(1),
  savedAt: z.string().min(1),
  savedBy: z.string(),
  owner: z.string(),
  overrides: z.preprocess(
    (value) => withFoldedLegacyLimits(withRenamedOverrideKeys(value)),
    agentOverridesSchema,
  ),
  changedKeys: z
    .array(z.string())
    .transform((keys) => [...new Set(keys.map((key) => renamedChangedKey(key)))]),
});

/** A stored record, or `undefined` when `text` is not a valid one. */
export function parseAgentOverrideVersion(
  text: string | null,
): AgentOverrideVersionRecord | undefined {
  if (text === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The version a key of `id` names, or `undefined` for a key that names none. */
function versionOfKey(id: string, key: string): number | undefined {
  const suffix = key.slice(keyPrefixOf(id).length);
  if (!/^[1-9][0-9]*$/u.test(suffix)) return undefined;
  const version = Number(suffix);
  return Number.isSafeInteger(version) ? version : undefined;
}

interface StoredVersion {
  readonly key: string;
  readonly text: string;
  readonly record: AgentOverrideVersionRecord;
}

/** The override versions kept in `options.store`. */
export function createAgentOverrideStore(options: AgentOverrideStoreOptions): AgentOverrideStore {
  const store = options.store ?? textValueStore(new MemoryStorage());

  async function stored(id: string): Promise<StoredVersion[]> {
    const found: StoredVersion[] = [];
    for (const key of await store.list(keyPrefixOf(id))) {
      const text = await store.get(key);
      const record = parseAgentOverrideVersion(text);
      if (text !== null && record !== undefined && versionOfKey(id, key) === record.version) {
        found.push({ key, text, record });
      }
    }
    return found.toSorted((left, right) => right.record.version - left.record.version);
  }

  async function newestOf(id: string): Promise<StoredVersion | undefined> {
    const versions = await stored(id);
    return versions[0];
  }

  function stateOf(newest: StoredVersion | undefined): AgentOverrideState {
    return newest === undefined
      ? { hash: hashAgentOverrides({}), version: null, overrides: {} }
      : {
          hash: newest.record.hash,
          version: newest.record.version,
          overrides: newest.record.overrides,
        };
  }

  async function write(
    id: string,
    overrides: AgentOverrides,
    saveOptions: AgentOverrideSaveOptions,
    versions: readonly StoredVersion[],
  ): Promise<AgentOverrideWriteResult> {
    const newest = versions[0];
    const current = stateOf(newest);
    if (current.hash !== saveOptions.expectedHash) {
      throw new AgentFileConflictError(
        'agent-file-changed',
        `The overrides of agent "${id}" changed since they were read.`,
        current.hash,
      );
    }
    const hash = hashAgentOverrides(overrides);
    if (hash === current.hash) return { id, hash, version: current.version };
    const version = (newest?.record.version ?? 0) + 1;
    const record: AgentOverrideVersionRecord = {
      version,
      hash,
      savedAt: options.nowISO(),
      savedBy: saveOptions.savedBy,
      owner: saveOptions.owner,
      overrides,
      changedKeys: changedOverrideKeys(newest?.record.overrides, overrides),
    };
    const key = agentOverrideVersionKey(id, version);
    const pruned = versions.slice(Math.max(0, AGENT_OVERRIDE_VERSION_LIMIT - 1));
    const committed = await store.conditionalBatch(
      [
        { key, expectedValue: null },
        ...(newest === undefined ? [] : [{ key: newest.key, expectedValue: newest.text }]),
      ],
      [
        { type: 'set', key, value: encodeRecord(record) },
        ...pruned.map((entry) => ({ type: 'delete' as const, key: entry.key })),
      ],
    );
    if (!committed) {
      throw new AgentFileConflictError(
        'agent-file-changed',
        `The overrides of agent "${id}" changed while they were being saved.`,
        stateOf(await newestOf(id)).hash,
      );
    }
    return { id, hash, version };
  }

  return {
    async current(id) {
      return stateOf(await newestOf(id));
    },

    async list(id) {
      const versions = await stored(id);
      return versions.map((entry) => entry.record);
    },

    async save(id, overrides, saveOptions) {
      return write(id, agentOverridesSchema.parse(overrides), saveOptions, await stored(id));
    },

    async restore(id, version, saveOptions) {
      const versions = await stored(id);
      const restored = versions.find((entry) => entry.record.version === version);
      if (restored === undefined) {
        throw new AgentFileError(
          'agent-version-not-found',
          `Agent "${id}" has no saved version ${version}.`,
        );
      }
      return write(id, restored.record.overrides, saveOptions, versions);
    },
  };
}
