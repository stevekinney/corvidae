<script lang="ts">
  /**
   * The storage line under Health's heading, the same on every tab: which backend the installation
   * keeps its state in and where ("Running on SQLite in ~/.interborough"), then "Storage details"
   * as a link-styled button that opens what the storage can do (`capabilities-panel.svelte`). The
   * backend comes from the host (`/host/paths`); when the host cannot say, the line says only that
   * this is storage. The line does not count keys: the count is in the popover and the table's
   * footer. Reading what the storage can do needs `storage:admin`, so without it the line is plain
   * text.
   */
  import { Button, Popover } from '@lostgradient/cinder';
  import type { StorageCapabilities } from '@lostgradient/storage';
  import { ChevronDown } from '@lucide/svelte';

  import type { HostPaths } from '../../lib/host-paths.ts';
  import { HEALTH_FRAME_COPY } from '../health/health-copy.ts';
  import CapabilitiesPanel from './capabilities-panel.svelte';
  import { runningOnLine } from './storage-location.ts';

  interface Props {
    paths: HostPaths | undefined;
    capabilities: StorageCapabilities | undefined;
    loading: boolean;
    error: unknown;
    /** Whether the caller may read what the storage can do; without it there is no popover. */
    canInspect?: boolean;
    onRetry?: (() => void) | undefined;
  }

  let {
    paths,
    capabilities,
    loading,
    error,
    canInspect = true,
    onRetry = undefined,
  }: Props = $props();

  let open = $state(false);
  const line = $derived(runningOnLine(paths));
</script>

<span class="ib-storage-backend" data-testid="storage-backend">
  <span class="ib-storage-backend__line">{line}</span>
  {#if canInspect}
    <span class="ib-storage-backend__details">
      <span class="ib-storage-backend__separator" aria-hidden="true">·</span>
      <Popover bind:open label={HEALTH_FRAME_COPY.popoverLabel} placement="bottom-start">
        {#snippet trigger()}
          {#snippet chevron()}<ChevronDown aria-hidden="true" size={12} />{/snippet}
          <Button
            variant="link"
            size="sm"
            label={HEALTH_FRAME_COPY.storageDetails}
            trailingIcon={chevron}
            aria-expanded={open}
            onclick={() => (open = !open)}
          />
        {/snippet}
        <div class="ib-storage-backend__facts">
          <CapabilitiesPanel {capabilities} {loading} {error} {onRetry} />
        </div>
      </Popover>
    </span>
  {/if}
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

  .ib-storage-backend__facts {
    min-inline-size: 16rem;
    max-inline-size: min(26rem, 80vw);
  }
</style>
