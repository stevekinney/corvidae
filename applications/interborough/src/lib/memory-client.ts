/**
 * The browser's view of an agent's memory: the operations `bureau.memory.list`, `search`, `get`,
 * `forget` and `correct` (COR-1546), parsed at the boundary, and the faults they answer with,
 * sorted into the few the Memory page tells apart.
 *
 * The operations serve the caller's own memory under one agent. The caller is the host's one local
 * principal and is never a parameter. Reading needs `bureau.memory:read` and changing needs
 * `bureau.memory:write`; a caller without the scope is answered `Forbidden` whatever it owns.
 */
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

/** Where a call is sent from: an abort signal, and a `fetch` for a caller that is not a page. */
type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/**
 * One memory, as the Bureau shows it. The class, source and trust stay strings here: the page
 * words the ones it knows (`MEMORY_COPY`) and shows any other as the Bureau wrote it, so a value
 * the Bureau adds is never a parse failure.
 */
export const memorySchema = z.object({
  id: z.string(),
  content: z.string(),
  memoryClass: z.string(),
  source: z.string(),
  trust: z.string(),
  createdAt: z.string(),
  /** The chat that produced it, or `null` for a memory no chat wrote. */
  sessionId: z.string().nullable(),
});

/**
 * One memory as the Bureau shows it: its content, class, source, trust, creation time, and the
 * chat that produced it.
 */
export type Memory = z.infer<typeof memorySchema>;

const memoryPageSchema = z.object({
  memories: z.array(memorySchema),
  nextOffset: z.number().nullable(),
});

/** One page of memories and the offset of the next page, or `null` on the last. */
export type MemoryPage = z.infer<typeof memoryPageSchema>;

/**
 * How many memories a page of the list asks for. The memory page and an agent's page read the same
 * query (`queryKeys.memory.list`), so they ask for the same page size.
 */
export const MEMORY_PAGE_SIZE = 20;

/** One page of what the agent remembers of the caller's chats, newest first. */
export async function listMemories(
  agentId: string,
  page: { readonly limit?: number; readonly offset?: number } = {},
  options?: Options,
): Promise<MemoryPage> {
  return memoryPageSchema.parse(
    await callBureau('bureau.memory.list', { agentId, ...page }, options),
  );
}

const searchSchema = z.object({
  hits: z.array(z.object({ memory: memorySchema, score: z.number() })),
});

/** One search result: a memory and its score against the query. */
export type MemoryHit = z.infer<typeof searchSchema>['hits'][number];

/** The agent's memories ranked against `query`, best first. A blank `query` is refused by the Bureau. */
export async function searchMemories(
  agentId: string,
  query: string,
  page: { readonly limit?: number } = {},
  options?: Options,
): Promise<readonly MemoryHit[]> {
  return searchSchema.parse(
    await callBureau('bureau.memory.search', { agentId, query, ...page }, options),
  ).hits;
}

const lineageSchema = z.object({
  /** The run that wrote it, from the governance ledger, or `null` for a memory a person wrote. */
  runId: z.string().nullable(),
  /** The memory this one replaced. */
  corrects: z.string().nullable(),
  /** The memory that replaced this one. */
  correctedBy: z.string().nullable(),
});

/**
 * Where a memory came from: the run that wrote it, the memory it replaced, and the memory that
 * replaced it.
 */
export type MemoryLineage = z.infer<typeof lineageSchema>;

const memoryDetailSchema = z.object({ memory: memorySchema, lineage: lineageSchema });

/** One memory together with its lineage. */
export type MemoryDetail = z.infer<typeof memoryDetailSchema>;

/** One memory with its lineage. A corrected memory is read here though it is no longer listed. */
export async function getMemory(
  agentId: string,
  id: string,
  options?: Options,
): Promise<MemoryDetail> {
  return memoryDetailSchema.parse(await callBureau('bureau.memory.get', { agentId, id }, options));
}

/** The status of the deletion receipt row that removes the record, in the receipt's own vocabulary. */
export const deletionStateSchema = z.enum(['completed', 'pending', 'exempt', 'failed', 'unknown']);

const receiptSchema = z.object({
  deletionId: z.string(),
  awaitingHoldRelease: z.boolean(),
  open: z.boolean(),
  targets: z.array(
    z.object({
      target: z.string(),
      lane: z.string(),
      status: deletionStateSchema,
      detail: z.string().optional(),
    }),
  ),
});

const forgetSchema = z.object({
  id: z.string(),
  deletion: deletionStateSchema,
  receipt: receiptSchema,
});

/**
 * What forgetting a memory answers: the memory's identifier, the state of its deletion, and the
 * deletion's receipt.
 */
export type ForgetResult = z.infer<typeof forgetSchema>;

/** Forgets one memory as a source deletion; the answer says whether it is gone, held, or not yet settled. */
export async function forgetMemory(
  agentId: string,
  id: string,
  options?: Options,
): Promise<ForgetResult> {
  return forgetSchema.parse(await callBureau('bureau.memory.forget', { agentId, id }, options));
}

const correctSchema = z.object({ id: z.string(), memory: memorySchema });

/**
 * What correcting a memory answers: the identifier of the memory it replaced and the correction.
 */
export type CorrectResult = z.infer<typeof correctSchema>;

/** Replaces one memory with `content`; the answer is the correction, as the list shows it now. */
export async function correctMemory(
  agentId: string,
  id: string,
  content: string,
  options?: Options,
): Promise<CorrectResult> {
  return correctSchema.parse(
    await callBureau('bureau.memory.correct', { agentId, id, content }, options),
  );
}

/** What a thrown memory operation came to, sorted into what the page words. */
export type MemoryFault =
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  /** The memory was already corrected. */
  | { readonly kind: 'superseded' }
  /** Governed memory did not admit the correction. */
  | { readonly kind: 'successor-not-admitted' }
  | { readonly kind: 'other'; readonly message: string };

/** Sorts a thrown fault into the {@link MemoryFault} the Memory page shows. */
export function memoryFaultOf(error: unknown): MemoryFault {
  if (!(error instanceof HttpClientError)) {
    return {
      kind: 'other',
      message: error instanceof Error ? error.message : 'The server did not answer.',
    };
  }
  const data = error.data;
  switch (data?.['weftCode']) {
    case 'Forbidden':
      return { kind: 'forbidden' };
    case 'NotFound':
      return { kind: 'not-found' };
    case 'Conflict':
      return data['reason'] === 'memory-superseded'
        ? { kind: 'superseded' }
        : { kind: 'other', message: error.message };
    case 'Unprocessable':
      return data['reason'] === 'memory-successor-not-admitted'
        ? { kind: 'successor-not-admitted' }
        : { kind: 'other', message: error.message };
    default:
      return { kind: 'other', message: error.message };
  }
}
