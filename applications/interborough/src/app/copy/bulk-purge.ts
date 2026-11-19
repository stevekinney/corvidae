/**
 * The words of the purge dialog on the workflow list (`routes/workflows/list/bulk-purge-dialog`):
 * what a purge deletes and keeps, and what the person is told when the workflows that match
 * changed between the preview and the purge. A purge cannot be undone, so the lead sentence says
 * so at body size and every other sentence says what is kept, what was deleted, or what to do next.
 */
export const BULK_PURGE_COPY = {
  /**
   * The purge was refused because the matching workflows changed after the preview. Nothing was
   * deleted: the server checks the preview before it touches any workflow.
   */
  stale: {
    title: 'The matching workflows changed',
    body: 'Nothing was purged. Check the new count before you purge.',
    refreshAction: 'Refresh preview',
  },
} as const;
