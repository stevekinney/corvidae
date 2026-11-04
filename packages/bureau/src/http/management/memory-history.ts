/**
 * What the memory operations say about a memory beyond its governed record: its kind (Fact or
 * How-to), who wrote it, and its history of corrections.
 *
 * Trust is not a separate judgement a person makes: governed memory gives a record the trust its
 * source earns (an operator's write is `verified`, a run's is `untrusted`), so trust follows from the
 * writer. It is still carried beside the writer, because the two can differ: a correction an agent
 * writes over a memory a person wrote is the agent's, and its history holds the person's verified
 * original.
 *
 * A correction is governed memory's supersession: the original stays stored and readable by `get`,
 * and the ledger's `memory.forgotten` event in mode `supersession` names the original first and its
 * successor second. History is read from those events.
 *
 * @module memory-history
 */

import {
  type GovernedMemoryRecord,
  type MemoryClass,
  type MemoryGovernanceEvent,
  type MemorySourceKind,
  MEMORY_TRUST_LEVELS,
} from '@lostgradient/memory';
import { z } from 'zod';

/**
 * The two kinds a person tells memories apart by: a `fact` is something true (governed memory's
 * episodic, semantic and every other class), a `how-to` is a way of doing something (its
 * `procedural` class).
 */
export const MEMORY_KINDS = ['fact', 'how-to'] as const;

/** A memory's kind: {@link MEMORY_KINDS}. */
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** The kind a memory of `memoryClass` is. */
export function kindOf(memoryClass: MemoryClass): MemoryKind {
  return memoryClass === 'procedural' ? 'how-to' : 'fact';
}

/**
 * The class a memory a person writes as `kind` is kept in. Both are kept until a correction
 * supersedes them, never swept as chat memory (`episodic`) is.
 */
export function memoryClassOfKind(
  kind: MemoryKind,
): Extract<MemoryClass, 'semantic' | 'procedural'> {
  return kind === 'how-to' ? 'procedural' : 'semantic';
}

/**
 * Who wrote a memory: a `person` (the owner, writing through the management plane or correcting a
 * memory), the `agent` whose memory it is (a run writing from a chat, a tool or a document), or the
 * `system`.
 */
export const MEMORY_WRITERS = ['person', 'agent', 'system'] as const;

/** Who wrote a memory: {@link MEMORY_WRITERS}. */
export type MemoryWriter = (typeof MEMORY_WRITERS)[number];

/** Who wrote a memory of `source`. */
export function writerOf(source: MemorySourceKind): MemoryWriter {
  if (source === 'operator') return 'person';
  if (source === 'system') return 'system';
  return 'agent';
}

/** One earlier version of a memory: what it said before a correction replaced it. */
export const memoryHistoryEntrySchema = z.object({
  /** The identifier of the earlier version, which `bureau.memory.get` still reads. */
  id: z.string(),
  /** What it said. */
  content: z.string(),
  kind: z.enum(MEMORY_KINDS),
  writer: z.enum(MEMORY_WRITERS),
  trust: z.enum(MEMORY_TRUST_LEVELS),
  /** When it was written. */
  writtenAt: z.string(),
  /** When the correction replaced it. */
  correctedAt: z.string(),
});

/** One earlier version of a memory. */
export type MemoryHistoryEntry = z.infer<typeof memoryHistoryEntrySchema>;

/** The correction that replaced a memory: the memory it replaced, and when. */
type Supersession = { readonly originalId: string; readonly at: number };

/**
 * Reads, from ledger events, which memory each correction replaced: a map from the correction's
 * identifier to the original's. Events of other kinds are ignored.
 */
export function supersessionsOf(
  events: readonly MemoryGovernanceEvent[],
): ReadonlyMap<string, Supersession> {
  const supersessions = new Map<string, Supersession>();
  for (const event of events) {
    if (event.type !== 'memory.forgotten' || event.details?.['mode'] !== 'supersession') continue;
    const [originalId, successorId] = event.recordIds;
    if (originalId === undefined || successorId === undefined) continue;
    supersessions.set(successorId, { originalId, at: event.at });
  }
  return supersessions;
}

const isoTime = (milliseconds: number): string => new Date(milliseconds).toISOString();

/**
 * The history of the memory `id`: each version a correction replaced, the most recent first, read
 * with `read` (a version that can no longer be read ends the history there). A memory that was never
 * corrected has an empty history.
 */
export async function historyOf(
  id: string,
  supersessions: ReadonlyMap<string, Supersession>,
  read: (id: string) => Promise<GovernedMemoryRecord | undefined>,
): Promise<MemoryHistoryEntry[]> {
  const history: MemoryHistoryEntry[] = [];
  const seen = new Set([id]);
  let supersession = supersessions.get(id);
  while (supersession !== undefined && !seen.has(supersession.originalId)) {
    seen.add(supersession.originalId);
    const original = await read(supersession.originalId);
    if (original === undefined) break;
    history.push({
      id: original.id,
      content: original.content,
      kind: kindOf(original.memoryClass),
      writer: writerOf(original.source),
      trust: original.trust,
      writtenAt: isoTime(original.createdAt),
      correctedAt: isoTime(supersession.at),
    });
    supersession = supersessions.get(original.id);
  }
  return history;
}

/**
 * The name an export of the agent `agentId`'s memories is saved under: `<agent>-memories.json`,
 * with any character a file name should not hold (a namespace's `:`, a path separator) made a `-`.
 */
export function memoryExportFileName(agentId: string): string {
  return `${agentId.replaceAll(/[^A-Za-z0-9._-]/g, '-')}-memories.json`;
}
