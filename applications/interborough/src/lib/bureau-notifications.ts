/**
 * The browser's view of the caller's own notifications: `bureau.notifications.list`, `.markread`
 * and `.dismiss` (COR-1941), through the generated client. The Bureau writes a notification for a
 * failed run, a run over its budget, and a review waiting; the app reads them here and never writes one.
 */
import { bureauClient, type BureauOutput } from './bureau-api.ts';

/**
 * One notification, as `bureau.notifications.list` shows it. `kind` is `run.failed`,
 * `run.budget-exceeded` or `review.waiting` when the Bureau wrote it.
 */
export type BureauNotification = BureauOutput<'bureau.notifications.list'>['notifications'][number];

type Options = { readonly signal?: AbortSignal };

type MarkReadOptions = Options & {
  /** Marks every notification the caller has read, not only the identifiers given. */
  readonly all?: boolean;
};

/** How many notifications the bell asks for: the Bureau's page size cap. */
export const NOTIFICATION_PAGE_LIMIT = 100;

/** The caller's newest notifications, not dismissed, newest first. */
export async function listBureauNotifications(
  options?: Options,
): Promise<readonly BureauNotification[]> {
  const page = await bureauClient['bureau.notifications.list'](
    { limit: NOTIFICATION_PAGE_LIMIT },
    options,
  );
  return page.notifications;
}

/** How many identifiers `bureau.notifications.markread` takes in one call. */
const MARK_READ_BATCH = 100;

/**
 * Marks the given notifications read, a call for each {@link MARK_READ_BATCH}, so none is left
 * unread by a list longer than one call takes. With `all`, one call marks every notification the
 * caller has, including those the bell has not loaded (it lists the newest 100 only). Resolves how
 * many it changed; rejects when any call does.
 */
export async function markBureauNotificationsRead(
  ids: readonly string[],
  options?: MarkReadOptions,
): Promise<number> {
  if (options?.all === true) {
    const change = await bureauClient['bureau.notifications.markread'](
      { all: true },
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    return change.updated;
  }
  // A snapshot: the caller's list is not read again after the first call is awaited.
  const wanted = [...ids];
  let updated = 0;
  for (let start = 0; start < wanted.length; start += MARK_READ_BATCH) {
    const batch = wanted.slice(start, start + MARK_READ_BATCH);
    const change = await bureauClient['bureau.notifications.markread']({ ids: batch }, options);
    updated += change.updated;
  }
  return updated;
}
