/** What {@link BureauAudit.query} narrows the trail by. Every field is optional. */
export type AuditQuery = {
  /** Only records about this resource: a run id, or `schedule:<id>`, `session:<id>`, `agent:<id>`, `workflow:<id>`. */
  readonly runId?: string | undefined;
  /** Only records of this type. */
  readonly type?: string | undefined;
  /**
   * Only records of one of these types, for a reader that wants several kinds and none of the
   * rest (COR-2018: the audit log shows what was done, not each step a run took). It combines with
   * `type`: a record must match both. An empty list matches nothing.
   */
  readonly types?: readonly string[] | undefined;
  /** Only records at or after this time, in epoch milliseconds. */
  readonly since?: number | undefined;
  /** Only records at or before this time, in epoch milliseconds. */
  readonly until?: number | undefined;
  /** Only records whose actor (`principal`) is exactly this string. */
  readonly principal?: string | undefined;
  /** The `nextCursor` of the previous page. */
  readonly cursor?: string | undefined;
  /** How many records a page holds, 1 to 100. Defaults to 50. */
  readonly limit?: number | undefined;
  /**
   * Which end of the trail the page starts from: `oldest` (the default) reads forward in time, and
   * `newest` reads backward from the latest record, so a page holds the most recent records,
   * newest first, and `nextCursor` continues into older ones.
   */
  readonly order?: 'oldest' | 'newest' | undefined;
  /**
   * Also answer how many records match the filter and the reader may see, as
   * {@link AuditQueryPage.total}. It reads the whole matching trail, so ask for it once, not on
   * every page.
   */
  readonly includeTotal?: boolean | undefined;
};
/** Who is asking, for {@link BureauAudit.query}. */
export type BureauAuditQueryOptions = {
  /** Include only metadata of shared configuration changes, never private execution events. */
  readonly includeSharedConfiguration?: boolean | undefined;
  /**
   * Only records about resources this owner owns (the `api-key:<subject>` or `anonymous:local`
   * string `ownerOf` returns). A record about a resource with no owner is never returned for an
   * owner. Omitted, every record is returned: an in-process caller is the host itself.
   */
  readonly owner?: string | undefined;
};
/**
 * One audit record, redacted to metadata: when it happened, its type, what it is about, the
 * actor, and a few scalar fields. Never a secret, transcript, tool argument, tool result, review
 * prompt, or memory content.
 */
export type AuditQueryRecord = {
  /** The trail's own order among records of one millisecond; `null` for a record written before it existed. */
  readonly sequence: number | null;
  /** ISO-8601 time of the record. */
  readonly timestamp: string;
  /** The record's type, such as `run.completed`. */
  readonly type: string;
  /** What the record is about: a run id, or `schedule:<id>`, `session:<id>`, `agent:<id>`, `workflow:<id>`. */
  readonly resource: string;
  /** The actor, when the record names one. Never the owner. */
  readonly principal: string | null;
  /** Scalar fields from an allowlist (`agentName`, `finishReason`, `scheduleId`, `sessionId`, `status`, `toolName`), or `null`. */
  readonly detail: Readonly<Record<string, string | number | boolean>> | null;
};
/** One page of {@link BureauAudit.query}. */
export type AuditQueryPage = {
  /** The records: oldest first, or newest first when the query asked for `order: 'newest'`. */
  readonly records: readonly AuditQueryRecord[];
  /** Pass it as `cursor` for the next page; `null` on the last. */
  readonly nextCursor: string | null;
  /** How many records match the filter and the reader may see; present only when `includeTotal` was asked for. */
  readonly total?: number;
};
/**
 * The Bureau's audit trail, read as metadata. `bureau.audit.query` served by `createBureauHandler`
 * delegates to {@link BureauAudit.query}, so both return the same records for the same filter.
 * The raw trail is {@link BureauInternals.auditTrail}.
 */
export interface BureauAudit {
  /**
   * Read audit records, oldest first, redacted to metadata. Rejects with a `BureauError`
   * (`UNSUPPORTED_CAPABILITY`) when the Bureau keeps no audit trail (it has no `storage`), and
   * with `BAD_REQUEST` for a `limit` outside 1 to 100 or a `cursor` it did not issue. A page is
   * filled from the records {@link BureauAuditQueryOptions.owner} may see, so a cursor advances across
   * any number of records it may not.
   */
  query(filter?: AuditQuery, options?: BureauAuditQueryOptions): Promise<AuditQueryPage>;
}
