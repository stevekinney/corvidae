/**
 * `bureau.memory.*`: what an agent remembers, served to the owner whose chats wrote it (COR-1546).
 *
 * A run writes its memory into the partition of its Bureau and its owner of record, under the
 * collection named for its agent, so an agent remembers across every chat its owner has with it.
 * These operations read and change exactly that partition, through the same governed memory the
 * runs write into, so every rule governed memory applies (the one resource predicate, admission,
 * receipted deletion, the ledger) applies here and none is restated.
 *
 * The caller is the owner and never a field. Each operation builds a memory authority with
 * principal kind `user`, `tenantId` the Bureau's identifier, `ownerId` the caller's owner string
 * and projection `bureau`, holding only the memory capabilities the operation needs. Two things
 * about access depart from the rest of the management plane, deliberately:
 *
 * - A scope is required, not an alternative to ownership. `bureau.memory:read` serves `list`,
 *   `search` and `get`, and `bureau.memory:write` serves `forget` and `correct`. A caller without
 *   the operation's scope is answered `Forbidden`, though every record is its own. Neither scope
 *   grants another owner's memory.
 * - Another owner's record is answered `NotFound`, in the words of a missing one, because the
 *   governed predicate scopes every read to the caller's own partition.
 *
 * A Bureau composed without governed memory answers `UnsupportedCapability`.
 *
 * @module memory-operations
 */

import {
  createMemoryAuthority,
  type GovernedMemory,
  type GovernedMemoryRecord,
  MEMORY_CLASSES,
  MEMORY_DELETION_TARGETS,
  MEMORY_SOURCE_KINDS,
  MEMORY_TRUST_LEVELS,
  type MemoryAuthority,
  type MemoryCapability,
  type MemoryDeletionReceipt,
  type MemoryGovernanceEvent,
} from '@lostgradient/memory';
import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import type { BureauScope } from '../bureau-scopes.ts';
import { ownerOfPrincipal } from '../owner-predicate.ts';
import {
  DEFAULT_PAGE_LIMIT,
  pageFields,
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';
import { holdsScope } from './tasks-operations.ts';

/** What the memory operations read from the handler's `host`. */
export type BureauMemoryOperationHost = {
  readonly memory: {
    /** The Bureau's governed memory, or `undefined` for one composed without it. */
    readonly governed: GovernedMemory | undefined;
    /** The Bureau's identifier: the tenant every run's memory is partitioned under. */
    readonly tenantId: string;
  };
};

/** The authorization revision a memory authority from this surface records on what it does. */
const MEMORY_AUTHORIZATION_REVISION = 'bureau.memory:1';

const agentIdentifier = z
  .string()
  .min(1)
  .max(256)
  .describe('The identifier of the agent whose memory this addresses.');
const recordIdentifier = z.string().min(1).max(256).describe('The identifier of the memory.');
/** A text that is not blank: governed memory refuses one, and the boundary says so first. */
const nonBlankText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((text) => text.trim().length > 0, { message: 'Must not be blank' });

/** The longest a correction may be, which is the default admission policy's own limit. */
const MAXIMUM_CONTENT_LENGTH = 32_768;

const deletionStatus = z.enum(['completed', 'pending', 'exempt', 'failed', 'unknown']);

/**
 * One memory, as the management plane shows it. It is built field by field from a governed record,
 * so no governance envelope, attribution, digest or internal metadata leaves the Bureau: only the
 * fields a person needs to judge a memory, and the session that produced it.
 */
export const memoryViewSchema = z.object({
  id: z.string(),
  content: z.string(),
  memoryClass: z.enum(MEMORY_CLASSES),
  source: z.enum(MEMORY_SOURCE_KINDS),
  trust: z.enum(MEMORY_TRUST_LEVELS),
  createdAt: z.string(),
  /** The chat that produced it: the persist hook writes it into the record, because the collection is the agent. */
  sessionId: z.string().nullable(),
});

type MemoryView = z.infer<typeof memoryViewSchema>;

const isoTime = (milliseconds: number): string => new Date(milliseconds).toISOString();

function viewOf(record: GovernedMemoryRecord): MemoryView {
  const sessionId = record.metadata['sessionId'];
  return {
    id: record.id,
    content: record.content,
    memoryClass: record.memoryClass,
    source: record.source,
    trust: record.trust,
    createdAt: isoTime(record.createdAt),
    sessionId: typeof sessionId === 'string' ? sessionId : null,
  };
}

/**
 * A deletion receipt, as data. It names the record by identifier, collection and class, and each
 * target by where it stands: the receipt's content digests, its plan, and who requested it are not
 * part of the view, because a digest is a fingerprint of the content just deleted.
 */
export const memoryReceiptSchema = z.object({
  deletionId: z.string(),
  scope: z.enum(['source', 'projection']),
  trigger: z.enum(['request', 'retention-expiry', 'hold-release']),
  record: z.object({
    id: z.string(),
    collection: z.string(),
    memoryClass: z.enum(MEMORY_CLASSES),
  }),
  requestedAt: z.string(),
  boundMilliseconds: z.number(),
  /** True when a legal hold stopped the deletion: every target not yet settled is exempt until release. */
  awaitingHoldRelease: z.boolean(),
  /** True while any target is still pending. */
  open: z.boolean(),
  updatedAt: z.string(),
  targets: z.array(
    z.object({
      target: z.enum(MEMORY_DELETION_TARGETS),
      lane: z.enum(['synchronous', 'bounded-async']),
      status: deletionStatus,
      deadline: z.string().optional(),
      settledAt: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
});

function receiptViewOf(receipt: MemoryDeletionReceipt): z.infer<typeof memoryReceiptSchema> {
  return {
    deletionId: receipt.deletionId,
    scope: receipt.scope,
    trigger: receipt.trigger,
    record: {
      id: receipt.record.id,
      collection: receipt.record.collection,
      memoryClass: receipt.record.memoryClass,
    },
    requestedAt: isoTime(receipt.requestedAt),
    boundMilliseconds: receipt.boundMilliseconds,
    awaitingHoldRelease: receipt.awaitingHoldRelease,
    open: receipt.open,
    updatedAt: isoTime(receipt.updatedAt),
    targets: receipt.targets.map((target) => ({
      target: target.target,
      lane: target.lane,
      status: target.status,
      ...(target.deadline === undefined ? {} : { deadline: isoTime(target.deadline) }),
      ...(target.settledAt === undefined ? {} : { settledAt: isoTime(target.settledAt) }),
      ...(target.detail === undefined ? {} : { detail: target.detail }),
    })),
  };
}

/** What a caller must hold, and what the operation then needs of governed memory. */
type Access = {
  readonly scope: Extract<BureauScope, 'bureau.memory:read' | 'bureau.memory:write'>;
  readonly capabilities: readonly MemoryCapability[];
};

const ACCESS = {
  list: { scope: 'bureau.memory:read', capabilities: ['memory:list'] },
  search: { scope: 'bureau.memory:read', capabilities: ['memory:search'] },
  // `get` also reads the record's own ledger events for its lineage, which `listEvents` serves
  // under `memory:list`.
  get: { scope: 'bureau.memory:read', capabilities: ['memory:get', 'memory:list'] },
  forget: { scope: 'bureau.memory:write', capabilities: ['memory:delete'] },
  // `correct` reads the record it supersedes, to carry its class, and the successor it wrote.
  correct: { scope: 'bureau.memory:write', capabilities: ['memory:get', 'memory:write'] },
} as const satisfies Record<string, Access>;

function forbidden(scope: Access['scope']): OperationFault {
  return {
    code: 'Forbidden',
    message: `This operation requires ${scope}`,
    data: { reason: `missing scope ${scope}` },
  };
}

function noMemory(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau keeps no governed memory',
    data: { capability: 'governed-memory' },
  };
}

/** What an authorized call acts with: the governed memory, and an authority for the caller's own partition. */
type Acting = {
  readonly memory: GovernedMemory;
  /** `undefined` for a principal that can own nothing: it has no partition, so there is nothing to show. */
  readonly authority: MemoryAuthority | undefined;
};

/**
 * Decides whether the caller may use `access` at all, before anything about the memory is: a missing
 * scope is `Forbidden` whatever the caller owns, and then a Bureau with no memory is
 * `UnsupportedCapability`.
 */
function acting(host: BureauMemoryOperationHost, principal: Principal, access: Access): Acting {
  if (!holdsScope(principal, access.scope)) throw forbidden(access.scope);
  const memory = host.memory.governed;
  if (memory === undefined) throw noMemory();
  const owner = ownerOfPrincipal(principal);
  if (owner === undefined) return { memory, authority: undefined };
  return {
    memory,
    authority: createMemoryAuthority({
      principal: { kind: 'user', id: owner },
      tenantId: host.memory.tenantId,
      ownerId: owner,
      purpose: 'bureau.memory',
      capabilities: access.capabilities,
      policyRevision: MEMORY_AUTHORIZATION_REVISION,
      projection: 'bureau',
    }),
  };
}

/** The lineage a record's ledger events name. */
type Lineage = {
  /** The run that wrote it, from its write event; `null` for a record an operator wrote. */
  readonly runId: string | null;
  /** The record this one corrects, from the supersession event that admitted it. */
  readonly corrects: string | null;
  /** The record that corrects this one. */
  readonly correctedBy: string | null;
};

const lineageSchema = z.object({
  runId: z.string().nullable(),
  corrects: z.string().nullable(),
  correctedBy: z.string().nullable(),
});

/**
 * Reads a record's lineage from the events the owner's `listEvents` returns for it: the write
 * event's actor, and the supersession event's two record identifiers (the original first, then its
 * successor). The latest event of each kind wins, though a record has one of each.
 */
function lineageOf(id: string, events: readonly MemoryGovernanceEvent[]): Lineage {
  let runId: string | null = null;
  let corrects: string | null = null;
  let correctedBy: string | null = null;
  for (const event of events.toSorted((left, right) => left.at - right.at)) {
    if (event.type === 'memory.write.admitted' && event.recordIds[0] === id) {
      const actor = event.attribution?.principal;
      runId = actor?.kind === 'run' ? actor.id : null;
    }
    if (event.type === 'memory.forgotten' && event.details?.['mode'] === 'supersession') {
      const [original, successor] = event.recordIds;
      if (successor === id && original !== undefined) corrects = original;
      if (original === id && successor !== undefined) correctedBy = successor;
    }
  }
  return { runId, corrects, correctedBy };
}

const listInput = z.object({ agentId: agentIdentifier, ...pageFields });
const listOutput = z.object({
  memories: z.array(memoryViewSchema),
  nextOffset: z.number().int().nullable(),
});

export const memoryListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.list',
  mcpExposable: false,
  summary: 'List an agent’s memories',
  description:
    'Lists what the agent `agentId` remembers of the caller’s chats with it, newest first. Requires `bureau.memory:read`, which grants no one else’s memory: a caller without it is `Forbidden`. A memory that was corrected is not listed, its correction is; a quarantined or revoked one is not either. Pages with `limit` (1 to 100, default 50) and `offset`; `nextOffset` is `null` on the last page. A Bureau with no governed memory answers `UnsupportedCapability`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: listInput,
  outputSchema: listOutput,
  producibleFaults: ['InvalidParams', 'Forbidden', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { memory, authority } = acting(host, principal, ACCESS.list);
    if (authority === undefined) return { memories: [], nextOffset: null };
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = input.offset ?? 0;
    // One row past the page says whether another page follows.
    const rows = await memory.list(authority, {
      collection: input.agentId,
      visibility: 'private',
      limit: limit + 1,
      offset,
    });
    const page = rows.slice(0, limit);
    return {
      memories: page.map(viewOf),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  },
});

const searchInput = z.object({
  agentId: agentIdentifier,
  query: nonBlankText(1_000).describe('The text to rank the agent’s memories against.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('The most hits to return, from 1 to 100. Defaults to 10.'),
});
const searchOutput = z.object({
  hits: z.array(z.object({ memory: memoryViewSchema, score: z.number() })),
});

export const memorySearchOperation = defineOperation<
  typeof searchInput,
  typeof searchOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.search',
  mcpExposable: false,
  summary: 'Search an agent’s memories',
  description:
    'Ranks what the agent `agentId` remembers of the caller’s chats against `query`, best first, `limit` at most (1 to 100, default 10). Ranking has no score floor: every memory the agent has is a candidate, so a search that finds nothing means the agent has no memory at all. A memory that was corrected is not searched, its correction is. A blank `query` is `InvalidParams`. Requires `bureau.memory:read`; a caller without it is `Forbidden`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: searchInput,
  outputSchema: searchOutput,
  producibleFaults: ['InvalidParams', 'Forbidden', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { memory, authority } = acting(host, principal, ACCESS.search);
    if (authority === undefined) return { hits: [] };
    const hits = await memory.search(authority, input.query, {
      collection: input.agentId,
      visibility: 'private',
      limit: input.limit ?? 10,
    });
    return { hits: hits.map((hit) => ({ memory: viewOf(hit.record), score: hit.score })) };
  },
});

const getInput = z.object({ agentId: agentIdentifier, id: recordIdentifier });
const getOutput = z.object({ memory: memoryViewSchema, lineage: lineageSchema });

export const memoryGetOperation = defineOperation<
  typeof getInput,
  typeof getOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.get',
  mcpExposable: false,
  summary: 'Read one memory with its lineage',
  description:
    'Reads one memory of the agent `agentId` with its lineage: `memory` (its text, class, source, trust, creation time and the chat, `sessionId`, that produced it), and `lineage`, read from the governance ledger: `runId`, the run that wrote it (`null` for one an operator wrote); `corrects`, the memory this one replaced; and `correctedBy`, the memory that replaced it. A corrected memory is no longer listed or searched, but is read here, which is how a correction is followed back. Another owner’s memory, a missing one, and a quarantined or revoked one are answered `NotFound`. Requires `bureau.memory:read`; a caller without it is `Forbidden`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: getInput,
  outputSchema: getOutput,
  producibleFaults: ['InvalidParams', 'Forbidden', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { memory, authority } = acting(host, principal, ACCESS.get);
    if (authority === undefined) throw resourceNotFound('memory', input.id);
    const record = await memory.get(authority, { id: input.id, collection: input.agentId });
    if (record === undefined) throw resourceNotFound('memory', input.id);
    const events = await memory.listEvents(authority, { recordId: input.id });
    return { memory: viewOf(record), lineage: lineageOf(input.id, events) };
  },
});

const forgetInput = z.object({ agentId: agentIdentifier, id: recordIdentifier });
const forgetOutput = z.object({
  id: z.string(),
  /**
   * The status of the receipt row that removes the named record, in the deletion receipt's own
   * vocabulary: `completed` means it is gone, `exempt` that a legal hold holds it, `failed` that the
   * step that removes it failed, and `pending` that it is not settled yet.
   */
  deletion: deletionStatus,
  receipt: memoryReceiptSchema,
});

export const memoryForgetOperation = defineOperation<
  typeof forgetInput,
  typeof forgetOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.forget',
  mcpExposable: false,
  summary: 'Forget one memory',
  description:
    'Deletes one memory of the agent `agentId` as a source deletion, and answers the deletion `receipt` as data with `deletion`, the status of the receipt row that removes the record. Once `deletion` is `completed` the record never appears in a list, a search, a read or a recall. `exempt` means a legal hold keeps it stored and listed, and the deletion resumes when the hold is released; `failed` means the step that removes it failed, and forgetting it again retries; `pending` means it is not settled. The receipt’s other targets settle as Bureau’s maintenance pass runs: the copy of recalled text persisted in a conversation is not scrubbed, so that target stays pending until its deadline and then fails. Another owner’s memory and a missing one are answered `NotFound`; a memory derived from others is `Unprocessable`. Requires `bureau.memory:write`; a caller without it is `Forbidden`.',
  destructive: true,
  tags: ['Memory'],
  inputSchema: forgetInput,
  outputSchema: forgetOutput,
  producibleFaults: [
    'InvalidParams',
    'Forbidden',
    'NotFound',
    'Unprocessable',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { memory, authority } = acting(host, principal, ACCESS.forget);
    if (authority === undefined) throw resourceNotFound('memory', input.id);
    const result = await memory.forget(authority, {
      mode: 'source-deletion',
      locator: { id: input.id, collection: input.agentId },
    });
    if (result.status === 'not-found' || result.status === 'denied') {
      throw resourceNotFound('memory', input.id);
    }
    if (result.status === 'rejected') {
      throw {
        code: 'Unprocessable',
        message: 'This memory is derived from others, so it cannot be forgotten on its own',
        data: { reason: `memory-${result.reason ?? 'rejected'}` },
      } satisfies OperationFault;
    }
    if (result.receipt === undefined || result.deletion === undefined) {
      throw new Error('Governed memory answered a source deletion with no receipt.');
    }
    return { id: input.id, deletion: result.deletion, receipt: receiptViewOf(result.receipt) };
  },
});

const correctInput = z.object({
  agentId: agentIdentifier,
  id: recordIdentifier,
  content: nonBlankText(MAXIMUM_CONTENT_LENGTH).describe(
    'The corrected text, which supersedes the memory’s content.',
  ),
});
const correctOutput = z.object({
  /** The memory that was corrected, which is no longer listed. */
  id: z.string(),
  /** The correction, as listed now. */
  memory: memoryViewSchema,
});

export const memoryCorrectOperation = defineOperation<
  typeof correctInput,
  typeof correctOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.correct',
  mcpExposable: false,
  summary: 'Correct one memory',
  description:
    'Corrects one memory of the agent `agentId` by superseding it with `content`. The successor is written by the caller as an `operator` source, in the original’s memory class and the same collection; the original is kept for history, linked from the successor (`corrects`), and no longer listed, searched or recalled, so recall returns only the corrected content. A memory that was already corrected is a `Conflict` with `data.reason` `memory-superseded`. A correction that memory does not admit (its content policy, its quota) is `Unprocessable` with `data.reason` `memory-successor-not-admitted`, and the original stays in place. A blank `content` is `InvalidParams`. Another owner’s memory and a missing one are `NotFound`. Requires `bureau.memory:write`; a caller without it is `Forbidden`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: correctInput,
  outputSchema: correctOutput,
  producibleFaults: [
    'InvalidParams',
    'Forbidden',
    'NotFound',
    'Conflict',
    'Unprocessable',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { memory, authority } = acting(host, principal, ACCESS.correct);
    if (authority === undefined) throw resourceNotFound('memory', input.id);
    const locator = { id: input.id, collection: input.agentId };
    const original = await memory.get(authority, locator);
    if (original === undefined) throw resourceNotFound('memory', input.id);
    // `COR-43`'s transition engine runs on the evidence projection storage and is not wired into
    // governed memory, so a correction is governed memory's own supersession.
    const result = await memory.forget(authority, {
      mode: 'supersession',
      locator,
      successor: {
        content: input.content,
        collection: input.agentId,
        source: 'operator',
        memoryClass: original.memoryClass,
      },
    });
    if (result.status === 'not-found' || result.status === 'denied') {
      throw resourceNotFound('memory', input.id);
    }
    if (result.status === 'rejected') {
      if (result.reason === 'superseded') {
        throw {
          code: 'Conflict',
          message: 'This memory was already corrected',
          data: { reason: 'memory-superseded' },
        } satisfies OperationFault;
      }
      throw {
        code: 'Unprocessable',
        message: 'The correction was not admitted as a memory',
        data: { reason: 'memory-successor-not-admitted' },
      } satisfies OperationFault;
    }
    const successorId = result.write?.recordId;
    const successor =
      successorId === undefined
        ? undefined
        : await memory.get(authority, { id: successorId, collection: input.agentId });
    if (successor === undefined) {
      throw new Error('Governed memory answered a supersession with no readable successor.');
    }
    return { id: input.id, memory: viewOf(successor) };
  },
});

/** The five memory operations, in the order the documentation lists them. */
export const bureauMemoryOperations = [
  memoryListOperation,
  memorySearchOperation,
  memoryGetOperation,
  memoryForgetOperation,
  memoryCorrectOperation,
] as const;
