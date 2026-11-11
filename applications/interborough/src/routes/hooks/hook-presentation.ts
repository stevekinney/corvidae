/**
 * How the hooks pages say what the Bureau holds: an event kind in plain words and the area it is
 * grouped under, which events an action may listen to, a hook as a sentence, and what a delivery
 * came to. Pure, so the pages and their tests share one reading.
 */
import type { StatusDotWord } from '@lostgradient/cinder';
import { HttpClientError } from '@lostgradient/weft';

import { agentLabel } from '../../lib/agent-label.ts';
import { agentPath } from '../../lib/agent-paths.ts';
import {
  HOOK_SCOPE_KINDS,
  type Hook,
  type HookActionType,
  type HookDelivery,
  type HookDeliverySummary,
  type HookEventKind,
  type HookScope,
  type HookScopeKind,
  type ListedHook,
} from '../../lib/bureau-hooks.ts';
import { isNetworkFailure } from '../../lib/faults.ts';
import { scheduleDetailPath, workflowDetailPath } from '../../lib/router.svelte.ts';
import type { StatusWord } from '../../lib/status.ts';
import { activityTime } from '../health/health-times.ts';
import { HOOKS_COPY } from './hook-copy.ts';

const COPY = HOOKS_COPY.editor;

/** The area each family of events is grouped under in the picker, by the first word of the kind. */
const AREAS: Readonly<Record<string, string>> = {
  action: 'Agent actions',
  asset: 'Files',
  bureau: 'System',
  definitions: 'Definitions',
  diagnostic: 'System',
  goal: 'Goals',
  memory: 'Memory',
  notification: 'Notifications',
  recovery: 'Recovery',
  review: 'Reviews',
  run: 'Runs',
  schedule: 'Schedules',
  session: 'Chats',
  skill: 'Skills',
  steering: 'Chats',
  task: 'Tasks',
};

/** Words an event kind uses for something a person knows by another name. */
const PLAIN_WORDS: Readonly<Record<string, string>> = { session: 'chat', bureau: 'system' };

/** The kind of the event that a notification hook writes, which it must not listen to. */
const NOTIFICATION_CREATED = 'notification.created';

/** The area an event kind is grouped under. A kind of a family the page has no name for is `Other`. */
export function eventArea(kind: string): string {
  const family = kind.split('.')[0] ?? kind;
  return Object.hasOwn(AREAS, family)
    ? (AREAS[family] ?? COPY.event.areaOther)
    : COPY.event.areaOther;
}

/** An event kind in plain words: `goal.attempt.started` reads `Goal attempt started`. */
export function eventWords(kind: string): string {
  const words = kind
    .split(/[.\-_]/)
    .filter((word) => word !== '')
    .map((word) => (Object.hasOwn(PLAIN_WORDS, word) ? (PLAIN_WORDS[word] ?? word) : word));
  const sentence = words.join(' ');
  return sentence === '' ? kind : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** One event the picker offers: plain words, the raw kind beside them, and its area. */
export type EventChoice = {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly group: string;
  readonly disabled: boolean;
};

/** Why `action` may not listen to an event, or `undefined` when it may. */
export function eventRefusal(
  action: HookActionType | 'plugin',
  event: Pick<HookEventKind, 'kind' | 'origin'>,
): string | undefined {
  if (action === 'notify' && event.kind === NOTIFICATION_CREATED) return COPY.event.notifyLoop;
  if (action === 'start-workflow' && event.origin === 'unattributed') {
    return COPY.event.workflowLoop;
  }
  return undefined;
}

/** Every event kind as a choice, grouped by area, with the ones `action` cannot listen to disabled. */
export function eventChoices(
  kinds: readonly HookEventKind[],
  action: HookActionType | 'plugin',
): EventChoice[] {
  return kinds
    .map((event) => {
      const refusal = eventRefusal(action, event);
      return {
        value: event.kind,
        label: eventWords(event.kind),
        description: refusal === undefined ? event.kind : `${event.kind}. ${refusal}`,
        group: eventArea(event.kind),
        disabled: refusal !== undefined,
      };
    })
    .toSorted((left, right) => left.group.localeCompare(right.group));
}

/**
 * Whether an event matches what was typed: the plain words, the raw kind, the area and what the
 * Bureau says the event means, so a person can search by any of them. `meanings` holds the last.
 */
export function eventMatches(
  choice: { readonly value: string; readonly label: string; readonly group?: string | undefined },
  query: string,
  meanings: ReadonlyMap<string, string>,
): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');
  if (terms.length === 0) return true;
  const haystack = [
    choice.label,
    choice.value,
    choice.group ?? '',
    meanings.get(choice.value) ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** The events of a hook as a phrase: one name, two joined by `or`, or the first and how many more. */
export function eventPhrase(events: readonly string[]): string {
  const names = events.map(eventWords);
  const [first, second] = names;
  if (first === undefined) return HOOKS_COPY.sentence.noEvent;
  if (second === undefined) return first;
  if (names.length === 2) return `${first} ${HOOKS_COPY.sentence.or} ${second}`;
  return `${first} ${HOOKS_COPY.sentence.or} ${HOOKS_COPY.sentence.more(names.length - 1)}`;
}

/** What a hook does, as the end of its sentence. */
export function actionPhrase(action: Hook['action'] | DraftAction): string {
  const words = HOOKS_COPY.sentence;
  switch (action.type) {
    case 'webhook':
      return action.url === '' ? words.webhookUnset : words.webhook(action.url);
    case 'start-workflow':
      return action.workflowId === ''
        ? words.startWorkflowUnset
        : words.startWorkflow(action.workflowId);
    case 'notify':
      return words.notify;
    case 'plugin':
      return words.plugin(action.plugin, action.kind);
  }
}

/** The part of an action the sentence reads, for a hook not yet written. */
export type DraftAction =
  | { readonly type: 'webhook'; readonly url: string }
  | { readonly type: 'start-workflow'; readonly workflowId: string }
  | { readonly type: 'notify' }
  | { readonly type: 'plugin'; readonly plugin: string; readonly kind: string };

/** Whether `kind` is one this page knows. A home on a newer release can hold another. */
export function isScopeKind(kind: string): kind is HookScopeKind {
  return (HOOK_SCOPE_KINDS as readonly string[]).includes(kind);
}

/** What a hook's scope adds to its sentence, after the events. */
function scopePhrase(scope: HookScope): string {
  const words = HOOKS_COPY.sentence;
  return isScopeKind(scope.kind) ? words[scope.kind](scope.id) : words.other(scope.kind, scope.id);
}

/**
 * A hook as a sentence: `When Review requested, send a signed message to https://example.com`, with
 * what it is limited to after the events: `When Review requested for the agent scout, notify me`.
 */
export function hookSentence(hook: {
  readonly events: readonly string[];
  readonly action: Hook['action'] | DraftAction;
  readonly scope?: HookScope | null | undefined;
}): string {
  const scope =
    hook.scope === null || hook.scope === undefined ? '' : ` ${scopePhrase(hook.scope)}`;
  return `${HOOKS_COPY.sentence.when} ${eventPhrase(hook.events)}${scope}, ${actionPhrase(hook.action)}`;
}

/** A hook's Only for cell: what it is limited to, or that it runs for everything. */
export function onlyForWords(scope: HookScope | null): string {
  const words = HOOKS_COPY.onlyFor;
  if (scope === null) return words.everything;
  return isScopeKind(scope.kind) ? words[scope.kind](scope.id) : words.other(scope.kind, scope.id);
}

/** The page of the subject a scope names, or `undefined` for a kind this page does not know. */
export function scopePath(scope: HookScope): string | undefined {
  switch (scope.kind) {
    case 'agent':
      return agentPath(scope.id);
    case 'workflow':
      return workflowDetailPath(scope.id);
    case 'schedule':
      return scheduleDetailPath(scope.id);
    default:
      return undefined;
  }
}

/**
 * What Only for can offer for `events`: the kinds of subject every one of them can be told by, which
 * is what the Bureau accepts. Nothing for no events, and nothing for an event the catalog does not
 * describe.
 */
export function scopeKindsFor(
  events: readonly string[],
  kinds: readonly Pick<HookEventKind, 'kind' | 'scopes'>[],
): HookScopeKind[] {
  if (events.length === 0) return [];
  return HOOK_SCOPE_KINDS.filter((scope) =>
    events.every((event) =>
      kinds.find((candidate) => candidate.kind === event)?.scopes.includes(scope),
    ),
  );
}

/** The word a delivery's status reads as, in the one vocabulary of the records pages. */
export function deliveryWord(status: HookDelivery['status']): StatusWord {
  switch (status) {
    case 'delivered':
      return 'Done';
    case 'pending':
      return 'Running';
    case 'aborted':
      return 'Canceled';
    case 'exhausted':
    case 'failed':
    case 'failed-secret':
      return 'Failed';
  }
}

/** Whether a delivery ended without reaching its end, so the hook it belongs to is failing. */
export function deliveryFailed(delivery: Pick<HookDelivery, 'status'> | null): boolean {
  return delivery !== null && deliveryWord(delivery.status) === 'Failed';
}

/** What a delivery came to, in a line: the answer, or why there was none. */
export function deliveryLine(delivery: HookDelivery | HookDeliverySummary): string {
  const copy = HOOKS_COPY.attempt;
  if (delivery.status === 'failed-secret') return copy.secretMissing;
  const last = 'attempts' in delivery ? delivery.attempts.at(-1) : delivery.lastAttempt;
  if (delivery.status === 'aborted') return copy.aborted;
  if (last === undefined || last === null) return copy.notStarted;
  const detail = last.error === null ? '' : `: ${last.error}`;
  switch (last.outcome) {
    case 'sending':
      return copy.sending;
    case 'response':
      return last.status === null ? copy.noAnswer : copy.answered(last.status);
    case 'network-error':
      return `${copy.noAnswer}${detail}`;
    case 'refused':
      return `${copy.refused}${detail}`;
    case 'interrupted':
      return copy.interrupted;
    case 'completed':
      return copy.completed;
    case 'rejected':
    case 'error':
      return `${copy.failed}${detail}`;
  }
}

/** The hooks with a failing last delivery first, then the rest in the order given. */
export function failingFirst<T>(items: readonly T[], failing: (item: T) => boolean): T[] {
  return [...items.filter(failing), ...items.filter((item) => !failing(item))];
}

/** Whether a hook matches the words typed into the search: its sentence, name, or action's address. */
export function hookMatches(hook: Hook, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');
  if (terms.length === 0) return true;
  const haystack = [hookSentence(hook), hookRowSentence(hook), hook.name ?? '', ...hook.events]
    .join(' ')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** An event kind as the clause a list row's sentence opens with: `schedule.missed` reads `a schedule misses a run`. */
export function eventClause(kind: string): string {
  const clauses = HOOKS_COPY.row.events;
  return Object.hasOwn(clauses, kind) ? (clauses[kind] ?? eventWords(kind)) : eventWords(kind);
}

/** An event kind as a name for a filter option: the clause with its first letter raised, `A run fails`. */
export function eventOptionLabel(kind: string): string {
  const clause = eventClause(kind);
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
}

/** The events of a hook as a clause: one, two joined by `or`, or the first and how many more. */
function eventClauses(events: readonly string[]): string {
  const clauses = events.map(eventClause);
  const [first, second] = clauses;
  if (first === undefined) return HOOKS_COPY.sentence.noEvent;
  if (second === undefined) return first;
  if (clauses.length === 2) return `${first} ${HOOKS_COPY.sentence.or} ${second}`;
  return `${first} ${HOOKS_COPY.sentence.or} ${HOOKS_COPY.sentence.more(clauses.length - 1)}`;
}

/** The host of a web address, which is what a row says a webhook goes to; the whole text when it is not an address. */
export function webhookHost(url: string): string {
  try {
    const host = new URL(url).host;
    return host === '' ? url : host;
  } catch {
    return url;
  }
}

/** The part of a hook a list row's sentence reads. */
type RowHook = {
  readonly events: readonly string[];
  readonly action: Hook['action'];
  readonly scope?: HookScope | null | undefined;
};

/** What a subject is called where a row says it: an identifier in words (`tool-runner` reads `Tool runner`). */
function subjectName(id: string): string {
  return agentLabel(id, undefined);
}

/** What a row's action says, with a webhook's whole address when `fullAddress` is set (for the tooltip). */
function rowActionPhrase(action: Hook['action'], fullAddress: boolean): string {
  const row = HOOKS_COPY.row;
  switch (action.type) {
    case 'webhook':
      return row.webhook(fullAddress ? action.url : webhookHost(action.url));
    case 'start-workflow':
      return row.startWorkflow(subjectName(action.workflowId));
    case 'notify':
      return HOOKS_COPY.sentence.notify;
    case 'plugin':
      return HOOKS_COPY.sentence.plugin(action.plugin, action.kind);
  }
}

/**
 * A hook as the sentence on line two of its list row: `When a run fails, send a webhook to
 * events.pagerduty.com`. A hook limited to a workflow reads it inside the sentence (`When a run
 * finishes in Triage inbox, notify me`). The row says the host of a webhook; `fullAddress` says all of it.
 */
export function hookRowSentence(hook: RowHook, fullAddress = false): string {
  const workflow =
    hook.scope?.kind === 'workflow'
      ? ` ${HOOKS_COPY.row.inWorkflow(subjectName(hook.scope.id))}`
      : '';
  return `${HOOKS_COPY.sentence.when} ${eventClauses(hook.events)}${workflow}, ${rowActionPhrase(hook.action, fullAddress)}`;
}

/** The two texts of a hook's list row: the bold title on line one and the muted line two. */
export type HookRowText = {
  readonly title: string;
  /** Line two; empty when a hook with no name has said all of it in its title. */
  readonly line: string;
};

/**
 * What a hook's list row says. The title is the hook's name, or its sentence when it has none. Line
 * two is the sentence (unless the title is it), then what else the hook is limited to, then, for a
 * hook that is off, when it last delivered, which line one does not say. The parts are joined by
 * commas. The row says the host of a webhook; `fullAddress` says all of it, for the tooltips.
 */
export function hookRowText(
  hook: Pick<ListedHook, 'name' | 'events' | 'action' | 'scope' | 'enabled' | 'lastDelivery'>,
  now: number,
  fullAddress = false,
): HookRowText {
  const sentence = hookRowSentence(hook, fullAddress);
  const parts = hook.name === null ? [] : [sentence];
  if (hook.scope !== null && hook.scope.kind !== 'workflow') {
    parts.push(HOOKS_COPY.row.onlyFor(subjectName(hook.scope.id)));
  }
  if (!hook.enabled && hook.lastDelivery !== null) {
    parts.push(HOOKS_COPY.row.lastDelivery(activityTime(hook.lastDelivery.updatedAt, now)));
  }
  const line = parts.join(', ');
  // With no sentence to lead it, the line starts with its own first word.
  return {
    title: hook.name ?? sentence,
    line: hook.name === null ? `${line.charAt(0).toUpperCase()}${line.slice(1)}` : line,
  };
}

/**
 * What a read of the list that failed says: a server error names the status it answered with ("The
 * server answered with an error (500)"), a read that got no answer says so, and anything else is
 * said plainly. Each ends by saying nothing the person did caused it.
 */
export function hookListFailure(error: unknown): string {
  const copy = HOOKS_COPY.list.loadFailed;
  if (isNetworkFailure(error)) return copy.noAnswer;
  if (error instanceof HttpClientError) return copy.answered(error.status);
  return copy.unknown;
}

/** What a hook's row says in the status column, or `undefined` when it has had no delivery. */
export function hookStatusWord(
  hook: Pick<ListedHook, 'enabled' | 'lastDelivery'>,
): StatusDotWord | undefined {
  if (!hook.enabled) return 'Off';
  const last = hook.lastDelivery;
  if (last === null) return undefined;
  switch (last.status) {
    case 'delivered':
      return 'Delivered';
    case 'pending':
      if (last.lastAttempt === null) return 'Waiting';
      return last.lastAttempt.outcome === 'sending' ? 'Running' : 'Retrying';
    case 'exhausted':
      return 'Gave up';
    case 'aborted':
      return 'Canceled';
    case 'failed':
    case 'failed-secret':
      return 'Failed';
  }
}

/** The time at the end of line one: the last delivery's, and nothing for a hook that is off, whose line two says it. */
export function hookTime(
  hook: Pick<ListedHook, 'enabled' | 'lastDelivery'>,
  now: number,
): string | undefined {
  if (!hook.enabled || hook.lastDelivery === null) return undefined;
  return activityTime(hook.lastDelivery.updatedAt, now);
}

/**
 * Whether a hook is failing and on: its last delivery ended without reaching its end, so it comes
 * first in the list. A hook that is off is not failing, whatever its last delivery did.
 */
export function hookFailing(hook: Pick<ListedHook, 'enabled' | 'lastDelivery'>): boolean {
  return hook.enabled && deliveryFailed(hook.lastDelivery);
}
