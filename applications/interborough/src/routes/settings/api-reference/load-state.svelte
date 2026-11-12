<script lang="ts">
  /**
   * What a panel of Settings › API reference shows while it has nothing to show (board
   * PageSettingsSections, "API reference loading" and "failing to load"): skeleton rows after 300 ms
   * that, after 10 s, say it is slow and offer a ghost Cancel; and, when the read failed, the error
   * with Try again. A canceled read says so and offers Try again. The tab row around it stays live.
   */
  import { Banner, Button, Skeleton } from '@lostgradient/cinder';

  import { API_REFERENCE_COPY } from '../../../app/copy/api-reference.ts';

  interface Props {
    /** What the panel has: a read in flight, a read that failed, or a read the person gave up on. */
    kind: 'loading' | 'error' | 'canceled';
    /** The HTTP status the server answered a failed read with, if it answered. */
    status?: number | undefined;
    /** Gives up on a read that is taking longer than usual. */
    onCancel: () => void;
    /** Reads again. */
    onRetry: () => void;
  }

  let { kind, status, onCancel, onRetry }: Props = $props();

  const copy = API_REFERENCE_COPY;
</script>

{#if kind === 'error'}
  <Banner
    variant="danger"
    dismissible={false}
    title={copy.loadFailed.title}
    data-testid="api-reference-load-failed"
  >
    {copy.loadFailed.description(status)}
    {#snippet actions()}
      <Button variant="secondary" size="sm" onclick={onRetry}>{copy.loading.tryAgain}</Button>
    {/snippet}
  </Banner>
{:else if kind === 'canceled'}
  <div data-testid="api-reference-canceled">
    <p>{copy.loading.canceled}</p>
    <Button variant="secondary" size="sm" onclick={onRetry}>{copy.loading.tryAgain}</Button>
  </div>
{:else}
  <Skeleton
    variant="card"
    lines={4}
    delay={300}
    stillLoadingAfter={10_000}
    stillLoadingLabel={copy.loading.stillLoading}
    label={copy.loading.label}
    {onCancel}
  />
{/if}
