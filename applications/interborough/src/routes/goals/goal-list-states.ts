/**
 * What the Goals list says when a read did not give it its goals (design rows 68n and 14s): the
 * same title whatever happened, and a sentence that names what did. A server error reads "The
 * server answered with an error (500)", a refusal also carries the server's own words, since it is
 * something to fix and not something that "nothing you did caused", and a read that got no answer
 * says so. The error's own words are kept for the "Show the error details" disclosure.
 */
import { HttpClientError } from '@lostgradient/weft';

import { GOALS_COPY } from '../../app/copy/goals.ts';
import { classifyFault, isNetworkFailure } from '../../lib/faults.ts';

/** The title and sentence of a read that did not give the page its goals. */
export interface GoalsLoadFailure {
  readonly title: string;
  readonly description: string;
  /** What the error said, for the disclosure that holds codes and traces; `undefined` when it said nothing. */
  readonly detail: string | undefined;
}

/** What a failed read of the goals says. */
export function goalsLoadFailure(error: unknown): GoalsLoadFailure {
  const copy = GOALS_COPY.failed;
  const message = error instanceof Error && error.message !== '' ? error.message : undefined;
  if (isNetworkFailure(error)) {
    return { title: copy.title, description: copy.noAnswer, detail: message };
  }
  if (error instanceof HttpClientError) {
    return {
      title: copy.title,
      description:
        classifyFault(error)?.kind === 'unauthorized'
          ? copy.refused(error.status, error.message)
          : copy.answered(error.status),
      detail: `HTTP ${String(error.status)}${message === undefined ? '' : `: ${message}`}`,
    };
  }
  return { title: copy.title, description: copy.unknown, detail: message };
}
