/**
 * `bureau.audit.query`: the audit trail of a Bureau (COR-1482), always redacted to metadata.
 *
 * A caller reads the records about the resources it owns without any scope, and a caller holding
 * `bureau.audit:read` reads every record. A record belongs to the owner of the run, session, or
 * schedule it is about (`Bureau.getOwner({ kind: 'audit' })`); a record about a resource with no
 * owner, such as a run that has been deleted, is read only through the scope. The actor a record
 * names (`principal`) is never what decides: a service principal such as `system:scheduler`
 * acts on resources it does not own.
 *
 * What a record carries: when it happened, its type, the resource it is about (`resource`), the
 * actor, and a handful of scalar fields from an allowlist. Nothing else of the stored record
 * leaves the Bureau: no secret, transcript, tool argument, tool result, review prompt, or memory
 * content. A stored `detail` can hold any of them, so `detail` is rebuilt from the allowlist
 * and never filtered.
 *
 * Paging is by cursor: the position of the last record a page returned, in the trail's own
 * chronological order. A page is filled from the records the caller may see, so a cursor
 * advances across any number of records the filter drops.
 *
 * @module audit-operations
 */

import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import type { AuditRecord, AuditTrail } from '../../audit-trail.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  DEFAULT_PAGE_LIMIT,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What the audit operation reads from the handler's `host`. */
export type BureauAuditOperationHost = BureauOwnershipHost & {
  readonly audit: {
    /** The trail, or `undefined` for a Bureau that keeps none. */
    readonly trail: Pick<AuditTrail, 'query'> | undefined;
    /** The owner of record of the resource an entry is about, or `undefined` when it has none. */
    readonly ownerOf: (entry: Pick<AuditRecord, 'runId' | 'detail'>) => Promise<string | undefined>;
  };
};

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
  'scheduleId',
  'sessionId',
  'status',
  'toolName',
];

function detailOf(detail: unknown): Record<string, string | number | boolean> | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const projected: Record<string, string | number | boolean> = {};
  for (const key of DETAIL_ALLOWLIST) {
    const value = (detail as Record<string, unknown>)[key];
    if (typeof value === 'string') projected[key] = value.slice(0, DETAIL_VALUE_LIMIT);
    else if (typeof value === 'number' || typeof value === 'boolean') projected[key] = value;
  }
  return Object.keys(projected).length === 0 ? null : projected;
}

const recordSchema = z.object({
  /** The trail's own order among records of one millisecond; `null` for a record written before it existed. */
  sequence: z.number().int().nullable(),
  timestamp: z.string(),
  type: z.string(),
  /** What the record is about: a run id, or `schedule:<id>`, `session:<id>`, `agent:<id>`, `workflow:<id>`. */
  resource: z.string(),
  /** The actor, when the record names one. Never the owner. */
  principal: z.string().nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
});

function viewOf(record: AuditRecord): z.infer<typeof recordSchema> {
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

function decodeCursor(cursor: string): { timestampMs: number; sequence: number } | undefined {
  const match = CURSOR.exec(cursor);
  return match === null ? undefined : { timestampMs: Number(match[1]), sequence: Number(match[2]) };
}

const queryInput = z.object({
  /** Only records about this resource: a run id, or `schedule:<id>`, `session:<id>`, and so on. */
  runId: z.string().min(1).max(512).optional(),
  type: z.string().min(1).max(128).optional(),
  /** Only records at or after this time, in epoch milliseconds. */
  since: z.number().int().min(0).optional(),
  cursor: z
    .string()
    .refine((cursor) => decodeCursor(cursor) !== undefined, { message: 'Invalid cursor' })
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const queryOutput = z.object({
  records: z.array(recordSchema),
  /** Pass it as `cursor` for the next page; `null` on the last. */
  nextCursor: z.string().nullable(),
});

function unsupported(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau keeps no audit trail',
    data: { capability: 'audit-trail' },
  };
}

function holdsAuditRead(principal: Principal): boolean {
  return principal.method !== 'unauthenticated' && principal.hasScope('bureau.audit:read');
}

export const auditQueryOperation = defineOperation<
  typeof queryInput,
  typeof queryOutput,
  BureauAuditOperationHost
>({
  name: 'bureau.audit.query',
  mcpExposable: false,
  summary: 'Query the audit trail',
  description:
    'Returns audit records, oldest first, as metadata only: `timestamp`, `type`, `resource` (what the record is about), `principal` (the actor), and a few scalar fields in `detail`. No record carries a secret, transcript, tool argument, tool result, or memory content. A caller sees the records about the resources it owns; a caller holding `bureau.audit:read` sees every record, and a record about a resource with no owner is read only through that scope. `runId` narrows to one resource, `type` to one kind, and `since` to a time. Pages with `limit` (1 to 100, default 50) and `cursor`; `nextCursor` is `null` on the last page, and a page is filled from the records the caller may see, so a cursor advances across any number of records it may not.',
  destructive: false,
  tags: ['Audit'],
  inputSchema: queryInput,
  outputSchema: queryOutput,
  producibleFaults: ['InvalidParams', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { trail } = host.audit;
    if (trail === undefined) throw unsupported();
    const everyOwner = holdsAuditRead(principal);
    const caller = ownerOfPrincipal(principal);
    if (!everyOwner && caller === undefined) return { records: [], nextCursor: null };
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const owners = new Map<string, string | undefined>();
    const mayRead = async (record: AuditRecord): Promise<boolean> => {
      if (everyOwner) return true;
      // A session's deletion entry names its owner in its own detail, so it cannot be cached by id.
      const cacheable = !record.runId.startsWith('session:');
      if (cacheable && owners.has(record.runId)) return owners.get(record.runId) === caller;
      const owner = await host.audit.ownerOf(record);
      if (cacheable) owners.set(record.runId, owner);
      return owner !== undefined && owner === caller;
    };

    const page: AuditRecord[] = [];
    let after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    for (;;) {
      const chunk = await trail.query({
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.since === undefined ? {} : { since: input.since }),
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
  },
});
