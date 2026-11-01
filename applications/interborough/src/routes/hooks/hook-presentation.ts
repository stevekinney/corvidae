/**
 * How the hooks pages say what the Bureau holds: an event kind in plain words and the area it is
 * grouped under, which events an action may listen to, a hook as a sentence, and what a delivery
 * came to. Pure, so the pages and their tests share one reading.
 */
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
} from '../../lib/bureau-hooks.ts';
import { scheduleDetailPath, workflowDetailPath } from '../../lib/router.svelte.ts';
import type { StatusWord } from '../../lib/status.ts';
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
  const haystack = [hookSentence(hook), hook.name ?? '', ...hook.events].join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
