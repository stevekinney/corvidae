/**
 * `bureau.audit.query`: the audit trail of a Bureau (COR-1482), always redacted to metadata.
 *
 * The handler's `bureau.audit.query` operation delegates here, so an in-process caller and a
 * wire caller read identical records for the same filter. What differs is who the reader is: the
 * handler derives the reader's owner from the request's principal and passes it as
 * {@link BureauAuditQueryOptions.owner}; an in-process caller, which is the host itself, passes none
 * and reads every record.
 *
 * What a record carries: when it happened, its type, the resource it is about (`resource`), the
 * actor, and a handful of scalar fields from an allowlist. Nothing else of the stored record
 * leaves the Bureau: no secret, transcript, tool argument, tool result, review prompt, or memory
 * content. A stored `detail` can hold any of them, so `detail` is rebuilt from the allowlist
 * and never filtered.
 *
 * Paging is by cursor: the position of the last record a page returned, in the trail's own
 * chronological order. A page is filled from the records the reader may see, so a cursor
 * advances across any number of records the owner filter drops.
 *
 * @module create-audit
 */

import type { AuditRecord, AuditTrail } from '../audit-trail.ts';
import type {
  AuditQuery,
  BureauAuditQueryOptions,
  AuditQueryPage,
  AuditQueryRecord,
  BureauAudit,
} from '../types.ts';

/** How many records a page holds when {@link AuditQuery.limit} is omitted. */
export const DEFAULT_AUDIT_PAGE_LIMIT = 50;

/** The most records one page may hold. */
export const MAXIMUM_AUDIT_PAGE_LIMIT = 100;

/** The most types one query may list in {@link AuditQuery.types}. */
export const MAXIMUM_AUDIT_TYPES = 64;

/** How many records one read of the trail asks for. */
const SCAN_CHUNK = 200;

/** The longest a scalar string in a record's `detail` may be. */
const DETAIL_VALUE_LIMIT = 200;

/**
 * The only fields of a stored `detail` that leave the Bureau, each a scalar that names something
 * rather than carries content. A field added to a stored record reaches no client until it is
 * added here on purpose.
 */
const DETAIL_ALLOWLIST: readonly string[] = [
  'agentName',
  'finishReason',
  'keys',
  'kind',
  'model',
  'provider',
  'revision',
  'scheduleId',
  'schemaSha256',
  'sessionId',
  'status',
  'toolName',
  // COR-1813: a worker deployment's rollout moves, which name the builds and the routing
  // generation they produced and carry no content.
  'deploymentName',
  'fromBuildId',
  'currentBuildId',
  'rampingBuildId',
  'previousBuildId',
  'rampBasisPoints',
  'generation',
  // COR-1939: a hook's changes and its exhausted deliveries, which name the hook and the delivery
  // and carry neither the URL (it may hold a token) nor any secret.
  'hookId',
  'deliveryId',
  'attempts',
  // COR-1818: a skill source's trust change, which names the source and the decision.
  'sourceId',
  'trusted',
  // COR-1930: a local-command tool source names the command line it runs, so the owner can see
  // what was added. It never holds an environment value or a credential.
  'commandLine',
  // COR-1931: removing a tool source names the agent files that listed its tools (identifiers
  // joined by commas, which an identifier cannot hold) and how many there were, because the
  // string is cut at the limit above.
  'affectedAgents',
  'affectedAgentCount',
  // COR-2009: an `a2a.call` names the task a remote call started and the name the caller gave
  // itself (`callerName`, its own claim; the record's `principal` is who authenticated).
  'taskId',
  'callerName',
  // COR-2009: an agent write names the saved version it made and the one before it, the keys that
  // changed, and the tool identifiers added or removed (comma-joined); the definition's text never
  // enters the trail, so the instructions' before and after are read from the agent's versions.
  'previousRevision',
  'changedKeys',
  'toolsAdded',
  'toolsRemoved',
  // COR-2009: a tool record names its call, which names the review an approval opened
  // (`approval:<runId>:<toolCallId>`), so "asked to refund" links to the review it waits in.
  'toolCallId',
  // COR-2009: what a `review.*` record names of its review, lifted from the stored `review` object
  // by {@link reviewDetailOf}: the review, its tool call and its signal.
  'reviewId',
  'callId',
  'signalName',
  // COR-2009: a `schedule.missed` record says how many occurrences were missed and why
  // (`late` or `dst-gap`; not `reason`, which on a review decision is a person's note).
  'missedCount',
  'missedReason',
  // COR-2009: a `memory.corrected` record names the memory the correction wrote, the one it
  // replaced, and whether a person or the agent wrote the correction; never the memory's text.
  'memoryId',
  'correctsId',
  'writer',
  // The version a host started at, which a `host.started` record carries so the log can say
  // "Interborough 2.4.1"; a release number, never content.
  'version',
];

/**
 * Fields that leave the Bureau for one event type only (COR-2018), because for any other they would
 * name nothing or carry content: a deleted chat's record keeps the chat's title (at most 80
 * characters, which the session summary cuts it to) and how many messages it held, so the log can
 * still say which chat was deleted once the chat is gone. Every other event's `title` or
 * `messageCount` is dropped as before.
 */
const EVENT_DETAIL_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  'session.deleted': ['title', 'messageCount'],
};

/** A scalar the projection keeps: a string cut to the limit, a number, or a boolean. */
function scalarOf(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string') return value.slice(0, DETAIL_VALUE_LIMIT);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

/**
 * The names a `review.*` record's stored `review` object carries, as top-level detail fields
 * (COR-2009): `reviewId`, `kind`, `agentName`, `sessionId`, `signalName`, and for a tool approval
 * `toolName` and `callId`. The object itself is never projected (it holds the tool's arguments
 * and the prompt), so without this a decision would name nothing but its status. Only these
 * identifiers are read, and only when they are scalars.
 */
function reviewDetailOf(review: unknown): Record<string, unknown> {
  if (typeof review !== 'object' || review === null) return {};
  const source = review as Record<string, unknown>;
  const approval =
    typeof source['approval'] === 'object' && source['approval'] !== null
      ? (source['approval'] as Record<string, unknown>)
      : {};
  return {
    reviewId: source['id'],
    kind: source['kind'],
    agentName: source['agentName'],
    sessionId: source['sessionId'],
    signalName: source['signalName'],
    toolName: approval['toolName'],
    callId: approval['callId'],
  };
}

function detailOf(detail: unknown, type: string): AuditQueryRecord['detail'] {
  if (typeof detail !== 'object' || detail === null) return null;
  // The record's own fields win over what is lifted from its `review`.
  const source = {
    ...reviewDetailOf((detail as Record<string, unknown>)['review']),
    ...Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== undefined)),
  };
  const projected: Record<string, string | number | boolean> = {};
  const allowed = Object.hasOwn(EVENT_DETAIL_ALLOWLIST, type)
    ? [...DETAIL_ALLOWLIST, ...EVENT_DETAIL_ALLOWLIST[type]!]
    : DETAIL_ALLOWLIST;
  for (const key of allowed) {
    const value = Object.hasOwn(source, key) ? scalarOf(source[key]) : undefined;
    if (value !== undefined) projected[key] = value;
  }
  return Object.keys(projected).length === 0 ? null : projected;
}

function viewOf(record: AuditRecord): AuditQueryRecord {
  return {
    sequence: record.sequence ?? null,
    timestamp: record.timestamp,
    type: record.type,
    resource: record.runId,
    principal: record.principal ?? null,
    detail: detailOf(record.detail, record.type),
  };
}

const CURSOR = /^(\d{1,16}):(-?\d{1,16})$/;

function encodeCursor(record: Pick<AuditRecord, 'timestampMs' | 'sequence'>): string {
  return `${record.timestampMs}:${record.sequence ?? -1}`;
}

/**
 * The trail position a cursor names, or `undefined` for a string that is not a cursor this module
 * wrote.
 */
export function decodeAuditCursor(
  cursor: string,
): { timestampMs: number; sequence: number } | undefined {
  const match = CURSOR.exec(cursor);
  return match === null ? undefined : { timestampMs: Number(match[1]), sequence: Number(match[2]) };
}

/**
 * Render audit records as JSON Lines: one JSON object per line, each terminated by a newline, with
 * the keys of {@link AuditQueryRecord} in a fixed order. It takes the records {@link BureauAudit.query}
 * already redacted, so an export carries exactly what the JSON read does and nothing else; an empty
 * list renders as the empty string.
 */
export function auditRecordsToJsonLines(records: readonly AuditQueryRecord[]): string {
  let body = '';
  for (const record of records) {
    body += `${JSON.stringify({
      sequence: record.sequence,
      timestamp: record.timestamp,
      type: record.type,
      resource: record.resource,
      principal: record.principal,
      detail: record.detail,
    })}\n`;
  }
  return body;
}

/** What {@link createAudit} composes `bureau.audit` from. */
export type AuditDependencies = {
  /** The Bureau's audit trail, read at each call, or `undefined` for a Bureau that keeps none. */
  readonly trail: () => Pick<AuditTrail, 'query'> | undefined;
  /** The owner of record of the resource an entry is about, or `undefined` when it has none. */
  readonly ownerOf: (entry: Pick<AuditRecord, 'runId' | 'detail'>) => Promise<string | undefined>;
  /** Build the error a refused query throws, as the Bureau's own error class. */
  readonly refusal: (message: string, code: 'BAD_REQUEST' | 'UNSUPPORTED_CAPABILITY') => Error;
};

/**
 * Build `bureau.audit`. `query` reads the trail oldest first (or newest first, for `order:
 * 'newest'`), drops the records `options.owner` does not own, and returns the survivors redacted
 * to metadata.
 */
export function createAudit(dependencies: AuditDependencies): BureauAudit {
  async function query(
    filter: AuditQuery = {},
    options: BureauAuditQueryOptions = {},
  ): Promise<AuditQueryPage> {
    const trail = dependencies.trail();
    if (trail === undefined) {
      throw dependencies.refusal('This Bureau keeps no audit trail', 'UNSUPPORTED_CAPABILITY');
    }
    // The caller owns `filter` and `options`; read them once, before the first await.
    const {
      runId,
      type,
      types,
      since,
      until,
      principal,
      cursor,
      limit = DEFAULT_AUDIT_PAGE_LIMIT,
      order = 'oldest',
      includeTotal = false,
    } = filter;
    const { owner } = options;
    const refuse = (message: string): Error => dependencies.refusal(message, 'BAD_REQUEST');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_AUDIT_PAGE_LIMIT) {
      throw refuse(`limit must be an integer from 1 to ${MAXIMUM_AUDIT_PAGE_LIMIT}`);
    }
    if (order !== 'oldest' && order !== 'newest') {
      throw refuse('order must be oldest or newest');
    }
    if (since !== undefined && (!Number.isInteger(since) || since < 0)) {
      throw refuse('since must be a non-negative integer of epoch milliseconds');
    }
    if (until !== undefined && (!Number.isInteger(until) || until < 0)) {
      throw refuse('until must be a non-negative integer of epoch milliseconds');
    }
    if (
      principal !== undefined &&
      (typeof principal !== 'string' || principal.length < 1 || principal.length > 512)
    ) {
      throw refuse('principal must be a string of 1 to 512 characters');
    }
    if (
      runId !== undefined &&
      (typeof runId !== 'string' || runId.length < 1 || runId.length > 512)
    ) {
      throw refuse('runId must be a string of 1 to 512 characters');
    }
    if (type !== undefined && (typeof type !== 'string' || type.length < 1 || type.length > 128)) {
      throw refuse('type must be a string of 1 to 128 characters');
    }
    if (
      types !== undefined &&
      (!Array.isArray(types) ||
        types.length > MAXIMUM_AUDIT_TYPES ||
        types.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 128))
    ) {
      throw refuse(
        `types must be a list of at most ${MAXIMUM_AUDIT_TYPES} strings of 1 to 128 characters`,
      );
    }
    const wantedTypes = types === undefined ? undefined : new Set<string>(types);
    const decoded = cursor === undefined ? undefined : decodeAuditCursor(cursor);
    if (cursor !== undefined && decoded === undefined) throw refuse('Invalid cursor');

    const owners = new Map<string, string | undefined>();
    const mayRead = async (record: AuditRecord): Promise<boolean> => {
      if (owner === undefined) return true;
      // A session's deletion entry names its owner in its own detail, so it cannot be cached by id.
      const cacheable = !record.runId.startsWith('session:');
      if (cacheable && owners.has(record.runId)) return owners.get(record.runId) === owner;
      const recordOwner = await dependencies.ownerOf(record);
      if (cacheable) owners.set(record.runId, recordOwner);
      return recordOwner !== undefined && recordOwner === owner;
    };

    /**
     * Walks the trail from `start` in `direction`, a chunk at a time, calling `visit` for each
     * record in range that the reader may see; `visit` answers `true` to stop. The position a
     * record moves the walk to is handed back with it, so a caller that stops can name where.
     */
    const walk = async (
      direction: 'oldest' | 'newest',
      start: { timestampMs: number; sequence: number } | undefined,
      visit: (record: AuditRecord) => boolean,
    ): Promise<void> => {
      let position = start;
      for (;;) {
        const chunk = await trail.query({
          ...(runId === undefined ? {} : { runId }),
          ...(type === undefined ? {} : { type }),
          ...(since === undefined ? {} : { since }),
          ...(direction === 'oldest'
            ? position === undefined
              ? {}
              : { after: position }
            : {
                select: 'newest' as const,
                ...(position === undefined ? {} : { before: position }),
              }),
          limit: SCAN_CHUNK,
        });
        // The trail answers each chunk oldest first; a newest-first walk reads it backward.
        const records = direction === 'newest' ? chunk.toReversed() : chunk;
        for (const record of records) {
          const here = { timestampMs: record.timestampMs, sequence: record.sequence ?? -1 };
          if (until !== undefined && record.timestampMs > until) {
            // Oldest first, the first record past `until` ends the walk: no later one is in range.
            // Newest first, every record past `until` is skipped until the walk comes back in range.
            if (direction === 'oldest') return;
            position = here;
            continue;
          }
          // The type list drops a record the way the actor filter does: the walk moves past it.
          if (wantedTypes !== undefined && !wantedTypes.has(record.type)) {
            position = here;
            continue;
          }
          // The actor filter drops a record the way the owner filter does: the walk moves past it.
          if (principal !== undefined && record.principal !== principal) {
            position = here;
            continue;
          }
          if (!(await mayRead(record))) {
            position = here;
            continue;
          }
          if (visit(record)) return;
          position = here;
        }
        if (chunk.length < SCAN_CHUNK) return;
      }
    };

    // A cursor names the last record the previous page returned. A newest-first query with no
    // cursor starts at `until`, so the walk does not read the records past it.
    const start =
      decoded ??
      (order === 'newest' && until !== undefined
        ? { timestampMs: until + 1, sequence: -1 }
        : undefined);

    const page: AuditRecord[] = [];
    let more = false;
    await walk(order, start, (record) => {
      // One more than the page: it is what says there is a next page.
      if (page.length === limit) {
        more = true;
        return true;
      }
      page.push(record);
      return false;
    });
    const last = page.at(-1);
    const nextCursor = more && last !== undefined ? encodeCursor(last) : null;

    let total: number | undefined;
    if (includeTotal) {
      let counted = 0;
      await walk('oldest', undefined, () => {
        counted += 1;
        return false;
      });
      total = counted;
    }
    return {
      records: page.map(viewOf),
      nextCursor,
      ...(total === undefined ? {} : { total }),
    };
  }

  return { query };
}
