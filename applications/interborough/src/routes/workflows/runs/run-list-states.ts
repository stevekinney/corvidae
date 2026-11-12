/**
 * The words of `/runs` in the states that are not a list of rows (`run-list.svelte`): the sentence
 * of a list the filters leave empty, and what a list that could not be read tells the person. Plain
 * functions (no rune, no component), so the page, its tests and the browser specs read one source.
 */
import { HttpClientError } from '@lostgradient/weft';

import { TASK_COPY } from '../../../app/copy/tasks.ts';
import { isNetworkFailure } from '../../../lib/faults.ts';
import type { RunFilter } from './run-rows.ts';
import { STARTED_BY_LABELS, type StartedBy } from './started-by.ts';

/**
 * What started a run as it reads after "started by": "a goal", "a schedule", "Interborough". The
 * filter's own labels lead with a capital because they stand alone ("A goal").
 */
export function startedByPhrase(kind: StartedBy): string {
  const label = STARTED_BY_LABELS[kind];
  return /^(A|An|The) /.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

/**
 * The sentence under "No runs match these filters": which runs there are none of, then which of the
 * filters that are on to change. A filter that is not on is not named, so "Model switcher has no
 * runs. Try another agent." and "Model switcher has no runs started by a goal. Try another agent or
 * origin." are the same function of the address.
 *
 * @param filter - The filters the address applies.
 * @param agent - The chosen agent as a person reads it, when one is chosen.
 */
export function runNoMatchDescription(filter: RunFilter, agent: string | undefined): string {
  const copy = TASK_COPY.list.noMatch;
  const clauses = [
    copy.none(agent, filter.status === undefined ? undefined : copy.statusWords[filter.status]),
    ...(filter.startedBy === undefined ? [] : [copy.startedBy(startedByPhrase(filter.startedBy))]),
    ...(filter.search === undefined ? [] : [copy.matching(filter.search)]),
  ];
  const changeable = [
    ...(filter.status === undefined ? [] : [copy.filters.status]),
    ...(filter.agent === undefined ? [] : [copy.filters.agent]),
    ...(filter.startedBy === undefined ? [] : [copy.filters.origin]),
    ...(filter.search === undefined ? [] : [copy.filters.search]),
  ];
  return `${clauses.join(' ')}. ${copy.tryAnother(changeable)}`;
}

/** One read the list makes, and what it failed with: `null` for a read that did not fail. */
export interface RunListRead {
  /** The Bureau operation the read calls, which the error details name. */
  readonly operation: string;
  /** What the read failed with, or `null` when it did not fail. */
  readonly error: unknown;
}

/** What a list that could not be read says: a sentence, and the details behind it. */
export interface RunListFailure {
  /** The plain-words sentence under "Couldn’t load runs". */
  readonly description: string;
  /** The codes and the operations that failed, one per line, for the error-details disclosure. */
  readonly detail: string;
}

function describeError(error: unknown): string {
  if (error instanceof HttpClientError) {
    const code = error.faultCode === undefined ? '' : ` ${error.faultCode}`;
    return `HTTP ${String(error.status)}${code}: ${error.message}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * What the failed reads of the list say. When a fault carried a status, the sentence names it; when
 * every read got no answer at all it says the server did not answer, because a status would be
 * invented; any other failure (a fault with no status) says the server answered with an error.
 *
 * @param reads - Every read the list makes: the error of each that failed, `null` for the rest.
 */
export function runListFailure(reads: readonly RunListRead[]): RunListFailure {
  const failed = reads.filter((read) => read.error !== null && read.error !== undefined);
  const status = failed
    .map((read) => read.error)
    .find((error): error is HttpClientError => error instanceof HttpClientError)?.status;
  const unreachable =
    status === undefined &&
    failed.length > 0 &&
    failed.every((read) => isNetworkFailure(read.error));
  return {
    description: unreachable
      ? TASK_COPY.list.loadFailed.unreachable
      : TASK_COPY.list.loadFailed.description(status),
    detail: failed.map((read) => `${read.operation}: ${describeError(read.error)}`).join('\n'),
  };
}
