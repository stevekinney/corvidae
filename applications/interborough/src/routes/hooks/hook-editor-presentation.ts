/**
 * How the hook editor says what it holds: the hook as a sentence in the editor's words ("When a run
 * fails, for any workflow, send a webhook to events.pagerduty.com."), its title, what its newest
 * delivery came to for the header, what a test event came to for the line under the buttons, and
 * the compact summaries the phone shows for a step. Pure, so the page and its tests share one
 * reading. The list's own sentence is `hookRowSentence` in `hook-presentation.ts`.
 */
import type { StatusDotWord } from '@lostgradient/cinder';
import { HttpClientError } from '@lostgradient/weft';

import { formatDateTime } from '@lostgradient/cinder';
import { agentLabel } from '../../lib/agent-label.ts';
import type {
  Hook,
  HookDelivery,
  HookDeliverySummary,
  HookScope,
  HookScopeKind,
} from '../../lib/bureau-hooks.ts';
import { faultTreatment, isNetworkFailure } from '../../lib/faults.ts';
import { clockTime, dayLabel } from '../health/health-times.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import {
  eventClauses,
  hookStatusWord,
  isScopeKind,
  webhookHost,
  type DraftAction,
} from './hook-presentation.ts';

const COPY = HOOKS_COPY.editor;

/** The part of a hook the editor's sentence reads: a hook as saved, or the draft on the form. */
export type EditorHook = {
  readonly events: readonly string[];
  readonly action: Hook['action'] | DraftAction;
  readonly scope?: HookScope | null | undefined;
};

/** What a name or an identifier reads as in a sentence: `tool-runner` is `Tool runner`. */
function subjectName(id: string): string {
  return agentLabel(id, undefined);
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** What the action says: a webhook says the host it goes to, never the whole address. */
function actionClause(action: EditorHook['action']): string {
  const row = HOOKS_COPY.row;
  switch (action.type) {
    case 'webhook':
      return action.url === ''
        ? HOOKS_COPY.sentence.webhookUnset
        : row.webhook(webhookHost(action.url));
    case 'start-workflow':
      return action.workflowId === ''
        ? HOOKS_COPY.sentence.startWorkflowUnset
        : row.startWorkflow(subjectName(action.workflowId));
    case 'notify':
      return HOOKS_COPY.sentence.notify;
    case 'plugin':
      return HOOKS_COPY.sentence.plugin(action.plugin, action.kind);
  }
}

/** What a scope adds after the events: the one subject, or `any` of the kind when none is chosen. */
function limitClause(
  scope: HookScope | null | undefined,
  anyOf: HookScopeKind | undefined,
): string | undefined {
  const words = HOOKS_COPY.sentence;
  if (scope !== null && scope !== undefined) {
    return isScopeKind(scope.kind)
      ? words[scope.kind](subjectName(scope.id))
      : words.other(scope.kind, subjectName(scope.id));
  }
  return anyOf === undefined ? undefined : `for any ${anyOf}`;
}

/**
 * A hook as the editor's sentence, without its full stop: `When a run fails, for any workflow, send
 * a webhook to events.pagerduty.com`. `anyOf` names the kind of subject the events narrow by when
 * the hook is limited to none, so the sentence says it covers any of them (`undefined` for events
 * about the whole system, which no subject narrows).
 */
export function editorClause(hook: EditorHook, anyOf: HookScopeKind | undefined): string {
  const limit = limitClause(hook.scope, anyOf);
  return [
    `${HOOKS_COPY.sentence.when} ${eventClauses(hook.events)}`,
    limit,
    actionClause(hook.action),
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');
}

/** The editor's sentence with its full stop, which the header and the Check step show. */
export function editorSentence(hook: EditorHook, anyOf: HookScopeKind | undefined): string {
  return `${editorClause(hook, anyOf)}.`;
}

/** What names a saved hook: its name, or its sentence (without the full stop) when it has none. */
export function editorTitle(
  hook: EditorHook & { readonly name: string | null },
  anyOf: HookScopeKind | undefined,
): string {
  return hook.name === null || hook.name === '' ? editorClause(hook, anyOf) : hook.name;
}

/** The kind of subject Only for narrows by, when the events chosen can be narrowed by a workflow. */
export function anyScopeOf(allowed: readonly HookScopeKind[]): HookScopeKind | undefined {
  return allowed.includes('workflow') ? 'workflow' : undefined;
}

/** What the phone's When step says: the events, then what the hook is limited to. */
export function whenSummary(hook: EditorHook, anyOf: HookScopeKind | undefined): string {
  const events = capitalized(eventClauses(hook.events));
  const limit = limitClause(hook.scope, anyOf);
  return COPY.steps.whenSummary(
    events,
    limit === undefined ? undefined : capitalized(limit.replace(/^for /, '')),
  );
}

/** What the phone's Then step says: `Send a webhook to events.pagerduty.com`. */
export function thenSummary(action: EditorHook['action']): string {
  return capitalized(actionClause(action));
}

/** A moment as the header says it: the clock for today, "Yesterday, 4:12 PM", or "Oct 30, 11:19 AM". */
export function deliveryMoment(at: number, now: number): string {
  const label = formatDateTime(at, { now, dayWords: true });
  if (label.startsWith('Today, ')) return clockTime(at);
  if (label.startsWith('Yesterday, ')) return label;
  return `${dayLabel(at)}, ${clockTime(at)}`;
}

const STATUS_REASONS = new Map<number, string>([
  [200, 'OK'],
  [201, 'Created'],
  [202, 'Accepted'],
  [204, 'No Content'],
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [405, 'Method Not Allowed'],
  [408, 'Request Timeout'],
  [409, 'Conflict'],
  [410, 'Gone'],
  [413, 'Payload Too Large'],
  [422, 'Unprocessable Content'],
  [429, 'Too Many Requests'],
  [500, 'Internal Server Error'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
  [504, 'Gateway Timeout'],
]);

/** What a receiver's status reads as: `410 Gone`, or the number alone for one this page has no words for. */
export function statusAnswer(status: number): string {
  const reason = STATUS_REASONS.get(status);
  return reason === undefined ? String(status) : `${String(status)} ${reason}`;
}

/** A delivery as the list carries it: where it stands and how its last attempt ended. */
export function summaryOf(delivery: HookDelivery): HookDeliverySummary {
  const last = delivery.attempts.at(-1);
  return {
    id: delivery.id,
    kind: delivery.kind,
    test: delivery.test,
    status: delivery.status,
    lastAttempt:
      last === undefined
        ? null
        : {
            number: last.number,
            startedAt: last.startedAt,
            finishedAt: last.finishedAt,
            outcome: last.outcome,
            status: last.status,
            error: last.error,
          },
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

/** What the header says of the newest delivery: its word, when it came to it, and what the receiver answered. */
export type LatestDelivery = {
  /** The status word, or `undefined` for a hook that has sent nothing. */
  readonly word: StatusDotWord | undefined;
  readonly when: string | undefined;
  readonly answer: string | undefined;
  /** Whether the delivery failed for good, so the header says it in the danger colour. */
  readonly failed: boolean;
};

/** Reads the newest delivery (the first of the list, which is newest first) for the header. */
export function latestDelivery(
  deliveries: readonly HookDelivery[] | undefined,
  now: number,
): LatestDelivery {
  const newest = deliveries?.[0];
  if (newest === undefined)
    return { word: undefined, when: undefined, answer: undefined, failed: false };
  const summary = summaryOf(newest);
  const word = hookStatusWord({ enabled: true, lastDelivery: summary });
  const last = summary.lastAttempt;
  const answer =
    last !== null && last.outcome === 'response' && last.status !== null
      ? statusAnswer(last.status)
      : undefined;
  return {
    word,
    when: deliveryMoment(newest.updatedAt, now),
    answer,
    failed: word === 'Failed' || word === 'Gave up',
  };
}

/** What a test event came to: the line under the buttons and whether it was a success. */
export type TestOutcome = { readonly ok: boolean; readonly text: string };

/**
 * Reads the record of a test event the Bureau answered. `address` is the web address it was sent
 * to, `saved` whether the hook it tested was saved (a test of a hook not yet saved says that nothing
 * was saved).
 */
export function testOutcome(delivery: HookDelivery, address: string, saved: boolean): TestOutcome {
  const copy = COPY.check;
  const host = webhookHost(address);
  const last = delivery.attempts.at(-1);
  const status = last?.outcome === 'response' ? last.status : null;
  if (delivery.status === 'delivered' && last !== undefined && status !== null) {
    const milliseconds = last.finishedAt === null ? undefined : last.finishedAt - last.startedAt;
    const sent = copy.testSent(host, statusAnswer(status), milliseconds);
    return { ok: true, text: saved ? sent : `${sent} ${copy.testSentUnsaved}` };
  }
  const reason =
    status === null
      ? copy.testFailedNoAnswer(host)
      : copy.testFailedAnswered(host, statusAnswer(status));
  return { ok: false, text: `${copy.testFailed} ${reason}` };
}

/**
 * Why a write the editor made failed, in the words the page says it with: the status of a server
 * that answered with an error, that nothing answered, or the fault's own words.
 */
export function hookWriteReason(error: unknown): string {
  if (isNetworkFailure(error)) return COPY.noAnswer;
  if (error instanceof HttpClientError && error.status >= 500) {
    return COPY.answeredWithError(error.status);
  }
  return faultTreatment(error).message;
}
