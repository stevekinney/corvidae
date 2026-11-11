<script lang="ts">
  /**
   * What "Storage details" opens: five facts about where the installation keeps its state, in the
   * list of fields the key's own Value section uses: the backend, where it is, how large it is, how many keys it
   * holds, and how writes work (per key, with the managed keys locked), then where it is set up. It
   * replaces the storage capabilities, which only the one gate in this console ever read
   * (`key-detail.svelte`). A figure that cannot be read shows a dash and never zero.
   *
   * It mounts when the popover opens, so Health's other tabs do not read the key count or poll for
   * the alert until a person asks.
   */
  import { DescriptionList, Link, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { readAttention } from '../../lib/bureau-attention.ts';
  import { formatBytes } from '../../lib/format/index.ts';
  import { getHostStorageSummary } from '../../lib/host-storage.ts';
  import type { HostPaths } from '../../lib/host-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { HEALTH_FRAME_COPY } from '../health/health-copy.ts';
  import { useStorageSizes } from '../health/storage-sizes.svelte.ts';
  import { latestStorageBytes } from './storage-size.ts';
  import { storageFacts } from './storage-location.ts';

  interface Props {
    /** Where the host keeps its state, or `undefined` while it has not said. */
    paths: HostPaths | undefined;
  }

  let { paths }: Props = $props();

  const copy = HEALTH_FRAME_COPY.details;

  const summary = createQuery(() => ({
    queryKey: queryKeys.hostStorageSummary(''),
    queryFn: ({ signal }) => getHostStorageSummary('', { signal }),
    staleTime: 30_000,
    retry: false,
  }));

  // The same read, under the same key, as the Health overview's, so the two share one answer.
  const attention = createQuery(() => ({
    queryKey: queryKeys.bureauAttention.list(),
    queryFn: ({ signal }) => readAttention({ signal }),
    retry: false,
  }));
  const alertBytes = $derived.by(() => {
    const alert = attention.data?.items.find(
      (item) => item.kind === 'alert' && item.metric === 'storage.size',
    );
    return alert?.kind === 'alert' ? alert.currentValue : undefined;
  });

  const sizes = useStorageSizes();
  const bytes = $derived(
    latestStorageBytes({
      samples: sizes.samples(),
      alertBytes,
      hostBytes: summary.data?.sizeBytes,
    }),
  );
  const facts = $derived(storageFacts(paths));
  const loading = $derived(summary.isPending || attention.isPending);

  const items = $derived([
    { term: copy.backend, definition: facts.backend },
    { term: copy.location, definition: facts.location ?? copy.unknown },
    { term: copy.size, definition: bytes === undefined ? copy.unknown : formatBytes(bytes) },
    {
      term: copy.keys,
      definition:
        summary.data === undefined ? copy.unknown : summary.data.keyCount.toLocaleString('en-US'),
    },
    { term: copy.writes, definition: copy.writesPerKey },
  ]);

  function openSettings(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(copy.settingsPath);
  }
</script>

<div class="ib-storage-details" data-testid="storage-details">
  {#if loading}
    <div role="status" aria-busy="true" aria-label={copy.loading}>
      <Skeleton height="7.5rem" />
    </div>
  {:else}
    <DescriptionList {items} />
  {/if}
  <p class="ib-storage-details__footer">
    {copy.footerBefore}<Link href={router.href(copy.settingsPath)} onclick={openSettings}
      >{copy.footerLink}</Link
    >{copy.footerAfter}
  </p>
</div>

<style>
  .ib-storage-details {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    /* The popover and the sheet own the width; the list stacks a term over its value when narrow. */
    min-inline-size: 0;
  }

  /* A path is one word the width of the popover: break it anywhere rather than past its edge. */
  .ib-storage-details :global(dd) {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .ib-storage-details__footer {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
