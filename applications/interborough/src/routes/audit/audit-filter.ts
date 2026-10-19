/**
 * The audit search as the address says it, and as the Bureau takes it. The address owns the
 * filters (`/audit?type=schedule.created`), so a search can be linked to and survives a reload.
 *
 * `since` is written as the local time the person typed (`YYYY-MM-DDTHH:mm`) and sent as epoch
 * milliseconds, which is what `bureau.audit.query` takes.
 */
import type { AuditFilter } from '../../lib/bureau-audit.ts';

/** What the form holds: the text of each field, before it means anything to the Bureau. */
export type AuditDraft = {
  readonly since: string;
  readonly type: string;
  readonly resource: string;
};

export const EMPTY_AUDIT_DRAFT: AuditDraft = { since: '', type: '', resource: '' };

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** The time a draft's `since` names, or `undefined` when it is empty or is not a time. */
export function sinceOf(text: string): number | undefined {
  if (!LOCAL_TIME.test(text)) return undefined;
  const milliseconds = new Date(text).getTime();
  return Number.isNaN(milliseconds) ? undefined : milliseconds;
}

/**
 * The filter the Bureau is asked with: only what is set, and only a `since` that is a time. The
 * date field refuses text that is not one, and leaves its value empty, so it narrows nothing.
 */
export function filterOf(draft: AuditDraft): AuditFilter {
  const since = sinceOf(draft.since.trim());
  const type = draft.type.trim();
  const resource = draft.resource.trim();
  return {
    ...(since === undefined ? {} : { since }),
    ...(type === '' ? {} : { type }),
    ...(resource === '' ? {} : { resource }),
  };
}

/** The draft an address holds. */
export function draftFromSearch(search: URLSearchParams): AuditDraft {
  return {
    since: search.get('since') ?? '',
    type: search.get('type') ?? '',
    resource: search.get('resource') ?? '',
  };
}

/** The address of a search: `/audit`, with a query for each filter that is set. */
export function pathOf(draft: AuditDraft): string {
  const params = new URLSearchParams();
  if (draft.since.trim() !== '') params.set('since', draft.since.trim());
  if (draft.type.trim() !== '') params.set('type', draft.type.trim());
  if (draft.resource.trim() !== '') params.set('resource', draft.resource.trim());
  const query = params.toString();
  return query === '' ? '/audit' : `/audit?${query}`;
}
