<script lang="ts">
  /**
   * The storage line under Health's heading, the same on every tab: which backend the installation
   * keeps its state in, in plain words and nothing else ("Running on SQLite"), then "Storage details"
   * as a link-styled button that opens the storage's facts (`storage-details.svelte`), its chevron
   * turned up while they are open. Where the state lives is a path, and a path is never in a header
   * (owner, 2026-11-19): the full location is in Storage details, selectable, with a Copy button.
   * The words and the button sit side by side and wrap as two whole pieces; nothing overlays the
   * words (the button was pulled back over a path cut short). The backend comes from the host
   * (`/host/paths`); when the host cannot say, the line says only that this is storage.
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
    <Popover bind:open label={HEALTH_FRAME_COPY.popoverLabel} placement="bottom-start">
      {#snippet trigger()}
        {#snippet chevron()}
          {#if open}<ChevronUp aria-hidden="true" size={12} />{:else}<ChevronDown
              aria-hidden="true"
              size={12}
            />{/if}
        {/snippet}
        <Button
          variant="ghost-accent"
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
    gap: var(--cinder-space-1) var(--cinder-space-2);
    min-width: 0;
    max-inline-size: 100%;
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-md);
  }

  /* The words and the button are two whole pieces in one wrapping row: neither shrinks under the
     other, and no margin pulls one over the other. */
  .ib-storage-backend__line,
  .ib-storage-backend__details {
    flex: none;
  }

  .ib-storage-backend__details {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
  }
</style>
