<script lang="ts">
  /**
   * What a tab of Capabilities shows while its list has not arrived (design rows 32f, 32t): nothing
   * for 300 ms, then three skeleton rows in the list's place and a skeleton title with two lines in
   * the detail pane's, then after 10 seconds Cinder's own "still loading" line. The timing belongs
   * to the one `Skeleton`; the placeholders inside it are plain blocks.
   */
  import { Skeleton } from '@lostgradient/cinder';

  interface Props {
    /** The accessible name of the loading region ("Loading tools"). */
    label: string;
  }

  let { label }: Props = $props();

  const ROWS = [0, 1, 2] as const;
</script>

<div data-testid="capabilities-loading">
  <Skeleton delay={300} stillLoadingAfter={10_000} {label}>
    <div class="ib-capabilities__loading" aria-hidden="true">
      <div class="ib-capabilities__loading-list">
        {#each ROWS as row (row)}
          <div class="ib-capabilities__loading-row">
            <Skeleton height="1rem" width="45%" />
            <Skeleton height="0.875rem" width="85%" />
          </div>
        {/each}
      </div>
      <div class="ib-capabilities__loading-detail">
        <Skeleton height="1.5rem" width="40%" />
        <Skeleton height="0.875rem" width="90%" />
        <Skeleton height="0.875rem" width="70%" />
      </div>
    </div>
  </Skeleton>
</div>
