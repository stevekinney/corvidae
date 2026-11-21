/**
 * The words of the purge dialog on the workflow list (`routes/workflows/list/bulk-purge-dialog`):
 * what a purge deletes and keeps, and what the person is told when the workflows that match
 * changed between the preview and the purge. A purge cannot be undone, so the lead sentence says
 * so at body size and every other sentence says what is kept, what was deleted, or what to do next.
 */

/** "1 finished workflow" or "3 finished workflows". */
function finishedWorkflows(count: number): string {
  return `${String(count)} finished ${count === 1 ? 'workflow' : 'workflows'}`;
}

export const BULK_PURGE_COPY = {
  /** The dialog's title: what is purged, in the words the lead sentence and the result use. */
  title: 'Purge finished workflows',
  /** While the commit is in flight: the server finishes the purge even if the person leaves. */
  committing: 'Purging. This keeps running on the server if you leave this page.',
  /** The dry run is counting what a purge would delete. */
  loading: 'Counting the workflows a purge would delete',
  preview: {
    /** The first sentence: what happens, to how many, and that it cannot be reversed. */
    lead: (matched: number): string =>
      `Permanently deletes ${finishedWorkflows(matched)} matching this filter. This can't be undone.`,
    /** Under the lead: what a purge leaves alone. */
    kept: 'Workflows still running, or still running their cleanup step, are kept.',
    /** Above the ids the server named. */
    sampleIntro: 'These workflows will be deleted:',
    /** A preview that matched none: nothing to confirm, so no warning either. */
    nothing: 'No finished workflows match this filter now, so there is nothing to purge.',
    /** The ids the list does not show. */
    notShown: (count: number): string => `…and ${String(count)} more.`,
  },
  /**
   * A fault that is not a stale preview. A failed commit may have deleted some workflows before it
   * failed (the server's message says how many when it knows), or been cut off, so the person
   * counts what is left instead of pressing the same purge again.
   */
  failed: {
    refreshNote: 'Refresh the preview to see what is left.',
  },
  /**
   * The purge was refused because the matching workflows changed after the preview. Nothing was
   * deleted: the server checks the preview before it touches any workflow.
   */
  stale: {
    title: 'The matching workflows changed',
    body: 'Nothing was purged. Check the new count before you purge.',
  },
} as const;
