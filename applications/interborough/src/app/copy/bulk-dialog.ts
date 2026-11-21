/**
 * The words the bulk dialogs share (`routes/workflows/list/bulk-action-dialog`, which the purge
 * dialog configures): what is said while a commit runs, when the matching workflows changed after
 * the preview, and when nothing matches. One wording for the five bulk actions and purge, so a
 * person who has read one has read them all. A server's own sentence is never a title: the stale
 * notice is ours, and says what to do next.
 */

export const BULK_DIALOG_COPY = {
  /** While the commit is in flight: it finishes on the server even if the person leaves. */
  committing: 'Working on it. This keeps running on the server if you leave this page.',
  /**
   * The commit was refused because the matching workflows changed after the preview. Nothing was
   * done: the server checks the preview before it touches any workflow.
   */
  stale: {
    title: 'The matching workflows changed',
    body: 'Nothing was changed. Check the new count before you confirm.',
  },
  /** A preview that matched none: nothing to confirm, so no warning either. */
  nothingMatches: (subject: string, action: string): string =>
    `No ${subject} match this filter now, so there is nothing to ${action}.`,
} as const;
