<script lang="ts">
  /**
   * The Storage section's one row, "Space used" (board PageSettingsSections, "Data and retention";
   * row 50g). It is read-only and draws no meter, capacity or warning level. While an alert rule
   * on the storage size is firing it reads "Storage is over its warning level · 1.6 GB" with an
   * amber dot, and says that Health lists it; with no such rule it reads the plain size, with no
   * dot. The firing alert is Health's (`bureau.health.attention`), and the plain size is the
   * host's (`/host/storage`).
   */
  import { Link, SettingRow, StatusDot } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { DATA_RETENTION_COPY } from '../../../app/copy.ts';
  import { listAttentionAlerts } from '../../../lib/bureau-attention.ts';
  import { formatBytes } from '../../../lib/format/index.ts';
  import { getHostStorage } from '../../../lib/host-storage.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';

  const copy = DATA_RETENTION_COPY.storage;

  // A caller the Bureau refuses the list to has no alert to show; the plain size stands in.
  const alerts = createQuery(
    () => ({
      queryKey: queryKeys.bureauAttention.alerts(),
      queryFn: ({ signal }) => listAttentionAlerts({ signal }),
      retry: false,
    }),
    undefined,
  );
  const storage = createQuery(
    () => ({
      queryKey: queryKeys.hostStorage(),
      queryFn: ({ signal }) => getHostStorage({ signal }),
      retry: false,
    }),
    undefined,
  );

  const firing = $derived(alerts.data?.find((alert) => alert.metric === 'storage.size'));
  const plainSize = $derived(
    storage.data?.sizeBytes === null || storage.data?.sizeBytes === undefined
      ? undefined
      : formatBytes(storage.data.sizeBytes),
  );

  function openHealth(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate('/health');
  }
</script>

<div class="ib-storage-usage" data-setting="storage-usage" data-alert={firing ? 'firing' : 'none'}>
  <SettingRow
    id="ib-storage-usage"
    label={copy.label}
    description={firing ? copy.firingDescription : copy.description}
    {...firing ? { descriptionAction: openHealthLink } : {}}
  >
    {#snippet control()}
      {#if firing}
        <StatusDot
          status="warning"
          wordTone="status"
          label={copy.overWarning(formatBytes(firing.currentValue))}
        />
      {:else}
        <span id="ib-storage-usage" class="ib-storage-usage__size" data-testid="storage-size"
          >{plainSize ?? copy.notReported}</span
        >
      {/if}
    {/snippet}
  </SettingRow>
</div>

{#snippet openHealthLink()}
  <Link href={router.href('/health')} onclick={openHealth}>{copy.openHealth}</Link>
{/snippet}

<style>
  .ib-storage-usage {
    min-inline-size: 0;
  }

  .ib-storage-usage__size {
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }
</style>
