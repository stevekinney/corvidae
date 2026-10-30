/**
 * `bureau.audit.query`: the audit trail of a Bureau (COR-1482), always redacted to metadata.
 *
 * A caller reads the records about the resources it owns without any scope, and a caller holding
 * `bureau.audit:read` reads every record. A record belongs to the owner of the run, session, or
 * schedule it is about (`Bureau.ownerOf({ kind: 'audit' })`); a record about a resource with no
 * owner, such as a run that has been deleted, is read only through the scope. The actor a record
 * names (`principal`) is never what decides: a service principal such as `system:scheduler`
 * acts on resources it does not own.
 *
 * The operation owns who the caller is (the scope, and the owner a principal owns as) and
 * delegates the read to `bureau.audit.query` (`src/audit/create-audit.ts`), which redacts every
 * record to metadata and pages by cursor. The caller's owner crosses that boundary as
 * `options.owner`; a caller holding `bureau.audit:read` passes none.
 *
 * @module audit-operations
 */

import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import { auditRecordsToJsonLines, decodeAuditCursor } from '../../audit/create-audit.ts';
import type { BureauAudit } from '../../types.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What the audit operation reads from the handler's `host`. */
export type BureauAuditOperationHost = BureauOwnershipHost & {
  readonly audit: {
    /** Whether the Bureau keeps an audit trail; a Bureau that keeps none answers `UnsupportedCapability`. */
    readonly keepsTrail: () => boolean;
    /** {@link BureauAudit.query}, which redacts and scopes to the owner it is given. */
    readonly query: BureauAudit['query'];
  };
};

const recordSchema = z.object({
  /** The trail's own order among records of one millisecond; `null` for a record written before it existed. */
  sequence: z.number().int().nullable(),
  timestamp: z.string(),
  type: z.string(),
  /** What the record is about: a run id, or `schedule:<id>`, `session:<id>`, `agent:<id>`, `workflow:<id>`, `skill-source:<id>`. */
  resource: z.string(),
  /** The actor, when the record names one. Never the owner. */
  principal: z.string().nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
});

const queryInput = z.object({
  runId: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      'Only records about this resource: a run id, or `schedule:<id>`, `session:<id>`, and so on.',
    ),
  type: z.string().min(1).max(128).optional().describe('Only records of this type.'),
  since: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Only records at or after this time, in epoch milliseconds.'),
  until: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Only records at or before this time, in epoch milliseconds.'),
  principal: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('Only records whose actor (`principal`) is exactly this string.'),
  format: z
    .enum(['json', 'jsonl'])
    .optional()
    .describe(
      'How the page is returned. `json` (the default) returns `records`; `jsonl` returns `body`, one record per line as JSON Lines, with the same redaction.',
    ),
  cursor: z
    .string()
    .refine((cursor) => decodeAuditCursor(cursor) !== undefined, { message: 'Invalid cursor' })
    .optional()
    .describe('The `nextCursor` of the previous page, to continue after it.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('The most records to return in one page, from 1 to 100. Defaults to 50.'),
});

const queryOutput = z.union([
  z.object({
    records: z.array(recordSchema),
    /** Pass it as `cursor` for the next page; `null` on the last. */
    nextCursor: z.string().nullable(),
  }),
  z.object({
    format: z.literal('jsonl'),
    /** The page as JSON Lines: one record per line, each `{ sequence, timestamp, type, resource, principal, detail }`, each ended by a newline. */
    body: z.string(),
    /** Pass it as `cursor` for the next page; `null` on the last. */
    nextCursor: z.string().nullable(),
  }),
]);

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
    "Returns audit records, oldest first, as metadata only: `timestamp`, `type`, `resource` (what the record is about), `principal` (the actor), and a few scalar fields in `detail`. No record carries a secret, transcript, tool argument, tool result, or memory content. A caller sees the records about the resources it owns; a caller holding `bureau.audit:read` sees every record, and a record about a resource with no owner is read only through that scope. `runId` narrows to one resource, `type` to one kind, `principal` to one actor, and `since` and `until` to a time range (both ends inclusive). `format: 'jsonl'` returns the page as JSON Lines in `body` (one record per line, with the same redaction) instead of `records`, for export. Pages with `limit` (1 to 100, default 50) and `cursor`; `nextCursor` is `null` on the last page, and a page is filled from the records the caller may see, so a cursor advances across any number of records it may not.",
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
    if (!host.audit.keepsTrail()) throw unsupported();
    const { format, ...filter } = input;
    const everyOwner = holdsAuditRead(principal);
    const caller = ownerOfPrincipal(principal);
    // A caller without the scope is read as its owner; with it, as every owner.
    const page =
      !everyOwner && caller === undefined
        ? { records: [], nextCursor: null }
        : await host.audit.query(filter, everyOwner ? {} : { owner: caller });
    // Both formats render the one redacted page, so an export can never carry more than the read.
    if (format === 'jsonl') {
      return {
        format: 'jsonl' as const,
        body: auditRecordsToJsonLines(page.records),
        nextCursor: page.nextCursor,
      };
    }
    return { records: [...page.records], nextCursor: page.nextCursor };
  },
});
