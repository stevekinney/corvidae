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
  /** Disable `id`. Disabling an agent that is already disabled keeps its first record. */
  disable(id: string, options: { readonly disabledBy: string }): Promise<AgentDisabledRecord>;
  /** Enable `id`. Enabling an agent that is not disabled writes nothing. */
  enable(id: string): Promise<void>;
}

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
      const existing = parseRecord(await store.get(key));
      if (existing !== undefined && existing.id === id) {
        disabled.set(id, existing);
        return existing;
      }
      const record: AgentDisabledRecord = {
        id,
        disabledAt: options.nowISO(),
        disabledBy: disableOptions.disabledBy,
      };
      await store.set(key, JSON.stringify(record));
      disabled.set(id, record);
      return record;
    },
    async enable(id) {
      await store.delete(agentDisabledKey(id));
      disabled.delete(id);
    },
  };
}
