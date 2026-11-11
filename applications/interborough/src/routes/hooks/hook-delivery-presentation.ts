/**
 * How the hook editor's delivery log says what one delivery holds: its status word and the qualifier
 * after it, the cause of a failure and what to try, the facts under it, the tries made, the payload
 * it sent, and whether it can be sent again. Pure, so the log and its tests share one reading. The
 * words are `HOOKS_COPY.editor.deliveries`; the header's one-line reading of the newest delivery is
 * `latestDelivery` in `hook-editor-presentation.ts`.
 */
import { formatDate, type StatusDotWordLabel } from '@lostgradient/cinder';
import { HttpClientError } from '@lostgradient/weft';

import { deliveryBody, type HookDelivery } from '../../lib/bureau-hooks.ts';
import { isNetworkFailure } from '../../lib/faults.ts';
import { clockTime, dayLabel } from '../health/health-times.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import { statusAnswer, summaryOf } from './hook-editor-presentation.ts';
import {
  deliveryFailed,
  eventOptionLabel,
  hookStatusWord,
  webhookHost,
} from './hook-presentation.ts';

const COPY = HOOKS_COPY.editor.deliveries;

/** How many tries an open delivery lists before the rest are folded under "Show all". */
export const ATTEMPTS_SHOWN = 3;

type Attempt = HookDelivery['attempts'][number];

/** A moment as the log writes it, with its weekday: `Fri Oct 30, 11:19 AM`. */
export function deliveryStamp(at: number): string {
  const weekday = formatDate(at, 'en-US', { weekday: 'short' });
  return `${weekday} ${dayLabel(at)}, ${clockTime(at)}`;
}

/** What a delivery is about on its line: the event in words, or that it was a test. */
export function deliverySubject(delivery: Pick<HookDelivery, 'test' | 'kind'>): string {
  return delivery.test ? COPY.testEvent : eventOptionLabel(delivery.kind);
}

/** What a try came to, short enough for the right-hand column: `410 Gone`, `No answer`. */
export function attemptAnswer(attempt: Attempt): string {
  const words = COPY.answer;
  switch (attempt.outcome) {
    case 'response':
      return attempt.status === null ? words.noAnswer : statusAnswer(attempt.status);
    case 'network-error':
      return words.noAnswer;
    case 'refused':
      return words.refused;
    case 'interrupted':
      return words.interrupted;
    case 'sending':
      return words.sending;
    case 'completed':
      return words.completed;
    case 'rejected':
    case 'error':
      return words.failed;
  }
}

/**
 * The word a delivery's line leads with, and what the Bureau told: `Delivered, 200 OK` once a
 * receiver accepted it, `Retrying, try 3 of 8` while it waits, and the bare word otherwise
 * (`Gave up`, `Failed`, `Canceled`, `Waiting`, `Running`).
 */
export function deliveryStatusWord(delivery: HookDelivery): StatusDotWordLabel {
  const word = hookStatusWord({ enabled: true, lastDelivery: summaryOf(delivery) }) ?? 'Waiting';
  const last = delivery.attempts.at(-1);
  if (word === 'Delivered' && last !== undefined && last.status !== null) {
    const delivered: StatusDotWordLabel = `Delivered, ${statusAnswer(last.status)}`;
    return delivered;
  }
  if (word === 'Retrying') {
    const retrying: StatusDotWordLabel = `Retrying, ${COPY.tryOf(
      delivery.attempts.length,
      delivery.maxAttempts,
    )}`;
    return retrying;
  }
  return word;
}

/** The two ways a delivery is sent again: from a failure, or ahead of its backoff. */
export type RetryKind = 'retry' | 'retry-now';

/**
 * How a delivery can be sent again. A delivery that failed gets a "Retry delivery"; one still
 * retrying, with a try due, gets "Retry now". A delivered, stopped or mid-send delivery gets none.
 */
export function retryKind(delivery: HookDelivery): RetryKind | undefined {
  if (deliveryFailed(delivery)) return 'retry';
  if (delivery.status !== 'pending' || delivery.nextAttemptAt === null) return undefined;
  return delivery.attempts.at(-1)?.outcome === 'sending' ? undefined : 'retry-now';
}

/** How long until a try, in words: `40 seconds`, `2 minutes`, `a moment` when it is due. */
export function nextTryWords(nextAttemptAt: number, now: number): string {
  const seconds = Math.ceil((nextAttemptAt - now) / 1000);
  if (seconds <= 0) return COPY.nextTryDue;
  if (seconds < 90) return `${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)} minutes`;
  const hours = Math.round(minutes / 60);
  return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** The hint that ends a failure's cause: what a status says is likely wrong, and the next step. */
function failureHint(status: number | null): string {
  if (status === 404 || status === 410) return COPY.cause.hintRemoved;
  if (status === 401 || status === 403) return COPY.cause.hintSignature;
  return COPY.cause.hintDefault;
}

/**
 * Why a delivery that ended badly ended, in a sentence or two, and what to try. `undefined` for a
 * delivery that is delivered or still going. A webhook names its receiver by host; another action
 * has none, so the sentence says "The receiver".
 */
export function deliveryCause(delivery: HookDelivery): string | undefined {
  const copy = COPY.cause;
  switch (delivery.status) {
    case 'delivered':
    case 'pending':
      return undefined;
    case 'aborted':
      return HOOKS_COPY.attempt.aborted;
    case 'failed-secret':
      return copy.secretMissing;
    case 'exhausted':
    case 'failed':
      break;
  }
  const receiver = delivery.request === null ? copy.receiver : webhookHost(delivery.request.url);
  const tries = delivery.attempts.length;
  const last = delivery.attempts.at(-1);
  if (last === undefined) return copy.notSent(receiver);
  if (delivery.status === 'failed') return copy.refusedOutright(receiver, copy.hintDefault);
  if (last.outcome === 'refused') {
    return copy.refused(last.error === null ? '' : `: ${last.error}`, copy.hintDefault);
  }
  const answers = new Set(delivery.attempts.map(attemptAnswer));
  if (last.outcome === 'response' && last.status !== null) {
    return answers.size === 1
      ? copy.answeredEvery(receiver, statusAnswer(last.status), tries, failureHint(last.status))
      : copy.answeredLast(receiver, statusAnswer(last.status), tries, failureHint(last.status));
  }
  return copy.noAnswer(receiver, tries, answers.size === 1, copy.hintDefault);
}

/** One line of the facts under an open delivery. */
export type DeliveryFact = {
  readonly label: string;
  readonly value: string;
  /** The raw event kind, drawn small and monospaced after the value. */
  readonly code?: string;
};

/** What an open delivery's facts say: the event, where it was sent, and the last answer with its time. */
export function deliveryFacts(delivery: HookDelivery): DeliveryFact[] {
  const copy = COPY.facts;
  const facts: DeliveryFact[] = [
    delivery.test
      ? { label: copy.event, value: COPY.testEvent }
      : { label: copy.event, value: eventOptionLabel(delivery.kind), code: delivery.kind },
  ];
  if (delivery.request !== null) {
    facts.push({ label: copy.sentTo, value: webhookHost(delivery.request.url) });
  }
  const last = delivery.attempts.at(-1);
  if (last !== undefined && last.outcome !== 'sending') {
    facts.push({
      label: copy.lastResponse,
      value: `${attemptAnswer(last)}, ${deliveryStamp(last.finishedAt ?? last.startedAt)}`,
    });
  }
  return facts;
}

/** The tries an open delivery lists, and what is folded under "Show all". */
export type AttemptList = {
  readonly shown: readonly Attempt[];
  /** The line about the tries not listed, or `undefined` when all are listed. */
  readonly folded: string | undefined;
};

/**
 * The tries of a delivery in order. Unless `all`, only the first {@link ATTEMPTS_SHOWN} are listed
 * and the rest are summarised: `5 more tries, all 410 Gone.` when they ended the same way.
 */
export function attemptList(delivery: Pick<HookDelivery, 'attempts'>, all: boolean): AttemptList {
  const attempts = delivery.attempts;
  if (all || attempts.length <= ATTEMPTS_SHOWN) return { shown: attempts, folded: undefined };
  const rest = attempts.slice(ATTEMPTS_SHOWN);
  const answers = new Set(rest.map(attemptAnswer));
  const [only] = answers;
  return {
    shown: attempts.slice(0, ATTEMPTS_SHOWN),
    folded: COPY.moreTries(rest.length, answers.size === 1 ? only : undefined),
  };
}

/** What the payload inspector is given for a delivery. */
export type DeliveryPayload =
  | { readonly kind: 'none' }
  | { readonly kind: 'fields'; readonly value: unknown }
  | { readonly kind: 'text'; readonly value: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The payload a delivery sent, for the inspector. A webhook's body is an envelope (`id`, `hookId`,
 * `kind`, `payload` and the rest); the inspector is given the event kind and the fields of its
 * `payload`, which are what the receiver acts on, so Fields reads `Event` first. A body that is not
 * an envelope is shown as it is, and one that is not JSON as text. A delivery that sent no request
 * has no payload.
 */
export function deliveryPayload(delivery: Pick<HookDelivery, 'request' | 'kind'>): DeliveryPayload {
  if (delivery.request === null) return { kind: 'none' };
  const body = deliveryBody(delivery);
  if (body === undefined) {
    return delivery.request.body === ''
      ? { kind: 'none' }
      : { kind: 'text', value: delivery.request.body };
  }
  if (!isRecord(body) || !Object.hasOwn(body, 'payload')) return { kind: 'fields', value: body };
  const kind = typeof body['kind'] === 'string' ? body['kind'] : delivery.kind;
  const payload = body['payload'];
  if (payload === undefined || payload === null) return { kind: 'fields', value: { event: kind } };
  return {
    kind: 'fields',
    value: isRecord(payload) ? { event: kind, ...payload } : { event: kind, payload },
  };
}

/** Writes the `event` field of {@link deliveryPayload} as the event in words and its kind: `A run fails (run.error)`. */
export function payloadFieldText(path: readonly string[], value: unknown): string | undefined {
  if (path.length !== 1 || path[0] !== 'event' || typeof value !== 'string') return undefined;
  return COPY.eventField(eventOptionLabel(value), value);
}

/**
 * What a read of the delivery log that failed says: a server error names its status, a read that
 * got no answer says so, and each says the hook itself is unchanged.
 */
export function deliveryLogFailure(error: unknown): string {
  const copy = COPY.loadFailed;
  if (isNetworkFailure(error)) return copy.noAnswer;
  if (error instanceof HttpClientError) return copy.answered(error.status);
  return copy.unknown;
}
