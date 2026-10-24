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

/**
 * What a record can be about, as a person names it and as the Bureau spells it: a chat is a
 * `session:<id>`, and a run is its bare id. The form builds the `kind:<id>` string from a kind and an
 * id, so nobody types the prefix; the address and the Bureau still hold the one string.
 */
export const RESOURCE_KINDS = [
  { kind: 'session', label: 'Chat', prefix: 'session:' },
  { kind: 'agent', label: 'Agent', prefix: 'agent:' },
  { kind: 'schedule', label: 'Schedule', prefix: 'schedule:' },
  { kind: 'workflow', label: 'Workflow', prefix: 'workflow:' },
  { kind: 'run', label: 'Run id', prefix: '' },
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number]['kind'];

/** What the resource picker holds: a kind (or none) and the id within it. */
export type ResourceChoice = { readonly kind: ResourceKind | ''; readonly id: string };

/**
 * The picker's reading of a resource string. A string with a known prefix is that kind and the rest
 * is its id; any other non-empty string is a run id, so a resource the picker has no kind for stays
 * searchable as it was written and reads back unchanged.
 */
export function splitResource(resource: string): ResourceChoice {
  const text = resource.trim();
  if (text === '') return { kind: '', id: '' };
  const named = RESOURCE_KINDS.find(
    (entry) => entry.prefix !== '' && text.startsWith(entry.prefix),
  );
  return named === undefined
    ? { kind: 'run', id: text }
    : { kind: named.kind, id: text.slice(named.prefix.length) };
}

/**
 * The resource string a picker choice stands for. A kind with no id narrows nothing, because the
 * Bureau takes one resource exactly and a prefix alone names none.
 */
export function joinResource(choice: ResourceChoice): string {
  const id = choice.id.trim();
  if (choice.kind === '' || id === '') return '';
  const entry = RESOURCE_KINDS.find((candidate) => candidate.kind === choice.kind);
  return `${entry?.prefix ?? ''}${id}`;
}
