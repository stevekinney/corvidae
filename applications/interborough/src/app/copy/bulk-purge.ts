/**
 * The words of the purge dialog on the workflow list (`routes/workflows/list/bulk-purge-dialog`)
 * that are its own: what a purge deletes and keeps, and what the person is told when a purge
 * failed part way. What every bulk dialog says the same way (committing, a stale preview, nothing
 * matching) is in `bulk-dialog.ts`. A purge cannot be undone, so the lead sentence says so at the
 * body's size and every other sentence says what is kept, what was deleted, or what to do next.
 */

/** "1 finished workflow" or "3 finished workflows". */
function finishedWorkflows(count: number): string {
  return `${String(count)} finished ${count === 1 ? 'workflow' : 'workflows'}`;
}

/** How many of the sample's ids a purge shows; the rest are said, not listed. */
export const PURGE_SAMPLE_SHOWN = 5;

export const BULK_PURGE_COPY = {
  /** The dialog's title: what is purged, in the words the lead sentence and the result use. */
  title: 'Purge finished workflows',
  /** The dry run is counting what a purge would delete. */
  loading: 'Counting the workflows a purge would delete',
  preview: {
    /** The first sentence: what happens, to how many, and that it cannot be reversed. */
    lead: (matched: number): string =>
      `Permanently deletes ${finishedWorkflows(matched)} matching this filter. This can't be undone.`,
    /** The disabled confirm button while the count is in flight: no number to name yet. */
    confirmWhileCounting: 'Purge',
    /** Under the lead: what a purge leaves alone. */
    kept: 'Workflows still running, or still running their cleanup step, are kept.',
    /** Above the ids the server named. */
    sampleIntro: 'These workflows will be deleted:',
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
} as const;
