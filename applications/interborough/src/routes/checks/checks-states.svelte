<script lang="ts" module>
  /**
   * How long a load is let to finish before anything is drawn for it, which is Cinder's loading
   * rule: a read that is quick never flashes a placeholder.
   */
  export const CHECKS_LOADING_DELAY_MILLISECONDS = 300;

  /** How long a load runs before the placeholders say it is taking longer than usual. */
  export const CHECKS_STILL_LOADING_MILLISECONDS = 10_000;
</script>

<script lang="ts">
  /**
   * `/checks` while its results have not arrived (rows C2-20): a read in progress and a read the
   * person canceled. Both sit under the page's header and its filter bar, which the page draws, so
   * this draws only what follows them.
   *
   * A read in progress draws nothing for the first 300 ms, so a quick read never flashes a
   * placeholder; then five placeholder rows in the real layout under a day band. After 10 s a status
   * line says it is taking longer than usual, with Cancel. Cancel stops the read and replaces the
   * rows with "Loading canceled", a neutral state that says nothing is missing and offers Try again.
   */
  import { ErrorState, Skeleton } from '@lostgradient/cinder';

  import { CHECKS_COPY } from '../../app/copy/checks.ts';
  import { RETRY_LABEL } from '../../app/copy/views.ts';

  interface Props {
    /** Whether the results are being read, or the person canceled the read. */
    kind: 'loading' | 'canceled';
    /** Called when Cancel, in the status line a slow read shows, is pressed. */
    onCancel: () => void;
    /** Called when Try again, under "Loading canceled", is pressed. */
    onRetry: () => void;
  }

  let { kind, onCancel, onRetry }: Props = $props();
</script>

{#if kind === 'canceled'}
  <ErrorState
    bordered
    tone="neutral"
    headingLevel={2}
    title={CHECKS_COPY.loadingCanceled.title}
    description={CHECKS_COPY.loadingCanceled.description}
    retryLabel={RETRY_LABEL}
    {onRetry}
  />
{:else}
  <Skeleton
    variant="list"
    rows={5}
    dayBand
    delay={CHECKS_LOADING_DELAY_MILLISECONDS}
    stillLoadingAfter={CHECKS_STILL_LOADING_MILLISECONDS}
    stillLoadingLabel={CHECKS_COPY.stillLoading}
    label={CHECKS_COPY.loading}
    {onCancel}
  />
{/if}
