/**
 * The browser's view of the Bureau's audit trail: `bureau.audit.query` (COR-1482), parsed at the
 * boundary. The trail answers records oldest first, as metadata only, and pages by a cursor that
 * the answer hands back; the operation takes no upper bound on time and no ordering, so neither is
 * offered here.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

const recordSchema = z.object({
  /** The trail's own order among records of one millisecond; `null` for a record written before it existed. */
  sequence: z.number().int().nullable(),
  timestamp: z.string(),
  type: z.string(),
  /** What the record is about: a run id, or `schedule:<id>`, `session:<id>`, `agent:<id>`, `workflow:<id>`. */
  resource: z.string(),
  /** The actor, when the record names one. */
  principal: z.string().nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
});

/** One audit record, as `bureau.audit.query` shows it. */
export type AuditRecord = z.infer<typeof recordSchema>;

const pageSchema = z.object({
  records: z.array(recordSchema),
  nextCursor: z.string().nullable(),
});

/** One page of the trail, and the cursor for the next, or `null` on the last. */
export type AuditPage = z.infer<typeof pageSchema>;

/** What a search narrows the trail to. A field that is absent narrows nothing. */
export type AuditFilter = {
  /** Only records at or after this time, in epoch milliseconds. */
  readonly since?: number;
  /** Only records of this type, which is free text: `schedule.*` types are recorded outside the list of audit event types. */
  readonly type?: string;
  /** Only records about this run id, or this resource: `schedule:<id>`, `session:<id>`, `agent:<id>`, `workflow:<id>`. Sent as `runId`. */
  readonly resource?: string;
};

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** The most records one page holds. */
export const AUDIT_PAGE_SIZE = 50;

/** One page of the trail for `filter`, from `cursor` when it is given. An empty filter field is not sent. */
export async function queryAudit(
  filter: AuditFilter,
  cursor: string | undefined,
  options?: Options & { readonly limit?: number },
): Promise<AuditPage> {
  const params: Record<string, unknown> = {
    limit: options?.limit ?? AUDIT_PAGE_SIZE,
    ...(filter.since === undefined ? {} : { since: filter.since }),
    ...(filter.type === undefined || filter.type === '' ? {} : { type: filter.type }),
    ...(filter.resource === undefined || filter.resource === '' ? {} : { runId: filter.resource }),
    ...(cursor === undefined ? {} : { cursor }),
  };
  return pageSchema.parse(await callBureau('bureau.audit.query', params, options));
}
