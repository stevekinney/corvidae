<script lang="ts" module>
  /**
   * How long a load is let to finish before anything is drawn for it, which is Cinder's loading
   * rule: a read that is quick never flashes a placeholder.
   */
  export const RUN_LIST_LOADING_DELAY_MILLISECONDS = 300;

  /** How long a load runs before the placeholders say it is taking longer than usual. */
  export const RUN_LIST_STILL_LOADING_MILLISECONDS = 10_000;
</script>

<script lang="ts">
  /**
   * `/runs` while its runs have not arrived: a read in progress (rows 10k, 10l, 14n and 52z) and a
   * read the person canceled (row 14p). Both keep the page's header, which is the page's and not
   * drawn here, and both keep the filter bar, drawn by the page (`bar`) with its six segments and no
   * counts, because the counts wait for the data.
   *
   * A read in progress draws nothing for the first 300 ms, so a quick read never flashes a
   * placeholder; then the bar and five placeholder rows in the real layout under a day band (a
   * status bar, title and meta bars and a time bar). After 10 s a status line says it is taking
   * longer than usual, with Cancel. Cancel stops the read and replaces the rows with "Loading
   * canceled", a neutral state that says nothing is missing and offers Try again.
   */
  import { ErrorState, Skeleton } from '@lostgradient/cinder';
  import type { Snippet } from 'svelte';

  import { RETRY_LABEL, TASK_COPY } from '../../../app/copy.ts';

  interface Props {
    /** Whether the runs are being read, or the person canceled the read. */
    kind: 'loading' | 'canceled';
    /** The filter bar as the page draws it while it has no counts. */
    bar: Snippet;
    /** Called when Cancel, in the status line a slow read shows, is pressed. */
    onCancel: () => void;
    /** Called when Try again, under "Loading canceled", is pressed. */
    onRetry: () => void;
  }

  let { kind, bar, onCancel, onRetry }: Props = $props();

  // The skeleton keeps its own time, so the filter bar waits the same delay beside it.
  let revealed = $state(false);
  $effect(() => {
    // poll-reason: timer
    const timer = setTimeout(() => {
      revealed = true;
    }, RUN_LIST_LOADING_DELAY_MILLISECONDS);
    return () => clearTimeout(timer);
  });
</script>

{#if kind === 'canceled'}
  {@render bar()}
  <ErrorState
    bordered
    tone="neutral"
    headingLevel={2}
    title={TASK_COPY.list.loadingCanceled.title}
    description={TASK_COPY.list.loadingCanceled.description}
    retryLabel={RETRY_LABEL}
    {onRetry}
  />
{:else}
  {#if revealed}
    {@render bar()}
  {/if}
  <Skeleton
    variant="list"
    rows={5}
    dayBand
    delay={RUN_LIST_LOADING_DELAY_MILLISECONDS}
    stillLoadingAfter={RUN_LIST_STILL_LOADING_MILLISECONDS}
    stillLoadingLabel={TASK_COPY.list.stillLoading}
    label={TASK_COPY.loading}
    {onCancel}
  />
{/if}
