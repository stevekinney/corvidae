<script lang="ts" module>
  export const title = 'Cursor pagination';
  export const description =
    'Callback mode: the caller keeps the cursors and Pagination reports when the user asks for the previous or next page, without changing currentPage.';
</script>

<script lang="ts">
  import { Pagination } from '@lostgradient/cinder';

  type CursorPage = {
    previousCursor?: string;
    nextCursor?: string;
  };

  const pagesByCursor: Record<string, CursorPage> = {
    'cursor-page-1': { nextCursor: 'cursor-page-2' },
    'cursor-page-2': { previousCursor: 'cursor-page-1', nextCursor: 'cursor-page-3' },
    'cursor-page-3': { previousCursor: 'cursor-page-2' },
  };

  let cursor = $state('cursor-page-1');

  const current = $derived(pagesByCursor[cursor] ?? {});

  function goPrevious(): void {
    if (current.previousCursor !== undefined) cursor = current.previousCursor;
  }

  function goNext(): void {
    if (current.nextCursor !== undefined) cursor = current.nextCursor;
  }
</script>

<Pagination
  hasPreviousPage={current.previousCursor !== undefined}
  hasNextPage={current.nextCursor !== undefined}
  onPrevious={goPrevious}
  onNext={goNext}
/>
<p style="margin-top: 0.5rem; color: var(--cinder-text-muted);">
  Cursor: {cursor}
</p>
