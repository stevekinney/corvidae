/**
 * Which words the Workers page says while it has no worker to list (rows 78x to 78z): the sentence
 * of a failed read, which names the status the server answered with, and says plainly when the
 * server did not answer at all or the person stopped the read.
 */
import { HttpClientError } from '@lostgradient/weft';

import { classifyFault, isNetworkFailure } from '../../lib/faults.ts';
import { WORKER_COPY } from './worker-copy.ts';

/** The states of the page with no worker list: being read, empty, failed, or stopped by the person. */
export type WorkersStateKind = 'loading' | 'empty' | 'failed' | 'cancelled';

/** The title and sentence of a read that did not give the page its workers. */
export interface WorkersLoadFailure {
  readonly title: string;
  readonly description: string;
}

/**
 * What a failed read says. A server error reads "The server answered with an error (500)", a
 * refusal also carries the server's own words, since it is something to fix and not something that
 * "nothing you did caused", and a read that got no answer says so. `cancelled` is a read the person
 * stopped, which failed nothing.
 */
export function workersLoadFailure(error: unknown, cancelled: boolean): WorkersLoadFailure {
  const copy = WORKER_COPY.states.failed;
  if (cancelled) return { title: copy.cancelledTitle, description: copy.cancelledDescription };
  if (isNetworkFailure(error)) {
    return { title: copy.title, description: copy.noAnswer };
  }
  if (error instanceof HttpClientError) {
    return {
      title: copy.title,
      description:
        classifyFault(error)?.kind === 'unauthorized'
          ? copy.refused(error.status, error.message)
          : copy.answered(error.status),
    };
  }
  return { title: copy.title, description: copy.unknown };
}
