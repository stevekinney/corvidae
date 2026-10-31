/**
 * The audit search as the address says it, and as the Bureau takes it. The address owns the
 * filters (`/health/audit?type=schedule.created`), so a search can be linked to and survives a reload.
 *
 * `since` is written as the local time the person typed (`YYYY-MM-DDTHH:mm`) and sent as epoch
 * milliseconds, which is what `bureau.audit.query` takes.
 */
import { agentPath } from '../../lib/agent-paths.ts';
import type { AuditFilter, AuditRecord } from '../../lib/bureau-audit.ts';
import { chatSessionPath } from '../../lib/identifier-paths.ts';
import { scheduleDetailPath, workflowDetailPath } from '../../lib/router.svelte.ts';
import { workflowTypePath } from '../../lib/workflow-type-paths.ts';

/** What the form holds: the text of each field, before it means anything to the Bureau. */
export type AuditDraft = {
  readonly since: string;
  readonly type: string;
  readonly resource: string;
  /**
   * Who did it. The operation takes no actor, so this narrows the records already read and is
   * never sent: {@link filterOf} leaves it out, and {@link byWho} applies it.
   */
  readonly who: string;
};

export const EMPTY_AUDIT_DRAFT: AuditDraft = { since: '', type: '', resource: '', who: '' };

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
    who: search.get('who') ?? '',
  };
}

/** The address of a search: `/health/audit`, with a query for each filter that is set. */
export function pathOf(draft: AuditDraft): string {
  const params = new URLSearchParams();
  if (draft.since.trim() !== '') params.set('since', draft.since.trim());
  if (draft.type.trim() !== '') params.set('type', draft.type.trim());
  if (draft.resource.trim() !== '') params.set('resource', draft.resource.trim());
  if (draft.who.trim() !== '') params.set('who', draft.who.trim());
  const query = params.toString();
  return query === '' ? '/health/audit' : `/health/audit?${query}`;
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
  { kind: 'run', label: 'Run ID', prefix: '' },
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

/** The records `who` did, or all of them when `who` is empty. A record with no actor is nobody's. */
export function byWho(records: readonly AuditRecord[], who: string): readonly AuditRecord[] {
  const name = who.trim();
  return name === '' ? records : records.filter((record) => record.principal === name);
}

/**
 * The page of the thing a record is about, or `undefined` when the record names none a page
 * exists for: a chat, an agent, a schedule or a workflow by its prefix, and any other resource as a
 * run's id.
 */
export function resourcePath(resource: string): string | undefined {
  const choice = splitResource(resource);
  if (choice.kind === '' || choice.id === '') return undefined;
  switch (choice.kind) {
    case 'session':
      return chatSessionPath(choice.id);
    case 'agent':
      return agentPath(choice.id);
    case 'schedule':
      return scheduleDetailPath(choice.id);
    case 'workflow':
      return workflowTypePath(choice.id);
    case 'run':
      return workflowDetailPath(choice.id);
  }
}

/**
 * What a record says changed, when its detail names a value before and after. The operation hands
 * back only scalar fields, so a change shows as `before` and `after` among them; a record without
 * either has no change to compare, and its fields are all `rest`.
 */
export function changeOf(detail: AuditRecord['detail']): {
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly rest: readonly (readonly [string, string])[];
} {
  const entries = Object.entries(detail ?? {});
  const read = (name: string): string | undefined => {
    const found = entries.find(([key]) => key === name);
    return found === undefined ? undefined : String(found[1]);
  };
  return {
    before: read('before'),
    after: read('after'),
    rest: entries
      .filter(([key]) => key !== 'before' && key !== 'after')
      .map(([key, value]) => [key, String(value)] as const),
  };
}
