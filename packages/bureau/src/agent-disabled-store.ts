/**
 * Which agents a person disabled (COR-2429, rows 38y and 40d of COR-2020): the one durable gate
 * every lookup of an agent by name consults.
 *
 * A built-in agent can be disabled but never deleted, and an agent file or a running plugin's agent
 * can be disabled too. A disabled agent stays listed (state `disabled`), its chats, memory, versions
 * and overrides can still be read, and enabling it brings it back as it was; until then no run,
 * chat, schedule, workflow step or hook can start on it, because the catalog's `find` does not hold
 * it.
 *
 * ## The record
 *
 * `bureau-agent-disabled:v1:<identifier>` holds, as JSON, a {@link AgentDisabledRecord}: the
 * agent's `id`, when it was disabled and by whom. The identifier is percent-encoded
 * (`encodeURIComponent`), so a plugin agent's `plugin:name` holds no `:`. An agent with no record
 * is enabled; enabling deletes the record. The records are read when the catalog loads and again on
 * `refresh`, and the one record of an agent is read again before a run of it starts, so a change
 * another Bureau on the same store made applies from there.
 *
 * @module agent-disabled-store
 */

import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import { z } from 'zod';

/** Where the disabled agents' records live. */
export const AGENT_DISABLED_KEY_PREFIX = 'bureau-agent-disabled:v1:';

/** One disabled agent, as the store holds it. */
export interface AgentDisabledRecord {
  /** The agent's identifier. */
  readonly id: string;
  /** When it was disabled, as an ISO timestamp. */
  readonly disabledAt: string;
  /** Who disabled it: the caller's owner string. */
  readonly disabledBy: string;
}

const recordSchema = z.object({
  id: z.string().min(1),
  disabledAt: z.string(),
  disabledBy: z.string(),
});

/** The key of `id`'s record. */
export function agentDisabledKey(id: string): string {
  return `${AGENT_DISABLED_KEY_PREFIX}${encodeURIComponent(id)}`;
}

function parseRecord(text: string | null): AgentDisabledRecord | undefined {
  if (text === null) return undefined;
  try {
    const parsed = recordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The disabled agents of one Bureau, read from and written to its key-value store. */
export interface AgentDisabledStore {
  /** Read every record again; resolves once {@link isDisabled} answers from them. */
  load(): Promise<void>;
  /** Read the record of `id` again, so a change another Bureau made applies. */
  reload(id: string): Promise<void>;
  /** Whether `id` is disabled, as last read. Synchronous: every lookup by name asks it. */
  isDisabled(id: string): boolean;
  /** The record of `id`, as last read, or `undefined` when it is enabled. */
  record(id: string): AgentDisabledRecord | undefined;
  /**
   * Disable `id`. Disabling an agent that is already disabled keeps its first record and writes
   * nothing. The write is fenced on what was read, so of two disables at once exactly one writes:
   * it resolves `changed: true`, and the other `changed: false` with the first one's record.
   */
  disable(id: string, options: { readonly disabledBy: string }): Promise<AgentDisabledToggle>;
  /**
   * Enable `id`, resolving whether this call changed anything. Enabling an agent that is not
   * disabled writes nothing; of two enables at once exactly one resolves `true`.
   */
  enable(id: string): Promise<boolean>;
}

/** What {@link AgentDisabledStore.disable} did: the agent's record, and whether this call wrote it. */
export interface AgentDisabledToggle {
  readonly record: AgentDisabledRecord;
  readonly changed: boolean;
}

/** How many times a fenced write is tried again when the record moved under it. */
const FENCED_WRITE_ATTEMPTS = 3;

export interface AgentDisabledStoreOptions {
  /** The store. Defaults to a memory store, which a restart forgets. */
  readonly store?: ConditionalTextValueStore | undefined;
  /** The Bureau's clock. */
  readonly nowISO: () => string;
}

export function createAgentDisabledStore(options: AgentDisabledStoreOptions): AgentDisabledStore {
  const store = options.store ?? textValueStore(new MemoryStorage());
  // A Map, so an agent named `constructor` or `__proto__` reads no inherited member.
  let disabled = new Map<string, AgentDisabledRecord>();

  return {
    async load() {
      const next = new Map<string, AgentDisabledRecord>();
      for (const key of await store.list(AGENT_DISABLED_KEY_PREFIX)) {
        const record = parseRecord(await store.get(key));
        // A record under another agent's key is not this agent's gate.
        if (record !== undefined && agentDisabledKey(record.id) === key)
          next.set(record.id, record);
      }
      disabled = next;
    },
    async reload(id) {
      const record = parseRecord(await store.get(agentDisabledKey(id)));
      if (record === undefined || record.id !== id) disabled.delete(id);
      else disabled.set(id, record);
    },
    isDisabled(id) {
      return disabled.has(id);
    },
    record(id) {
      return disabled.get(id);
    },
    async disable(id, disableOptions) {
      const key = agentDisabledKey(id);
      for (let attempt = 0; attempt < FENCED_WRITE_ATTEMPTS; attempt += 1) {
        const text = await store.get(key);
        const existing = parseRecord(text);
        if (existing !== undefined && existing.id === id) {
          disabled.set(id, existing);
          return { record: existing, changed: false };
        }
        const record: AgentDisabledRecord = {
          id,
          disabledAt: options.nowISO(),
          disabledBy: disableOptions.disabledBy,
        };
        // Written only over what was read (nothing, or a record that is not this agent's), so a
        // disable that lost the race reads the winner's record on the next pass.
        const committed = await store.conditionalBatch(
          [{ key, expectedValue: text }],
          [{ type: 'set', key, value: JSON.stringify(record) }],
        );
        if (committed) {
          disabled.set(id, record);
          return { record, changed: true };
        }
      }
      throw new Error(`The disabled record of agent "${id}" kept changing; try again.`);
    },
    async enable(id) {
      const key = agentDisabledKey(id);
      for (let attempt = 0; attempt < FENCED_WRITE_ATTEMPTS; attempt += 1) {
        const text = await store.get(key);
        if (text === null) {
          disabled.delete(id);
          return false;
        }
        const committed = await store.conditionalBatch(
          [{ key, expectedValue: text }],
          [{ type: 'delete', key }],
        );
        if (committed) {
          disabled.delete(id);
          // A key that held no readable record of this agent was no gate on it.
          const held = parseRecord(text);
          return held !== undefined && held.id === id;
        }
      }
      throw new Error(`The disabled record of agent "${id}" kept changing; try again.`);
    },
  };
}
