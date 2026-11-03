<script lang="ts" module>
  export const title = 'Footer with a count';
  export const description =
    'With loadedCount and totalCount the footer reads "Showing 10 of 19" beside its button. When a load fails it keeps the rows and the count, says "Couldn’t load more runs. Showing 10 of 19.", and offers Try again.';
</script>

<script lang="ts">
  import { LoadMore } from '@lostgradient/cinder';

  const total = 19;
  let loaded = $state(10);
  let loading = $state(false);
  let attempts = $state(0);
  const hasMore = $derived(loaded < total);

  async function fetchNext() {
    loading = true;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    attempts += 1;
    loading = false;
    // The first press fails, so the retry state shows.
    if (attempts === 1) throw new Error('Temporary network failure');
    loaded = Math.min(total, loaded + 10);
  }
</script>

<ul aria-busy={loading} style="margin: 0; padding-inline-start: 1.25rem;">
  {#each Array.from({ length: loaded }, (_, index) => index + 1) as run (run)}
    <li>Run {run}</li>
  {/each}
</ul>

<LoadMore
  onLoadMore={fetchNext}
  {hasMore}
  bind:loading
  loadedCount={loaded}
  totalCount={total}
  itemLabel="runs"
/>
