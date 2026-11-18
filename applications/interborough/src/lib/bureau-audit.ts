/**
 * The browser's view of the Bureau's audit trail: `bureau.audit.query` (COR-1482), through the
 * generated client. The trail answers records as metadata only, oldest first unless a query asks for
 * the newest (`order: 'newest'`), and pages by a cursor that the answer hands back. The operation
 * takes an upper bound on time (`until`) and an actor (`principal`), which the audit log does not use.
 */
import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type JsonPage = Extract<BureauOutput<'bureau.audit.query'>, { readonly records: unknown }>;

/** One audit record, as `bureau.audit.query` shows it. */
export type AuditRecord = JsonPage['records'][number];

/** One page of the trail, and the cursor for the next, or `null` on the last. */
export type AuditPage = JsonPage;

/** What a search narrows the trail to. A field that is absent narrows nothing. */
export type AuditFilter = {
  /** Only records at or after this time, in epoch milliseconds. */
  readonly since?: number;
  /** Only records of this type, which is free text: `schedule.*` types are recorded outside the list of audit event types. */
  readonly type?: string;
  /** Only records of one of these types, up to 64; combines with `type`. An empty list matches nothing. */
  readonly types?: readonly string[];
  /** Only records about this run id, or this resource: `schedule:<id>`, `session:<id>`, `agent:<id>`, `workflow:<id>`. Sent as `runId`. */
  readonly resource?: string;
};

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** The most records one page holds. */
export const AUDIT_PAGE_SIZE = 50;

/**
 * One page of the trail for `filter`, from `cursor` when it is given. An empty filter field is not
 * sent. `order: 'newest'` reads the latest records first (a cursor then continues into older
 * ones), and `includeTotal` also answers how many records the filter matches, which reads the
 * whole matching trail, so ask for it once.
 */
export async function queryAudit(
  filter: AuditFilter,
  cursor: string | undefined,
  options?: Options & {
    readonly limit?: number;
    readonly order?: 'oldest' | 'newest';
    readonly includeTotal?: boolean;
  },
): Promise<AuditPage> {
  const params = {
    limit: options?.limit ?? AUDIT_PAGE_SIZE,
    ...(options?.order === undefined ? {} : { order: options.order }),
    ...(options?.includeTotal === true ? { includeTotal: true } : {}),
    ...(filter.since === undefined ? {} : { since: filter.since }),
    ...(filter.type === undefined || filter.type === '' ? {} : { type: filter.type }),
    ...(filter.types === undefined ? {} : { types: filter.types }),
    ...(filter.resource === undefined || filter.resource === '' ? {} : { runId: filter.resource }),
    ...(cursor === undefined ? {} : { cursor }),
  };
  const page = await bureauClient['bureau.audit.query'](params, options);
  // The `jsonl` format is a download, which no page of the console asks for.
  if (!('records' in page)) throw new Error('The audit trail answered a download, not a page.');
  return page;
}
