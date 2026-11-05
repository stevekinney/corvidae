<script lang="ts">
  /**
   * The head every state of the Workers page shares (rows 78c, 78x, 78z, 78h): the heading
   * "Workers" and, under it, one line in muted text, which is the summary of what runs (never stat
   * cards) or, while the workers are being read, "Loading workers…". Both are real text from the
   * first paint. The list pane, the empty state, the loading state and the failed state all draw it
   * here, so they cannot say the heading two ways.
   */
  import { WORKER_COPY } from './worker-copy.ts';

  interface Props {
    /** The line under the heading; none draws the heading alone, as the failed state does. */
    readonly line?: string | undefined;
    /** What the line is for tests: the summary of what runs, or `workers-loading-line` while the read is pending. */
    readonly lineTestId?: string;
  }

  let { line, lineTestId = 'workers-summary' }: Props = $props();
</script>

<div class="ib-workers-heading">
  <h2 class="ib-workers-heading__title">{WORKER_COPY.list.title}</h2>
  {#if line !== undefined}
    <p class="weft-workers-frame__summary" data-testid={lineTestId}>{line}</p>
  {/if}
</div>

<style>
  .ib-workers-heading {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
  }

  .ib-workers-heading__title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }
</style>
