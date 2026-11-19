import { workspaceOwnerAuthority, type BureauWorkspaceHost } from '../workspace-principal.ts';
import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

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
 *   `search`, `get` and `export`, `bureau.memory:write` serves `remember`, `forget`, `correct`,
 *   `share`, `revokeShare` and `quarantine`, and `bureau.memory:govern` serves `hold`, `releaseHold`
 *   (COR-1809), `quarantine.release` and `list` with `state: 'quarantined'` (COR-2195). The two
 *   embedding operations, `embedding` and `embedding.cancel` (COR-2188), read and change the
 *   deployment's embedding, not an owner's records, so they take `bureau.settings:read` and
 *   `bureau.settings:write`, the scopes of the `memory.embedder` setting that starts the switch
 *   they cancel, and build no memory authority. A caller without the operation's scope is answered
 *   `Forbidden`, though every record is its own. No scope grants another owner's memory; the one
 *   door to it is a share, which lets
 *   the grantee `get` the record and nothing else.
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
  MEMORY_EMBEDDING_FAILURES,
  MEMORY_RELEASE_REJECTIONS,
  MEMORY_SOURCE_KINDS,
  MEMORY_TRUST_LEVELS,
  type MemoryAuthority,
  type MemoryCapability,
  type MemoryDeletionReceipt,
  type MemoryGovernanceEvent,
} from '@lostgradient/memory';
import { defineOperation, type OperationFault, type Principal } from '@lostgradient/backchannel';
import { z } from 'zod';

import type { BureauScope } from '../bureau-scopes.ts';
import { ownerOfPrincipal } from '../owner-predicate.ts';
import type { BureauAgentVisibilityHost } from './deployment-operations.ts';
import {
  historyOf,
  kindOf,
  MEMORY_KINDS,
  MEMORY_WRITERS,
  memoryClassOfKind,
  memoryExportFileName,
  memoryHistoryEntrySchema,
  supersessionsOf,
  writerOf,
} from './memory-history.ts';
import {
  DEFAULT_PAGE_LIMIT,
  pageFields,
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';
import { dryRunField, dryRunResult, effect, effectAtLeast, orDryRun } from './dry-run.ts';
import { holdsScope } from './tasks-operations.ts';

/** What the memory operations read from the handler's `host`. */
export type BureauMemoryOperationHost = BureauWorkspaceHost &
  BureauAgentVisibilityHost & {
    readonly memory: {
      /** The Bureau's governed memory, or `undefined` for one composed without it. */
      readonly governed: GovernedMemory | undefined;
      /** The Bureau's identifier: the tenant every run's memory is partitioned under. */
      readonly tenantId: string;
      /** Whether the Bureau's agent catalog holds an agent named `name`: `remember` writes for one. */
      readonly hasAgent: (name: string) => boolean;
    };
  };

/** The governance principal a legal hold from this surface is placed by; the ledger's `ownerId` names the caller. */
const GOVERNANCE_PRINCIPAL = 'governance:bureau.memory';

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

/** The longest a memory's text may be, which is the default admission policy's own limit. */
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
  /** Fact or How-to, from its class: `procedural` is a how-to, every other class a fact. */
  kind: z.enum(MEMORY_KINDS),
  source: z.enum(MEMORY_SOURCE_KINDS),
  /** Who wrote it, from its source: an `operator` write is a person's, a run's is the agent's. */
  writer: z.enum(MEMORY_WRITERS),
  /** The trust its writer earned it; it follows from the writer, and is carried beside it. */
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
    kind: kindOf(record.memoryClass),
    source: record.source,
    writer: writerOf(record.source),
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
  readonly scope: Extract<
    BureauScope,
    'bureau.memory:read' | 'bureau.memory:write' | 'bureau.memory:govern'
  >;
  readonly capabilities: readonly MemoryCapability[];
  /**
   * `governance` for the legal hold, which governed memory takes only from a chain made of
   * governance principals alone (COR-806). The authority stays bound to the caller's own owner, so
   * it reaches the caller's partition and no other; the scope is what lets a caller ask for it.
   */
  readonly principal?: 'governance';
};

const ACCESS = {
  list: { scope: 'bureau.memory:read', capabilities: ['memory:list'] },
  // Inspecting what was flagged, and the ledger events that say why, is a governance act: it takes
  // the scope a release takes, so a caller that may only read cannot see flagged content.
  listQuarantined: {
    scope: 'bureau.memory:govern',
    capabilities: ['memory:list', 'memory:inspect'],
  },
  search: { scope: 'bureau.memory:read', capabilities: ['memory:search'] },
  // `get` also reads the record's own ledger events for its lineage, which `listEvents` serves
  // under `memory:list`.
  get: { scope: 'bureau.memory:read', capabilities: ['memory:get', 'memory:list'] },
  // `remember` reads back the record it wrote, to answer it as the list shows it.
  remember: { scope: 'bureau.memory:write', capabilities: ['memory:get', 'memory:write'] },
  forget: { scope: 'bureau.memory:write', capabilities: ['memory:delete'] },
  // `correct` reads the record it supersedes, to carry its class, and the successor it wrote.
  correct: { scope: 'bureau.memory:write', capabilities: ['memory:get', 'memory:write'] },
  share: { scope: 'bureau.memory:write', capabilities: ['memory:share'] },
  quarantine: { scope: 'bureau.memory:write', capabilities: ['memory:quarantine'] },
  // Governed memory takes a release only with both capabilities: `memory:inspect` is the
  // inspection the release follows, and no Bureau scope is named for it, so the release is a
  // governance operation (`bureau.memory:govern`) acting as the caller's own user.
  releaseQuarantine: {
    scope: 'bureau.memory:govern',
    capabilities: ['memory:quarantine', 'memory:inspect'],
  },
  // `export` also reads the ledger's supersessions, which `listEvents` serves under `memory:list`,
  // to fold each corrected version into its correction's history.
  export: { scope: 'bureau.memory:read', capabilities: ['memory:export', 'memory:list'] },
  hold: {
    scope: 'bureau.memory:govern',
    capabilities: ['memory:legal-hold'],
    principal: 'governance',
  },
} as const satisfies Record<string, Access>;

function forbidden(scope: BureauScope): OperationFault {
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
  const governance = access.principal === 'governance';
  return {
    memory,
    authority: createMemoryAuthority({
      principal: governance
        ? { kind: 'governance', id: GOVERNANCE_PRINCIPAL }
        : { kind: 'user', id: owner },
      tenantId: host.memory.tenantId,
      ownerId: owner,
      purpose: governance ? 'bureau.memory.legal-hold' : 'bureau.memory',
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

const listInput = z.object({
  agentId: agentIdentifier,
  ...pageFields,
  state: z
    .enum(['quarantined'])
    .optional()
    .describe(
      'Lists only the memories in this state. Without it the list is what is in use. `quarantined` lists the caller’s quarantined memories, each with why it was quarantined, and needs `bureau.memory:govern`.',
    ),
});

/**
 * Why a memory is quarantined, as the owner is told: when, by what, and which guardrail held it.
 * It names the guardrail and the category it reported, and nothing a guardrail wrote about the
 * content or about its own failure.
 */
const quarantineSchema = z.object({
  /** When the memory was quarantined. */
  at: z.string(),
  /** What quarantined it: the admission checks, the owner, or a recall guardrail. */
  by: z.enum(['admission', 'owner', 'recall']),
  /** The guardrail that held it, or `null` when the owner quarantined it. */
  detector: z.string().nullable(),
  /** The category that guardrail reported, or `null` when the owner quarantined it. */
  category: z.string().nullable(),
});

const listOutput = z.object({
  memories: z.array(memoryViewSchema.extend({ quarantine: quarantineSchema.optional() })),
  nextOffset: z.number().int().nullable(),
});

type Quarantine = z.infer<typeof quarantineSchema>;

/**
 * How each quarantined record came to be one, from the latest ledger event that quarantined it:
 * a write the admission checks held, a quarantine its owner asked for (which reaches what was
 * derived from it too), or a recall guardrail that withheld it. A record the ledger does not
 * explain has no entry.
 */
async function quarantinesOf(
  memory: GovernedMemory,
  authority: MemoryAuthority,
  ids: readonly string[],
): Promise<Map<string, Quarantine>> {
  const found = new Map<string, { quarantine: Quarantine; at: number }>();
  const sources = [
    { type: 'memory.write.quarantined', by: 'admission' },
    { type: 'memory.quarantined', by: 'owner' },
    { type: 'memory.recall.withheld', by: 'recall' },
  ] as const;
  for (const { type, by } of sources) {
    for (const event of await memory.listEvents(authority, { type })) {
      if (type === 'memory.recall.withheld' && event.outcome !== 'quarantined') continue;
      for (const id of event.recordIds.filter((recordId) => ids.includes(recordId))) {
        if ((found.get(id)?.at ?? -1) > event.at) continue;
        found.set(id, {
          at: event.at,
          quarantine: {
            at: isoTime(event.at),
            by,
            detector: event.diagnostic?.detector ?? null,
            category: event.diagnostic?.category ?? null,
          },
        });
      }
    }
  }
  return new Map([...found].map(([id, { quarantine }]) => [id, quarantine]));
}

export const memoryListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.list',
  authorize: authorizeWorkspaceOperation('bureau.memory.list'),
  mcpExposable: false,
  summary: 'List an agent’s memories',
  description:
    'Lists what the agent `agentId` remembers of the caller’s chats with it, newest first. Requires `bureau.memory:read`, which grants no one else’s memory: a caller without it is `Forbidden`. A memory that was corrected is not listed, its correction is; a quarantined or revoked one is not either. With `state` `quarantined` it lists instead the caller’s quarantined memories, newest first, each with `quarantine`: `at` (when it was quarantined), `by` (`admission` when the admission checks held it as it was written, `owner` when the caller or an earlier quarantine of what it derives from did, `recall` when a recall guardrail withheld it), and `detector` and `category`, the guardrail that held it and the category it reported, both `null` when `by` is `owner`; `quarantine` is absent when the ledger does not explain the memory. They are the memories `bureau.memory.quarantine.release` can release. Inspecting flagged content is a governance act, so `state` `quarantined` requires `bureau.memory:govern` instead of `bureau.memory:read`: a caller without it is `Forbidden` whether or not it has quarantined memories, and a caller that holds only `bureau.memory:read` still lists what is in use as before. Pages with `limit` (1 to 100, default 50) and `offset`; `nextOffset` is `null` on the last page. A Bureau with no governed memory answers `UnsupportedCapability`.',
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
    const quarantined = input.state === 'quarantined';
    const { memory, authority } = acting(
      host,
      principal,
      quarantined ? ACCESS.listQuarantined : ACCESS.list,
    );
    if (authority === undefined) return { memories: [], nextOffset: null };
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = input.offset ?? 0;
    // One row past the page says whether another page follows.
    const rows = await memory.list(authority, {
      collection: input.agentId,
      visibility: 'private',
      limit: limit + 1,
      offset,
      ...(quarantined ? { state: 'quarantined' as const } : {}),
    });
    const page = rows.slice(0, limit);
    const why = quarantined
      ? await quarantinesOf(
          memory,
          authority,
          page.map((record) => record.id),
        )
      : new Map<string, Quarantine>();
    return {
      memories: page.map((record) => {
        const quarantine = why.get(record.id);
        return quarantine === undefined ? viewOf(record) : { ...viewOf(record), quarantine };
      }),
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
  authorize: authorizeWorkspaceOperation('bureau.memory.search'),
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

const getInput = z.object({
  agentId: agentIdentifier,
  id: recordIdentifier,
  ownerId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'The owner of the memory, for a grantee reading a memory another owner shared with it (`bureau.memory.share`). Omit it to read the caller’s own.',
    ),
});
const getOutput = z.object({
  memory: memoryViewSchema,
  lineage: lineageSchema,
  /** Each version a correction replaced, the most recent first; empty for a memory never corrected. */
  history: z.array(memoryHistoryEntrySchema),
});

export const memoryGetOperation = defineOperation<
  typeof getInput,
  typeof getOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.get',
  authorize: authorizeWorkspaceOperation('bureau.memory.get'),
  mcpExposable: false,
  summary: 'Read one memory with its lineage',
  description:
    'Reads one memory of the agent `agentId` with its lineage and history: `memory` (its text, class and `kind`, source and `writer`, trust, creation time and the chat, `sessionId`, that produced it); `lineage`, read from the governance ledger: `runId`, the run that wrote it (`null` for one an operator wrote), `corrects`, the memory this one replaced, and `correctedBy`, the memory that replaced it; and `history`, each earlier version a correction replaced, the most recent first, with its text, kind, writer, trust, when it was written and when it was corrected (empty for a memory never corrected). A person’s correction is written by the person, so it reads `writer` `person` and `trust` `verified` while its history keeps what the agent first wrote. A corrected memory is no longer listed or searched, but is read here, which is how a correction is followed back. Another owner’s memory, a missing one, and a quarantined or revoked one are answered `NotFound`, except a memory its owner shared with the caller (`bureau.memory.share`): the grantee names the owner in `ownerId` and reads it, with an empty `lineage`, since the ledger’s history is the owner’s alone, until the owner revokes the share. Requires `bureau.memory:read`; a caller without it is `Forbidden`.',
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
    const peerAuthority =
      host.workspaceAuthority?.(principal) ?? workspaceOwnerAuthority(undefined, principal);
    if (
      input.ownerId !== undefined &&
      peerAuthority !== undefined &&
      !(await peerAuthority(input.ownerId))
    )
      throw resourceNotFound('memory', input.id);
    const record = await memory.get(authority, {
      id: input.id,
      collection: input.agentId,
      ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    });
    if (record === undefined) throw resourceNotFound('memory', input.id);
    // The ledger's events are the owner's to read: a grantee reading another owner's memory gets
    // the memory and an empty lineage, because the write and supersession events carry the owner.
    const events = await memory.listEvents(authority, { recordId: input.id });
    const supersessions = supersessionsOf(
      await memory.listEvents(authority, { type: 'memory.forgotten' }),
    );
    const history = await historyOf(input.id, supersessions, (id) =>
      memory.get(authority, { id, collection: input.agentId }),
    );
    return { memory: viewOf(record), lineage: lineageOf(input.id, events), history };
  },
});

const rememberInput = z.object({
  agentId: agentIdentifier,
  content: nonBlankText(MAXIMUM_CONTENT_LENGTH).describe(
    'The text of the memory, in the caller’s own words.',
  ),
  kind: z
    .enum(MEMORY_KINDS)
    .optional()
    .describe('Whether the memory is a `fact` or a `how-to`. Defaults to `fact`.'),
});
const rememberOutput = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('added'),
    /** The new memory, as listed now. */
    memory: memoryViewSchema,
  }),
  z.object({
    outcome: z.literal('held'),
    /**
     * The quarantined record. No list, search, read or export shows it, so this is the only name
     * the caller has for it; `bureau.memory.forget` removes it.
     */
    id: z.string(),
  }),
]);

/** `bureau.memory.remember`: adds a memory from scratch, where `correct` needs one to replace. */
export const memoryRememberOperation = defineOperation<
  typeof rememberInput,
  typeof rememberOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.remember',
  authorize: authorizeWorkspaceOperation('bureau.memory.remember'),
  mcpExposable: false,
  summary: 'Add a memory',
  description:
    'Adds one memory to what the agent `agentId` remembers of the caller, in the caller’s own words, and answers `outcome` `added` with the memory as the list shows it. It is written by the caller as an `operator` source, so it is `verified` and governed memory’s ledger records a `memory.write.admitted` event under the caller’s owner; `bureau.memory.get` answers its `lineage` with a `null` `runId`. It is stored as the `kind` given, a `fact` (governed memory’s `semantic` class) by default or a `how-to` (its `procedural` class), either kept until a correction supersedes it and never swept as chat memory is, and belongs to no chat, so its `sessionId` is `null` and deleting a chat leaves it. A memory that memory does not admit (its content policy, its quota) is `Unprocessable` with `data.reason` `memory-not-admitted`, and nothing is stored. Content the admission detectors flag is stored quarantined for an inspector, and never listed, searched, read, exported or recalled, so the answer is `outcome` `held` with the stored record’s `id` and no `memory`; this is data and not a fault because only `reason` travels with a fault, and the `id` is the caller’s only name for the record. `bureau.memory.forget` with that `id` removes it (a quarantined memory is otherwise kept indefinitely, and only `bureau.memory.quarantine.release`, once it passes the admission checks again, returns it to use), and a caller that does not remove it leaves it stored. A blank `content`, or one longer than 32768 characters, is `InvalidParams`. An agent that is not in the catalog, or one the caller may not name, is `NotFound`. The call is not idempotent: repeating it adds the memory again. A caller that can own no memory is `Forbidden` with `data.reason` `no owner of record`. Requires `bureau.memory:write`; a caller without it is `Forbidden`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: rememberInput,
  outputSchema: rememberOutput,
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
    const { memory, authority } = acting(host, principal, ACCESS.remember);
    // Unlike a read, a write has no empty answer to give: there is no partition to put it in.
    if (authority === undefined) {
      throw {
        code: 'Forbidden',
        message: 'A memory needs an owner, and this credential names none',
        data: { reason: 'no owner of record' },
      } satisfies OperationFault;
    }
    // An agent the caller may not name (COR-1904) is as unknown to it as one the catalog lacks, and
    // a collection named for neither is a memory no run would ever recall.
    if (
      !host.agentVisibility.mayName(principal, input.agentId) ||
      !host.memory.hasAgent(input.agentId)
    ) {
      throw resourceNotFound('agent', input.agentId);
    }
    const receipt = await memory.write(authority, input.content, {
      collection: input.agentId,
      source: 'operator',
      memoryClass: memoryClassOfKind(input.kind ?? 'fact'),
    });
    // Not a fault: a fault's data carries only its reason on the wire, and the caller needs the
    // record's identifier to remove what was stored.
    if (receipt.status === 'quarantined') {
      if (receipt.recordId === undefined) {
        throw new Error('Governed memory quarantined a write with no record.');
      }
      return { outcome: 'held', id: receipt.recordId };
    }
    if (receipt.status === 'rejected') {
      throw {
        code: 'Unprocessable',
        message: 'The text was not admitted as a memory',
        data: { reason: 'memory-not-admitted' },
      } satisfies OperationFault;
    }
    const record =
      receipt.recordId === undefined
        ? undefined
        : await memory.get(authority, { id: receipt.recordId, collection: input.agentId });
    if (record === undefined) {
      throw new Error('Governed memory answered an admitted write with no readable record.');
    }
    return { outcome: 'added', memory: viewOf(record) };
  },
});

const forgetInput = z.object({
  agentId: agentIdentifier,
  id: recordIdentifier,
  dryRun: dryRunField,
});
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

const forgetAnswer = orDryRun(forgetOutput);

/** The fault a source deletion of the memory `id` is answered with when memory refuses it. */
function forgetRefusalOf(
  id: string,
  refusal: { readonly status: 'not-found' | 'denied' | 'rejected'; readonly reason?: string },
): OperationFault {
  if (refusal.status === 'rejected') {
    return {
      code: 'Unprocessable',
      message: 'This memory is derived from others, so it cannot be forgotten on its own',
      data: { reason: `memory-${refusal.reason ?? 'rejected'}` },
    };
  }
  return resourceNotFound('memory', id);
}

export const memoryForgetOperation = defineOperation<
  typeof forgetInput,
  typeof forgetAnswer,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.forget',
  authorize: authorizeWorkspaceOperation('bureau.memory.forget'),
  mcpExposable: false,
  supportsDryRun: true,
  summary: 'Forget one memory',
  description:
    'Deletes one memory of the agent `agentId` as a source deletion, and answers the deletion `receipt` as data with `deletion`, the status of the receipt row that removes the record. Once `deletion` is `completed` the record never appears in a list, a search, a read or a recall. `exempt` means a legal hold keeps it stored and listed, and the deletion resumes when the hold is released; `failed` means the step that removes it failed, and forgetting it again retries; `pending` means it is not settled. The receipt’s other targets settle as Bureau’s maintenance pass runs: the copy of recalled text persisted in a conversation is not scrubbed, so that target stays pending until its deadline and then fails. Another owner’s memory and a missing one are answered `NotFound`; a memory derived from others is `Unprocessable`. Requires `bureau.memory:write`; a caller without it is `Forbidden`. With `dryRun: true` nothing is deleted and no memory event is recorded, not even the denial of a refused call: the answer is `{ dryRun: true, target, effects }`, whose `memories` effect counts the record the deletion starts with, as a floor (`atLeast`): the summaries derived from it are removed with it and are not counted, and a legal hold on it keeps it stored; a memory that is missing, another owner’s or derived from others answers the fault the real call answers.',
  destructive: true,
  tags: ['Memory'],
  inputSchema: forgetInput,
  outputSchema: forgetAnswer,
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
    const locator = { id: input.id, collection: input.agentId };
    if (input.dryRun === true) {
      // The same decision the deletion makes, read without claiming, deleting or recording.
      const preview = await memory.previewSourceDeletion(authority, locator);
      if (preview.outcome === 'refused') throw forgetRefusalOf(input.id, preview);
      return dryRunResult({ kind: 'memory', id: input.id }, [
        // A floor: the summaries derived from the record go with it, and the preview does not list them.
        effectAtLeast('memories', preview.recordIds.length),
      ]);
    }
    const result = await memory.forget(authority, { mode: 'source-deletion', locator });
    if (
      result.status === 'not-found' ||
      result.status === 'denied' ||
      result.status === 'rejected'
    ) {
      throw forgetRefusalOf(input.id, {
        status: result.status,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
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
  authorize: authorizeWorkspaceOperation('bureau.memory.correct'),
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

/**
 * What a governance operation reports: the memory it addressed and whether this call changed it.
 * `changed` is `false` when the memory was already in the state asked for (a hold already held, a
 * share already granted): the call still succeeds, because the state is what the caller wanted.
 */
const transitionOutput = z.object({
  id: z.string(),
  changed: z.boolean(),
});

/** The faults a governance operation can answer, beyond the scope and capability ones. */
function transitionFault(
  result: { readonly status: string; readonly reason?: string | undefined },
  id: string,
): OperationFault {
  if (result.status === 'rejected' && result.reason === 'invalid-grantee') {
    return {
      code: 'Unprocessable',
      message: 'A memory cannot be shared with its own owner, or with no one',
      data: { reason: 'memory-invalid-grantee' },
    };
  }
  // `not-found`, and `denied` for another owner's memory or one no longer active: both read as a
  // missing memory, as everywhere else on this surface.
  return resourceNotFound('memory', id);
}

const shareInput = z.object({
  agentId: agentIdentifier,
  id: recordIdentifier,
  granteeOwnerId: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'The owner who may read this memory: another agent’s collection owner or, later, a user. Not the caller’s own owner.',
    ),
});
const shareOutput = transitionOutput.extend({
  granteeOwnerId: z.string(),
  /** The owner who granted or revoked: the caller. The ledger records the same owner on its event. */
  grantedBy: z.string(),
});

/** Runs a grant or a revoke and reports it; the two differ only in the governed call. */
async function changeShare(
  host: BureauMemoryOperationHost,
  principal: Principal,
  input: z.infer<typeof shareInput>,
  grant: boolean,
): Promise<z.infer<typeof shareOutput>> {
  const { memory, authority } = acting(host, principal, ACCESS.share);
  if (authority === undefined) throw resourceNotFound('memory', input.id);
  const peerAuthority =
    host.workspaceAuthority?.(principal) ?? workspaceOwnerAuthority(undefined, principal);
  if (grant && peerAuthority !== undefined && !(await peerAuthority(input.granteeOwnerId)))
    throw resourceNotFound('memory', input.id);
  const locator = { id: input.id, collection: input.agentId };
  const result = grant
    ? await memory.share(authority, locator, input.granteeOwnerId)
    : await memory.revokeShare(authority, locator, input.granteeOwnerId);
  if (result.status !== 'applied' && result.status !== 'unchanged') {
    throw transitionFault(result, input.id);
  }
  return {
    id: input.id,
    changed: result.status === 'applied',
    granteeOwnerId: input.granteeOwnerId,
    grantedBy: authority.ownerId,
  };
}

/** `bureau.memory.share`: lets another owner `get` one memory (COR-1809). */
export const memoryShareOperation = defineOperation<
  typeof shareInput,
  typeof shareOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.share',
  authorize: authorizeWorkspaceOperation('bureau.memory.share'),
  mcpExposable: false,
  summary: 'Share one memory with another owner',
  description:
    'Lets the owner `granteeOwnerId` read one memory of the agent `agentId` with `bureau.memory.get` (naming the caller as `ownerId`), and read nothing else of it: the grantee cannot list, search, correct, forget or re-share it. `grantedBy` is the caller’s owner, and governed memory’s ledger records a `memory.shared` event under the same owner. Granting twice is not an error: `changed` is `false`. An empty grantee is `InvalidParams`; the caller’s own owner is `Unprocessable` with `data.reason` `memory-invalid-grantee`. Another owner’s memory, a missing one, and a quarantined or revoked one are `NotFound`. Requires `bureau.memory:write`; a caller without it is `Forbidden`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: shareInput,
  outputSchema: shareOutput,
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
  invoke: ({ input, host, principal }) => changeShare(host, principal, input, true),
});

/** `bureau.memory.share.revoke`: withdraws a share (COR-1809). */
export const memoryRevokeShareOperation = defineOperation<
  typeof shareInput,
  typeof shareOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.share.revoke',
  authorize: authorizeWorkspaceOperation('bureau.memory.share.revoke'),
  mcpExposable: false,
  summary: 'Withdraw a shared memory from another owner',
  description:
    'Withdraws the read access `bureau.memory.share` gave `granteeOwnerId` to one memory of the agent `agentId`: from then on the grantee’s `bureau.memory.get` is `NotFound`. Revoking a share that was never granted is not an error: `changed` is `false`. `grantedBy` is the caller’s owner, who is the one revoking. The same faults as `bureau.memory.share`. Requires `bureau.memory:write`; a caller without it is `Forbidden`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: shareInput,
  outputSchema: shareOutput,
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
  invoke: ({ input, host, principal }) => changeShare(host, principal, input, false),
});

const holdInput = z.object({ agentId: agentIdentifier, id: recordIdentifier });
const holdOutput = transitionOutput.extend({
  /** `held` after a hold, `released` after a release. */
  legalHold: z.enum(['held', 'released']),
});

/** Places or lifts the legal hold on one of the caller's memories. */
async function changeHold(
  host: BureauMemoryOperationHost,
  principal: Principal,
  input: z.infer<typeof holdInput>,
  place: boolean,
): Promise<z.infer<typeof holdOutput>> {
  const { memory, authority } = acting(host, principal, ACCESS.hold);
  if (authority === undefined) throw resourceNotFound('memory', input.id);
  const locator = { id: input.id, collection: input.agentId };
  const result = place
    ? await memory.placeLegalHold(authority, locator)
    : await memory.releaseLegalHold(authority, locator);
  if (result.status !== 'applied' && result.status !== 'unchanged') {
    throw transitionFault(result, input.id);
  }
  return {
    id: input.id,
    changed: result.status === 'applied',
    legalHold: place ? 'held' : 'released',
  };
}

/** `bureau.memory.hold`: places a legal hold on one memory (COR-1809). */
export const memoryHoldOperation = defineOperation<
  typeof holdInput,
  typeof holdOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.hold',
  authorize: authorizeWorkspaceOperation('bureau.memory.hold'),
  mcpExposable: false,
  summary: 'Place a legal hold on one memory',
  description:
    'Places a legal hold on one memory of the agent `agentId`: until it is released, neither `bureau.memory.forget` nor a retention sweep deletes it (the deletion opens a receipt whose targets are `exempt` and resumes at release). Holding a memory already held is not an error: `changed` is `false`. The hold is placed by the Bureau’s governance principal for the caller’s own partition, and governed memory’s ledger records a `memory.legal-hold.placed` event under the caller’s owner. Another owner’s memory and a missing one are `NotFound`. Requires `bureau.memory:govern`, which no other memory scope implies; a caller without it is `Forbidden`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: holdInput,
  outputSchema: holdOutput,
  producibleFaults: ['InvalidParams', 'Forbidden', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ input, host, principal }) => changeHold(host, principal, input, true),
});

/** `bureau.memory.hold.release`: lifts a legal hold (COR-1809). */
export const memoryReleaseHoldOperation = defineOperation<
  typeof holdInput,
  typeof holdOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.hold.release',
  authorize: authorizeWorkspaceOperation('bureau.memory.hold.release'),
  mcpExposable: false,
  summary: 'Lift the legal hold on one memory',
  description:
    'Lifts the legal hold `bureau.memory.hold` placed on one memory of the agent `agentId`. A deletion that was waiting on the hold resumes in the same call. Releasing a memory that is not held is not an error: `changed` is `false`. Another owner’s memory and a missing one are `NotFound`. Requires `bureau.memory:govern`; a caller without it is `Forbidden`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: holdInput,
  outputSchema: holdOutput,
  producibleFaults: ['InvalidParams', 'Forbidden', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ input, host, principal }) => changeHold(host, principal, input, false),
});

const quarantineInput = z.object({
  agentId: agentIdentifier,
  id: recordIdentifier,
  reason: nonBlankText(1_000).describe(
    'Why the memory is quarantined. Governed memory keeps it in the ledger, redacted from everyone without inspection rights.',
  ),
});
const quarantineOutput = transitionOutput.extend({
  /** Every record the quarantine reached: the memory, and anything derived from it. */
  affected: z.number().int(),
});

/** `bureau.memory.quarantine`: takes one memory out of use (COR-1809). */
export const memoryQuarantineOperation = defineOperation<
  typeof quarantineInput,
  typeof quarantineOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.quarantine',
  authorize: authorizeWorkspaceOperation('bureau.memory.quarantine'),
  mcpExposable: false,
  summary: 'Quarantine one memory',
  description:
    'Takes one memory of the agent `agentId`, and everything derived from it, out of use pending inspection: it is no longer listed, searched, read or recalled, and the quarantine does not block deletion (`bureau.memory.forget` still removes it, and a legal hold still holds it). `bureau.memory.quarantine.release` is the way back to active use; until then the memory is kept for an inspector. Quarantining a memory already quarantined is not an error: `changed` is `false`. A blank `reason` is `InvalidParams`. Another owner’s memory and a missing one are `NotFound`. Requires `bureau.memory:write`; a caller without it is `Forbidden`.',
  destructive: true,
  tags: ['Memory'],
  inputSchema: quarantineInput,
  outputSchema: quarantineOutput,
  producibleFaults: ['InvalidParams', 'Forbidden', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { memory, authority } = acting(host, principal, ACCESS.quarantine);
    if (authority === undefined) throw resourceNotFound('memory', input.id);
    const result = await memory.quarantine(
      authority,
      { id: input.id, collection: input.agentId },
      input.reason,
    );
    if (result.status !== 'applied' && result.status !== 'unchanged') {
      throw transitionFault(result, input.id);
    }
    return {
      id: input.id,
      changed: result.status === 'applied',
      affected: result.status === 'applied' ? (result.recordIds?.length ?? 0) : 0,
    };
  },
});

/**
 * What a release that did not release answers: a rejection governed memory names from its closed
 * set is `Unprocessable` with that reason as `data.reason` (`memory-verification-failed` and the
 * others), and everything else, a missing memory, another owner’s, or a refusal, reads as a missing
 * memory. The detector that held the memory, and why it tripped, stay in the ledger.
 */
function releaseFault(
  result: { readonly status: string; readonly reason?: string | undefined },
  id: string,
): OperationFault {
  const reason = MEMORY_RELEASE_REJECTIONS.find((known) => known === result.reason);
  if (result.status === 'rejected' && reason !== undefined) {
    return {
      code: 'Unprocessable',
      message: 'This memory cannot be released from quarantine',
      data: { reason: `memory-${reason}` },
    };
  }
  return resourceNotFound('memory', id);
}

const releaseQuarantineInput = z.object({ agentId: agentIdentifier, id: recordIdentifier });

/** `bureau.memory.quarantine.release`: returns one inspected memory to use (COR-2195). */
export const memoryReleaseQuarantineOperation = defineOperation<
  typeof releaseQuarantineInput,
  typeof transitionOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.quarantine.release',
  authorize: authorizeWorkspaceOperation('bureau.memory.quarantine.release'),
  mcpExposable: false,
  summary: 'Release one quarantined memory',
  description:
    'Returns one quarantined memory of the agent `agentId` to active use after inspection, when the admission checks that apply now pass it: governed memory scans its text again, as the record’s own source and kind of memory, with the guardrails of the policy in force at the time of the call. The memory alone becomes active, is searchable and listed again, and a `memory.released` ledger event is recorded under the caller’s owner; memories derived from it stay quarantined. A memory the checks hold stays quarantined and is `Unprocessable` with `data.reason` `memory-verification-failed`, and the ledger’s `memory.release.rejected` event names the guardrail that held it for an inspector. Other refusals are `Unprocessable` too, with `data.reason` `memory-derived-record` (a memory derived from another record is never released, and releasing the one it came from leaves it quarantined), `memory-deletion-pending` (a deletion has claimed it), `memory-superseded` (a correction replaced it) and `memory-tampered` (its text no longer matches what was admitted); each records `memory.release.rejected`. Releasing a memory that is already active is not an error: `changed` is `false`. A memory that was revoked, another owner’s memory and a missing one are `NotFound`. Releasing again after a memory is quarantined again, whether by `bureau.memory.quarantine` or because recall withheld it, runs the checks again. Requires `bureau.memory:govern`, which no other memory scope implies; a caller without it is `Forbidden`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: releaseQuarantineInput,
  outputSchema: transitionOutput,
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
    const { memory, authority } = acting(host, principal, ACCESS.releaseQuarantine);
    if (authority === undefined) throw resourceNotFound('memory', input.id);
    const result = await memory.releaseQuarantine(authority, {
      id: input.id,
      collection: input.agentId,
    });
    if (result.status !== 'applied' && result.status !== 'unchanged') {
      throw releaseFault(result, input.id);
    }
    return { id: input.id, changed: result.status === 'applied' };
  },
});

const exportInput = z.object({ agentId: agentIdentifier });
const exportOutput = z.object({
  /** The manifest governed memory stored for this export, which a deletion scrubs a removed record from. */
  exportId: z.string().nullable(),
  /** The name to save the export under: `<agent>-memories.json`, such as `tool-runner-memories.json`. */
  fileName: z.string(),
  /** Every memory the list shows, each with its history; a corrected version is in its correction’s history. */
  memories: z.array(memoryViewSchema.extend({ history: z.array(memoryHistoryEntrySchema) })),
});

/** `bureau.memory.export`: exports an agent’s memories as data (COR-1809). */
export const memoryExportOperation = defineOperation<
  typeof exportInput,
  typeof exportOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.export',
  authorize: authorizeWorkspaceOperation('bureau.memory.export'),
  mcpExposable: false,
  summary: 'Export an agent’s memories',
  description:
    'Exports every memory in the caller’s own private partition of the agent `agentId` that the caller may read, as data, with `exportId`, the manifest governed memory stored (a memory deleted later is scrubbed from it), `fileName`, the name to save it under (`<agent>-memories.json`), and a `memory.exported` ledger event under the caller’s owner. Each memory carries its text, kind, writer, trust and `history`, as `bureau.memory.get` answers them, so the export holds the memories the list shows: a version that was corrected is exported in its correction’s `history`, not as a memory of its own (one whose correction is no longer stored is exported on its own). A quarantined or revoked memory is not exported. Memories shared with the caller are read with `bureau.memory.get` and are not exported. A caller that can own no memory exports an empty list with a `null` `exportId`; one with no memories of the agent gets a manifest of none. Requires `bureau.memory:read`; a caller without it is `Forbidden`.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: exportInput,
  outputSchema: exportOutput,
  producibleFaults: ['InvalidParams', 'Forbidden', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const fileName = memoryExportFileName(input.agentId);
    const { memory, authority } = acting(host, principal, ACCESS.export);
    if (authority === undefined) return { exportId: null, fileName, memories: [] };
    const result = await memory.export(authority, {
      collection: input.agentId,
      visibility: 'private',
    });
    if (result.status !== 'applied' || result.exportId === undefined) {
      throw new Error(`Governed memory answered an export ${result.status}.`);
    }
    const supersessions = supersessionsOf(
      await memory.listEvents(authority, { type: 'memory.forgotten' }),
    );
    const exported = new Map(result.records.map((record) => [record.id, record]));
    // A version is folded into its correction's history when that correction is exported too.
    const corrected = new Set(
      [...supersessions]
        .filter(([successorId]) => exported.has(successorId))
        .map(([, { originalId }]) => originalId),
    );
    const read = async (id: string) => exported.get(id);
    const memories = await Promise.all(
      result.records
        .filter((record) => !corrected.has(record.id))
        .toSorted((left, right) => right.createdAt - left.createdAt)
        .map(async (record) => ({
          ...viewOf(record),
          history: await historyOf(record.id, supersessions, read),
        })),
    );
    return { exportId: result.exportId, fileName, memories };
  },
});

const embeddingStatusInput = z.object({});
const embeddingStatusOutput = z.object({
  /** The embedding recall and admission use. */
  active: z.object({
    /** The registry id of its embedder, such as `ollama:embed`. */
    embedder: z.string(),
    /** How many entries each of its vectors has. */
    dimension: z.number().int(),
    /** The model that made its vectors; `null` for one stored before models were recorded and not adopted yet. */
    model: z.string().nullable(),
  }),
  /** What keeps the active embedding from working fully; `null` when nothing does. */
  problem: z.enum(['embedder-unavailable']).nullable(),
  /** The switch that is running, or the last one that failed or was cancelled; `null` when there is none. */
  job: z
    .object({
      /** The registry id of the embedder the switch re-embeds memory with. */
      target: z.string(),
      state: z.enum(['running', 'failed', 'cancelled']),
      /** How many stored memories the switch has embedded. */
      done: z.number().int(),
      /** How many memories are stored. */
      total: z.number().int(),
      /** Why a `failed` switch failed, as a code and never an embedder's text; `null` otherwise. */
      error: z.enum(MEMORY_EMBEDDING_FAILURES).nullable(),
    })
    .nullable(),
  /** Every registered embedder, in registry order, with whether memory could embed with it now. */
  embedders: z.array(
    z.object({
      id: z.string(),
      dimension: z.number().int(),
      availability: z.enum(['available', 'needs-setup']),
    }),
  ),
});

/**
 * The governed memory's embedding side for a caller holding `scope`: a missing scope is `Forbidden`
 * whatever the Bureau holds, then a Bureau with no memory is `UnsupportedCapability`. Neither
 * operation reads a record, so no memory authority is built: the embedding is the deployment's,
 * and `bureau.settings` scopes guard it as they guard the setting that names it.
 */
function embeddingOf(
  host: BureauMemoryOperationHost,
  principal: Principal,
  scope: Extract<BureauScope, 'bureau.settings:read' | 'bureau.settings:write'>,
): GovernedMemory['embedding'] {
  if (!holdsScope(principal, scope)) throw forbidden(scope);
  const memory = host.memory.governed;
  if (memory === undefined) throw noMemory();
  return memory.embedding;
}

/** `bureau.memory.embedding`: the active embedding, the switch to another, and what could replace it. */
export const memoryEmbeddingOperation = defineOperation<
  typeof embeddingStatusInput,
  typeof embeddingStatusOutput,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.embedding',
  authorize: authorizeWorkspaceOperation('bureau.memory.embedding'),
  mcpExposable: false,
  summary: 'Read the embedding memory uses, and the switch to another',
  description:
    'Returns the embedding recall and admission use as `active` (its `embedder`, `dimension` and `model`; `model` is `null` for a profile stored before models were recorded that no process has adopted one for), a `problem` (`embedder-unavailable` while that embedder is not loaded, is loaded with another dimension or model than made its vectors, or needs setup; recall then scores by text alone), the `job`, the switch to another embedder that is running or that last failed or was cancelled (`target`, `state`, `done` of `total` memories, and `error`, a code: `target-unavailable`, `target-missing`, `embedder-failed` or `embedder-timeout`, never an embedder’s own text), and every registered `embedders` entry with its `dimension` and whether it is `available` or `needs-setup`. Each of `problem` and `job` is `null` when there is none. A switch is started by writing the `memory.embedder` setting and cancelled by `bureau.memory.embedding.cancel`. Requires `bureau.settings:read`; a caller without it is `Forbidden`, whatever the Bureau holds.',
  destructive: false,
  tags: ['Memory'],
  inputSchema: embeddingStatusInput,
  outputSchema: embeddingStatusOutput,
  producibleFaults: ['Forbidden', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host, principal }) => {
    const embedding = embeddingOf(host, principal, 'bureau.settings:read');
    const status = await embedding.status();
    return {
      active: {
        embedder: status.active.embedder,
        dimension: status.active.dimension,
        model: status.active.model ?? null,
      },
      problem: status.problem ?? null,
      job:
        status.job === undefined
          ? null
          : {
              target: status.job.target,
              state: status.job.state,
              done: status.job.done,
              total: status.job.total,
              error: status.job.error ?? null,
            },
      embedders: embedding.embedders().map(({ id, dimension, availability }) => ({
        id,
        dimension,
        availability,
      })),
    };
  },
});

const embeddingCancelInput = z.object({ dryRun: dryRunField });
const embeddingCancelOutput = z.object({
  /** Whether this call cancelled a running switch. */
  cancelled: z.boolean(),
});
const embeddingCancelAnswer = orDryRun(embeddingCancelOutput);

/** `bureau.memory.embedding.cancel`: cancels the running switch to another embedder. */
export const memoryEmbeddingCancelOperation = defineOperation<
  typeof embeddingCancelInput,
  typeof embeddingCancelAnswer,
  BureauMemoryOperationHost
>({
  name: 'bureau.memory.embedding.cancel',
  authorize: authorizeWorkspaceOperation('bureau.memory.embedding.cancel'),
  mcpExposable: false,
  supportsDryRun: true,
  summary: 'Cancel the running switch to another embedder',
  description:
    'Cancels the running switch to another embedder and deletes the profile it was filling; memory keeps the embedding it had, which the switch never touched. `cancelled` is `true` when this call cancelled a running switch, and `false` when none was running, when it had failed or been cancelled already, or when it completed (or another call cancelled it) first; cancelling is not an error then. The `memory.embedder` setting still names the cancelled embedder until the next maintenance pass sets it back to the active one. Requires `bureau.settings:write`; a caller without it is `Forbidden`, whatever the Bureau holds. The operation has no target to name: it acts on the one switch the Bureau may be running. With `dryRun: true` nothing is cancelled: the answer is `{ dryRun: true, target, effects }`, whose target is the embedder the running switch fills (`none` when no switch runs) and whose `running-switches` effect is 1 while a switch runs and 0 otherwise.',
  destructive: true,
  tags: ['Memory'],
  inputSchema: embeddingCancelInput,
  outputSchema: embeddingCancelAnswer,
  producibleFaults: ['Forbidden', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const embedding = embeddingOf(host, principal, 'bureau.settings:write');
    if (input.dryRun === true) {
      const { job } = await embedding.status();
      return dryRunResult({ kind: 'memory-embedding-switch', id: job?.target ?? 'none' }, [
        effect('running-switches', job?.state === 'running' ? 1 : 0),
      ]);
    }
    return { cancelled: await embedding.cancel() };
  },
});

/** The fifteen memory operations, in the order the documentation lists them. */
export const bureauMemoryOperations = [
  memoryListOperation,
  memorySearchOperation,
  memoryGetOperation,
  memoryRememberOperation,
  memoryForgetOperation,
  memoryCorrectOperation,
  memoryShareOperation,
  memoryRevokeShareOperation,
  memoryHoldOperation,
  memoryReleaseHoldOperation,
  memoryQuarantineOperation,
  memoryReleaseQuarantineOperation,
  memoryExportOperation,
  memoryEmbeddingOperation,
  memoryEmbeddingCancelOperation,
] as const;
