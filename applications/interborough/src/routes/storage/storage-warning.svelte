<script lang="ts">
  /**
   * The warning at the top of Health › Storage while a storage alert is firing: "Storage is over its
   * warning level, 1.6 GB." with a link to change retention. It states what was measured and no
   * capacity or threshold, because none is configured. It is the Bureau's own attention list
   * (`bureau.health.attention`), so a fresh installation, which has no storage rule, shows nothing,
   * and neither does a caller the Bureau refuses.
   */
  import { Banner, Link } from '@lostgradient/cinder';
  import { Database } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { readAttention } from '../../lib/bureau-attention.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { HEALTH_ATTENTION_COPY } from '../health/health-copy.ts';

  const RETENTION_PATH = '/settings/data-and-retention';

  // The same read, under the same key, as the Health overview's, so the two share one answer.
  const attention = createQuery(() => ({
    queryKey: queryKeys.bureauAttention.list(),
    queryFn: ({ signal }) => readAttention({ signal }),
    // poll-reason: timer
    refetchInterval: 30_000,
    retry: false,
  }));

  const alert = $derived(
    attention.data?.items.find((item) => item.kind === 'alert' && item.metric === 'storage.size'),
  );

  function open(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(RETENTION_PATH);
  }
</script>

{#if alert?.kind === 'alert'}
  <Banner variant="warning" dismissible={false} data-testid="storage-warning">
    {#snippet icon()}<Database aria-hidden="true" size={16} />{/snippet}
    {HEALTH_ATTENTION_COPY.storage.title(alert.currentValue)}.
    {#snippet actions()}
      <Link href={router.href(RETENTION_PATH)} onclick={open}
        >{HEALTH_ATTENTION_COPY.storage.retention}</Link
      >
    {/snippet}
  </Banner>
{/if}
