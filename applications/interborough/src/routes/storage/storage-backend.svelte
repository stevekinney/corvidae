<script lang="ts">
  /**
   * The storage line under Health's heading, the same on every tab: which backend the installation
   * keeps its state in and where ("Running on SQLite in ~/.interborough"), then "Storage details"
   * as a link-styled button that opens the storage's five facts (`storage-details.svelte`), its
   * chevron turned up while they are open. The backend comes from the host (`/host/paths`); when the
   * host cannot say, the line says only that this is storage. The line does not count keys: the
   * count is in the popover and the table's footer.
   */
  import { Button, Popover } from '@lostgradient/cinder';
  import { ChevronDown, ChevronUp } from '@lucide/svelte';

  import type { HostPaths } from '../../lib/host-paths.ts';
  import { HEALTH_FRAME_COPY } from '../health/health-copy.ts';
  import StorageDetails from './storage-details.svelte';
  import { runningOnLine } from './storage-location.ts';

  interface Props {
    paths: HostPaths | undefined;
  }

  let { paths }: Props = $props();

  let open = $state(false);
  const line = $derived(runningOnLine(paths));
</script>

<span class="ib-storage-backend" data-testid="storage-backend">
  <span class="ib-storage-backend__line">{line}</span>
  <span class="ib-storage-backend__details">
    <span class="ib-storage-backend__separator" aria-hidden="true">·</span>
    <Popover bind:open label={HEALTH_FRAME_COPY.popoverLabel} placement="bottom-start">
      {#snippet trigger()}
        {#snippet chevron()}
          {#if open}<ChevronUp aria-hidden="true" size={12} />{:else}<ChevronDown
              aria-hidden="true"
              size={12}
            />{/if}
        {/snippet}
        <Button
          variant="link"
          size="sm"
          label={HEALTH_FRAME_COPY.storageDetails}
          trailingIcon={chevron}
          aria-expanded={open}
          onclick={() => (open = !open)}
        />
      {/snippet}
      <StorageDetails {paths} />
    </Popover>
  </span>
</span>

<style>
  .ib-storage-backend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 var(--cinder-space-2);
    min-width: 0;
    max-inline-size: 100%;
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-md);
  }

  .ib-storage-backend__line {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* The separator wraps with the button, so a long path never strands a "·" at the start of a line. */
  .ib-storage-backend__details {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-2);
    white-space: nowrap;
  }
</style>
