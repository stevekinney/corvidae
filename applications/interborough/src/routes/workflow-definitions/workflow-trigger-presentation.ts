/**
 * What the line under a workflow's "Starts" line says about its plugin trigger (COR-2171): the
 * status as a word beside its dot, the words after it that the word does not say, which control the
 * state offers (Retry now, or Edit for a configuration the plugin refused), and the code that goes
 * last. Plain data in the words `app/copy/workflows.ts` holds, so each state is tested without a page.
 */
import type { StatusDotWordLabel } from '@lostgradient/cinder';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { clockTime } from '../../lib/format/clock.ts';
import { nextTryWords } from '../../lib/format/next-try.ts';
import type { WorkflowListener } from '../../lib/workflow-files.ts';

const copy = WORKFLOW_COPY.page.listener;

/** What a state asks the line to draw, in order: the word, what follows it, then the control. */
export type TriggerStatus = {
  readonly word: StatusDotWordLabel;
  /** What follows the word, ending in a full stop, or the sentence before the link for a secret. */
  readonly text: string;
  /** For a trigger waiting for a secret: the link to where it is added, and what ends the sentence. */
  readonly settings: { readonly link: string; readonly after: string } | null;
  /** "Last started a run at 10:02 AM.", or `null` when no run has started since the Bureau did. */
  readonly lastStarted: string | null;
  /** Retry now is offered: a failed trigger that is tried again. */
  readonly canRetry: boolean;
  /** Edit is offered instead: a configuration the plugin refused is not tried again until it changes. */
  readonly canEdit: boolean;
  /** The code a failed trigger carries, which goes last, or `null`. */
  readonly code: string | null;
};

/** A time as a clock reads it, in the viewer's zone, so it stays true while the page is open. */
function at(iso: string): string {
  return clockTime(Date.parse(iso));
}

/** The words after the status word of one state. `now` is the clock the next try is counted from. */
function after(listener: WorkflowListener, now: number): string {
  switch (listener.state) {
    case 'listening':
      return copy.after.listening(at(listener.since));
    case 'ready':
      return copy.after.ready(at(listener.since));
    case 'standby':
      return copy.after.standby;
    case 'stopped':
      return copy.after.stopped;
    case 'waiting-for-secret':
      return '';
    case 'failed':
      if (listener.code === 'configuration-refused') return copy.after.configurationRefused;
      return listener.retryAt === null
        ? copy.after.startFailed
        : copy.after.startFailedRetrying(nextTryWords(Date.parse(listener.retryAt), now));
  }
}

/**
 * Reads a listener as the line says it. `pluginTitle` is the title of the plugin the trigger belongs
 * to, or `undefined` until the host has said, which a secret's sentence says as "The plugin".
 */
export function triggerStatus(
  listener: WorkflowListener,
  input: { readonly now: number; readonly pluginTitle: string | undefined },
): TriggerStatus {
  const waiting = listener.state === 'waiting-for-secret';
  const refused = listener.state === 'failed' && listener.code === 'configuration-refused';
  return {
    word: copy.states[listener.state],
    text: waiting ? copy.waitingForSecret.before(input.pluginTitle) : after(listener, input.now),
    settings: waiting
      ? { link: copy.waitingForSecret.link, after: copy.waitingForSecret.after }
      : null,
    lastStarted:
      listener.lastFiredAt === null ? null : copy.lastStartedRun(at(listener.lastFiredAt)),
    canRetry: listener.state === 'failed' && !refused,
    canEdit: refused,
    code: listener.state === 'failed' ? listener.code : null,
  };
}

/**
 * How often the next try's words are read again: each second in the last minute and a half, when
 * they count seconds, and each half minute before it. `null` when there is nothing to count: no
 * try is scheduled, or it is due and the words say "a moment".
 */
export function nextTryClockPeriod(listener: WorkflowListener, now: number): number | null {
  if (listener.state !== 'failed' || listener.retryAt === null) return null;
  const remaining = Date.parse(listener.retryAt) - now;
  if (remaining <= 0) return null;
  return remaining < 90_000 ? 1_000 : 30_000;
}
