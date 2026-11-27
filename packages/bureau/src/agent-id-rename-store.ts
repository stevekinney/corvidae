/**
 * The durable fence around a saved file-agent identifier change (COR-2428).
 *
 * A definition source can only publish one object at a time.  This record is
 * deliberately written before that first publication: every process can then
 * make the same name-resolution decision while the old and new objects are
 * temporarily both present.  The executor owns advancing the phase; this
 * store owns only the conditional reservation and the durable phase record.
 */

import type { ConditionalTextValueStore } from '@lostgradient/storage';
import { z } from 'zod';

const AGENT_ID_RENAME_KEY_PREFIX = 'bureau-agent-id-rename:v1:';
const AGENT_ID_RENAME_COMPLETION_KEY_PREFIX = 'bureau-agent-id-rename-complete:v1:';

export const agentIdRenamePhases = ['prepared', 'target-published', 'cutover'] as const;
type AgentIdRenamePhase = (typeof agentIdRenamePhases)[number];

export interface AgentIdRenameRecord {
  readonly from: string;
  readonly to: string;
  readonly sourceHash: string;
  readonly phase: AgentIdRenamePhase;
}

const recordSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/u),
  phase: z.enum(agentIdRenamePhases),
});

function agentIdRenameKey(id: string): string {
  return `${AGENT_ID_RENAME_KEY_PREFIX}${encodeURIComponent(id)}`;
}

/** A completed rename is keyed by its immutable source/target pair, not either live name. */
function agentIdRenameCompletionKey(from: string, to: string): string {
  return `${AGENT_ID_RENAME_COMPLETION_KEY_PREFIX}${encodeURIComponent(from)}:${encodeURIComponent(to)}`;
}

function parse(text: string | null): AgentIdRenameRecord | undefined {
  if (text === null) return undefined;
  try {
    const parsed = recordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A durable, two-name reservation. */
export interface AgentIdRenameStore {
  /** The intent that reserves `id`, if any. */
  get(id: string): Promise<AgentIdRenameRecord | undefined>;
  /**
   * Reserve both identifiers. A retry of the exact request returns its
   * existing record; an overlapping request never overwrites it.
   */
  reserve(record: Omit<AgentIdRenameRecord, 'phase'>): Promise<AgentIdRenameRecord>;
  /** Advance only the exact durable intent the caller read. */
  advance(record: AgentIdRenameRecord, phase: AgentIdRenamePhase): Promise<AgentIdRenameRecord>;
  /** Clear the exact finished intent from both keys. */
  clear(record: AgentIdRenameRecord): Promise<boolean>;
  /** Commit a replay receipt while releasing the active two-name reservation. */
  complete(record: AgentIdRenameRecord): Promise<boolean>;
  /** The durable result of a completed exact rename, if it has one. */
  completed(from: string, to: string): Promise<AgentIdRenameRecord | undefined>;
}

export function createAgentIdRenameStore(store: ConditionalTextValueStore): AgentIdRenameStore {
  async function entries(id: string): Promise<AgentIdRenameRecord | undefined> {
    return parse(await store.get(agentIdRenameKey(id)));
  }
  function serialized(record: AgentIdRenameRecord): string {
    return JSON.stringify(record);
  }
  function sameIntent(left: AgentIdRenameRecord, right: AgentIdRenameRecord): boolean {
    return left.from === right.from && left.to === right.to && left.sourceHash === right.sourceHash;
  }

  return {
    get: entries,
    async reserve(input) {
      const record: AgentIdRenameRecord = { ...input, phase: 'prepared' };
      if (record.from === record.to)
        throw new Error('An agent identifier change needs two identifiers.');
      const fromKey = agentIdRenameKey(record.from);
      const toKey = agentIdRenameKey(record.to);
      for (let attempts = 0; attempts < 8; attempts += 1) {
        const [fromText, toText] = await Promise.all([store.get(fromKey), store.get(toKey)]);
        const from = parse(fromText);
        const to = parse(toText);
        if (from !== undefined && sameIntent(from, record)) return from;
        if (to !== undefined && sameIntent(to, record)) return to;
        if (from !== undefined || to !== undefined) {
          throw new Error(
            `An agent identifier change already reserves "${from?.from ?? to?.from}" or "${from?.to ?? to?.to}".`,
          );
        }
        if (
          await store.conditionalBatch(
            [
              { key: fromKey, expectedValue: fromText },
              { key: toKey, expectedValue: toText },
            ],
            [
              { type: 'set', key: fromKey, value: serialized(record) },
              { type: 'set', key: toKey, value: serialized(record) },
            ],
          )
        )
          return record;
      }
      throw new Error(
        `The identifier change from "${record.from}" to "${record.to}" kept changing.`,
      );
    },
    async advance(record, phase) {
      if (agentIdRenamePhases.indexOf(phase) < agentIdRenamePhases.indexOf(record.phase)) {
        throw new Error('An agent identifier change cannot move backwards.');
      }
      const next = { ...record, phase };
      const fromKey = agentIdRenameKey(record.from);
      const toKey = agentIdRenameKey(record.to);
      const before = serialized(record);
      if (
        !(await store.conditionalBatch(
          [
            { key: fromKey, expectedValue: before },
            { key: toKey, expectedValue: before },
          ],
          [
            { type: 'set', key: fromKey, value: serialized(next) },
            { type: 'set', key: toKey, value: serialized(next) },
          ],
        ))
      ) {
        const current = await entries(record.from);
        if (current !== undefined && sameIntent(current, record) && current.phase === phase)
          return current;
        throw new Error(
          `The identifier change from "${record.from}" to "${record.to}" changed concurrently.`,
        );
      }
      return next;
    },
    clear: async (record) =>
      store.conditionalBatch(
        [
          { key: agentIdRenameKey(record.from), expectedValue: serialized(record) },
          { key: agentIdRenameKey(record.to), expectedValue: serialized(record) },
        ],
        [
          { type: 'delete', key: agentIdRenameKey(record.from) },
          { type: 'delete', key: agentIdRenameKey(record.to) },
        ],
      ),
    complete: async (record) =>
      store.conditionalBatch(
        [
          { key: agentIdRenameKey(record.from), expectedValue: serialized(record) },
          { key: agentIdRenameKey(record.to), expectedValue: serialized(record) },
          { key: agentIdRenameCompletionKey(record.from, record.to), expectedValue: null },
        ],
        [
          { type: 'delete', key: agentIdRenameKey(record.from) },
          { type: 'delete', key: agentIdRenameKey(record.to) },
          {
            type: 'set',
            key: agentIdRenameCompletionKey(record.from, record.to),
            value: serialized(record),
          },
        ],
      ),
    completed: async (from, to) => parse(await store.get(agentIdRenameCompletionKey(from, to))),
  };
}
