/**
 * The audit log's filters as the address says them, and as the Bureau takes them. The address owns
 * the filters (`/health/audit?actor=you&period=30d&action=started&q=refund`), so a search can be
 * linked to and survives a reload; an absent field is the default (anyone, the last 7 days, any
 * action, no text).
 *
 * The period and the action reach the Bureau: the period as `since`, and the action as the list of
 * event types that kind covers, so the Bureau pages through, and counts, only what the log shows.
 * The Bureau takes no actor that fits how people read one (an agent is no principal) and no text, so
 * Who and the search narrow the events already read (`narrowEvents`).
 */
import { agentPath } from '../../lib/agent-paths.ts';
import type { AuditActionKind } from '../../lib/audit-event-types.ts';
import { AUDIT_ACTION_KINDS, auditTypesOfKind } from '../../lib/audit-event-types.ts';
import type { AuditFilter } from '../../lib/bureau-audit.ts';
import { chatSessionPath } from '../../lib/identifier-paths.ts';
import { scheduleDetailPath, workflowDetailPath } from '../../lib/router.svelte.ts';
import { workflowTypePath } from '../../lib/workflow-type-paths.ts';

/** Who the Who select narrows to; the empty string is anyone. */
export const AUDIT_ACTORS = ['you', 'agents', 'interborough'] as const;

/** One of the actors the Who select offers. */
export type AuditActorFilter = (typeof AUDIT_ACTORS)[number];

/** How far back the Period select reaches. */
export const AUDIT_PERIODS = ['today', '7d', '30d', '90d', 'all'] as const;

/** One of the periods the Period select offers. */
export type AuditPeriod = (typeof AUDIT_PERIODS)[number];

/** The period the log opens on. */
export const DEFAULT_AUDIT_PERIOD: AuditPeriod = '7d';

/** What the filter row holds: the choice of each control and the text of the search. */
export type AuditDraft = {
  readonly actor: AuditActorFilter | '';
  readonly period: AuditPeriod;
  readonly action: AuditActionKind | '';
  readonly text: string;
};

/** The filters of an address that names none. */
export const EMPTY_AUDIT_DRAFT: AuditDraft = {
  actor: '',
  period: DEFAULT_AUDIT_PERIOD,
  action: '',
  text: '',
};

const DAY = 86_400_000;

/**
 * The time a period starts at, in epoch milliseconds, or `undefined` for all time. Today starts at
 * the viewer's midnight; the others count back from `now`.
 */
export function periodStart(period: AuditPeriod, now: number): number | undefined {
  switch (period) {
    case 'today': {
      const day = new Date(now);
      return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    }
    case '7d':
      return now - 7 * DAY;
    case '30d':
      return now - 30 * DAY;
    case '90d':
      return now - 90 * DAY;
    case 'all':
      return undefined;
  }
}

/** The filter the Bureau is asked with: the events of the action's kind, since the period began. */
export function filterOf(draft: AuditDraft, now: number): AuditFilter {
  const since = periodStart(draft.period, now);
  return {
    ...(since === undefined ? {} : { since }),
    types: auditTypesOfKind(draft.action === '' ? undefined : draft.action),
  };
}

/** Whether the choices narrow the log beyond its opening view, which is when it offers Clear filters. */
export function isNarrowed(draft: AuditDraft): boolean {
  return (
    draft.actor !== '' ||
    draft.action !== '' ||
    draft.text.trim() !== '' ||
    draft.period !== DEFAULT_AUDIT_PERIOD
  );
}

function oneOf<T extends string>(values: readonly T[], value: string | null): T | undefined {
  return values.find((candidate) => candidate === value);
}

/** The draft an address holds; a value the page does not offer is the default. */
export function draftFromSearch(search: URLSearchParams): AuditDraft {
  return {
    actor: oneOf(AUDIT_ACTORS, search.get('actor')) ?? '',
    period: oneOf(AUDIT_PERIODS, search.get('period')) ?? DEFAULT_AUDIT_PERIOD,
    action: oneOf(AUDIT_ACTION_KINDS, search.get('action')) ?? '',
    text: search.get('q') ?? '',
  };
}

/** The address of a search: `/health/audit`, with a query for each filter that is not the default. */
export function pathOf(draft: AuditDraft, record: string | null = null): string {
  const params = new URLSearchParams();
  if (draft.actor !== '') params.set('actor', draft.actor);
  if (draft.period !== DEFAULT_AUDIT_PERIOD) params.set('period', draft.period);
  if (draft.action !== '') params.set('action', draft.action);
  if (draft.text.trim() !== '') params.set('q', draft.text.trim());
  if (record !== null) params.set('record', record);
  const query = params.toString();
  return query === '' ? '/health/audit' : `/health/audit?${query}`;
}

/**
 * What an event can be about, as the Bureau spells it: a chat is a `session:<id>`, and a run is its
 * bare id. A string with a known prefix is that kind and the rest is its id; any other non-empty
 * string is a run.
 */
const RESOURCE_PREFIXES = [
  { kind: 'session', prefix: 'session:' },
  { kind: 'agent', prefix: 'agent:' },
  { kind: 'schedule', prefix: 'schedule:' },
  { kind: 'workflow', prefix: 'workflow:' },
] as const;

/** What a record's resource names: a kind of thing and its id, or a run's id. */
export type ResourceName = {
  readonly kind: 'session' | 'agent' | 'schedule' | 'workflow' | 'run' | 'other';
  readonly id: string;
};

/** The kind and id a resource string names. */
export function splitResource(resource: string): ResourceName {
  const text = resource.trim();
  if (text === '') return { kind: 'other', id: '' };
  const named = RESOURCE_PREFIXES.find((entry) => text.startsWith(entry.prefix));
  if (named !== undefined) return { kind: named.kind, id: text.slice(named.prefix.length) };
  // Other resources of the trail (`host`, `hook:…`, `storage:…`) are not runs.
  return text.includes(':') || text === 'host'
    ? { kind: 'other', id: text }
    : { kind: 'run', id: text };
}

/**
 * The page of the thing a record is about, or `undefined` when the record names none a page
 * exists for: a chat, an agent, a schedule or a workflow by its prefix, and any other resource as a
 * run's id.
 */
export function resourcePath(resource: string): string | undefined {
  const { kind, id } = splitResource(resource);
  if (id === '') return undefined;
  switch (kind) {
    case 'session':
      return chatSessionPath(id);
    case 'agent':
      return agentPath(id);
    case 'schedule':
      return scheduleDetailPath(id);
    case 'workflow':
      return workflowTypePath(id);
    case 'run':
      return workflowDetailPath(id);
    case 'other':
      return undefined;
  }
}
