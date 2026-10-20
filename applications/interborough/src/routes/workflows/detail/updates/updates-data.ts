/**
 * A run's update history (COR-1463): `weft.workflows.updates.list`, and each update's result through
 * `weft.updates.result.get`, both called through `client.operations[...]`.
 *
 * ## Where each fact comes from
 *
 * Weft keeps a record of every update a run has received (`weft.workflows.updates.list`): its name,
 * when it arrived, and its outcome, `pending`, `completed`, or `failed` with the handler's message.
 * The record outlives the answer. The answer itself, the update's result, is kept only five minutes,
 * and is read through `weft.updates.result.get`, which answers `pending` both for an update not yet
 * answered and for one whose answer has been swept. The history tells those two apart:
 *
 * - `failed`: the history holds the message, so no result is read.
 * - `completed`, and `result.get` answers `pending`: the result is no longer kept.
 * - `pending`, on a run that has ended: nothing will answer it ("never answered"), because the
 *   request is deleted when the run turns terminal.
 *
 * ## Why an update is sent over JSON-RPC, not the REST route
 *
 * `POST /v1/workflows/:id/update/:name` answers a timed-out update `408 Request Timeout`, and a
 * browser retries a request that gets a 408. Each retry is a new update, so one send that outlasts
 * its wait became a burst of duplicate updates (six in six seconds against the seeded server). The
 * JSON-RPC route answers HTTP 200 and carries the fault, with the update's id, in the envelope, so
 * nothing replays it. `HttpClient.submitCoordinatedUpdate` is the REST route; this module does not use it.
 */
import type { HttpClient } from '@lostgradient/weft';

export const UPDATES_LIST_OPERATION = 'weft.workflows.updates.list';
export const UPDATE_RESULT_OPERATION = 'weft.updates.result.get';
export const UPDATE_SEND_OPERATION = 'weft.workflows.update';

export type UpdatesClient = {
  readonly operations: Pick<
    HttpClient['operations'],
    typeof UPDATES_LIST_OPERATION | typeof UPDATE_RESULT_OPERATION | typeof UPDATE_SEND_OPERATION
  >;
};

/** How often a run with an unanswered update is asked for its history again. */
export const UPDATE_HISTORY_POLL_INTERVAL_MS = 2_000;

export type UpdateHistoryEntry = Awaited<
  ReturnType<HttpClient['operations'][typeof UPDATES_LIST_OPERATION]>
>['items'][number];

export interface UpdateHistoryPage {
  readonly items: readonly UpdateHistoryEntry[];
  readonly nextCursor: string | undefined;
}

export function updateHistoryQueryKey(workflowId: string): readonly unknown[] {
  return ['workflows', 'updates', workflowId];
}

export function updateResultQueryKey(updateId: string): readonly unknown[] {
  return ['workflows', 'update-result', updateId];
}

/** One page of the run's history, newest first; `cursor` is the previous page's `nextCursor`. */
export async function readUpdateHistory(
  client: UpdatesClient,
  workflowId: string,
  cursor?: string,
): Promise<UpdateHistoryPage> {
  const page = await client.operations[UPDATES_LIST_OPERATION]({
    workflowId,
    ...(cursor === undefined ? {} : { cursor }),
  });
  return { items: page.items, nextCursor: page.nextCursor };
}

export type UpdateResultReading =
  | { readonly status: 'pending' }
  | { readonly status: 'completed'; readonly result: unknown; readonly error: string | undefined };

/** The stored answer to one update, or `pending` when there is none (not answered yet, or swept). */
export async function readUpdateResult(
  client: UpdatesClient,
  updateId: string,
): Promise<UpdateResultReading> {
  const answer: unknown = await client.operations[UPDATE_RESULT_OPERATION]({ updateId });
  if (typeof answer !== 'object' || answer === null || !('status' in answer)) {
    throw new TypeError(`${UPDATE_RESULT_OPERATION} returned an unexpected shape`);
  }
  if (answer.status === 'pending') return { status: 'pending' };
  if (answer.status !== 'completed') {
    throw new TypeError(`${UPDATE_RESULT_OPERATION} returned an unexpected status`);
  }
  return {
    status: 'completed',
    result: 'result' in answer ? answer.result : undefined,
    error: 'error' in answer && typeof answer.error === 'string' ? answer.error : undefined,
  };
}

/** What an entry of the history shows as its outcome. */
export type UpdateDisplay =
  | { readonly kind: 'awaiting' }
  | { readonly kind: 'never-answered' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'loading-result' }
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'swept' };

/**
 * Whether an entry's result has to be read at all: only a `completed` update has one to show.
 * A `pending` one has none yet, and a `failed` one's message is in the history.
 */
export function entryNeedsResult(entry: UpdateHistoryEntry): boolean {
  return entry.outcome === 'completed';
}

export function describeUpdate(
  entry: UpdateHistoryEntry,
  result: UpdateResultReading | undefined,
  runIsTerminal: boolean,
): UpdateDisplay {
  switch (entry.outcome) {
    case 'failed':
      return { kind: 'failed', message: entry.error ?? 'The update failed.' };
    case 'pending':
      return runIsTerminal ? { kind: 'never-answered' } : { kind: 'awaiting' };
    case 'completed':
      if (result === undefined) return { kind: 'loading-result' };
      return result.status === 'pending'
        ? { kind: 'swept' }
        : { kind: 'result', value: result.result };
  }
}

/** Whether a rejected send is a `Timeout`: the update stays queued, and the history lists it. */
export function isSubmissionTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (
    ('status' in error && error.status === 408) ||
    ('faultCode' in error && error.faultCode === 'Timeout')
  );
}

/** What the send form gives `weft.workflows.update`. */
export interface UpdateSubmission {
  readonly name: string;
  readonly payload: unknown;
  readonly timeoutMs: number;
  readonly idempotencyKey: string | undefined;
}

/**
 * Send an update and wait for its answer. Rejects with the client's `HttpClientError` for every
 * fault: a `Timeout` (the update stays queued, and carries its id in the fault's data), an `Unprocessable`
 * (a validator refused it, or its handler failed), or any other.
 */
export async function sendUpdate(
  client: UpdatesClient,
  workflowId: string,
  submission: UpdateSubmission,
): Promise<{ readonly updateId: string; readonly result: unknown }> {
  return client.operations[UPDATE_SEND_OPERATION]({
    workflowId,
    updateName: submission.name,
    ...(submission.payload === undefined ? {} : { payload: submission.payload }),
    timeout: submission.timeoutMs,
    ...(submission.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: submission.idempotencyKey }),
  });
}
