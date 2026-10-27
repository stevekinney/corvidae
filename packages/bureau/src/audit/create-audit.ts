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
  'kind',
  'model',
  'provider',
  'scheduleId',
  'schemaSha256',
  'sessionId',
  'status',
  'toolName',
];

function detailOf(detail: unknown): AuditQueryRecord['detail'] {
  if (typeof detail !== 'object' || detail === null) return null;
  const projected: Record<string, string | number | boolean> = {};
  for (const key of DETAIL_ALLOWLIST) {
    const value = (detail as Record<string, unknown>)[key];
    if (typeof value === 'string') projected[key] = value.slice(0, DETAIL_VALUE_LIMIT);
    else if (typeof value === 'number' || typeof value === 'boolean') projected[key] = value;
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
    detail: detailOf(record.detail),
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
 * Build `bureau.audit`. `query` reads the trail oldest first, drops the records `options.owner`
 * does not own, and returns the survivors redacted to metadata.
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
    const { runId, type, since, cursor, limit = DEFAULT_AUDIT_PAGE_LIMIT } = filter;
    const { owner } = options;
    const refuse = (message: string): Error => dependencies.refusal(message, 'BAD_REQUEST');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_AUDIT_PAGE_LIMIT) {
      throw refuse(`limit must be an integer from 1 to ${MAXIMUM_AUDIT_PAGE_LIMIT}`);
    }
    if (since !== undefined && (!Number.isInteger(since) || since < 0)) {
      throw refuse('since must be a non-negative integer of epoch milliseconds');
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
    let after = cursor === undefined ? undefined : decodeAuditCursor(cursor);
    if (cursor !== undefined && after === undefined) throw refuse('Invalid cursor');

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

    const page: AuditRecord[] = [];
    for (;;) {
      const chunk = await trail.query({
        ...(runId === undefined ? {} : { runId }),
        ...(type === undefined ? {} : { type }),
        ...(since === undefined ? {} : { since }),
        ...(after === undefined ? {} : { after }),
        limit: SCAN_CHUNK,
      });
      for (const record of chunk) {
        if (!(await mayRead(record))) {
          after = { timestampMs: record.timestampMs, sequence: record.sequence ?? -1 };
          continue;
        }
        // One more than the page: it is what says there is a next page.
        if (page.length === limit) {
          const last = page[limit - 1]!;
          return { records: page.map(viewOf), nextCursor: encodeCursor(last) };
        }
        page.push(record);
        after = { timestampMs: record.timestampMs, sequence: record.sequence ?? -1 };
      }
      if (chunk.length < SCAN_CHUNK) return { records: page.map(viewOf), nextCursor: null };
    }
  }

  return { query };
}
