<script lang="ts">
  /**
   * The storage line under the page's title: which backend the installation keeps its state in
   * (SQLite, or Postgres and S3) and where, and, from that line, a popover with the six facts the
   * storage reports about itself (`capabilities-panel.svelte`). The backend comes from the host
   * (`/host/paths`); when the host cannot say, the line says only that this is storage.
   */
  import { Popover } from '@lostgradient/cinder';
  import type { StorageCapabilities } from '@lostgradient/storage';
  import { ChevronDown } from '@lucide/svelte';

  import { STORAGE_COPY } from '../../app/copy.ts';
  import type { HostPaths } from '../../lib/host-paths.ts';
  import CapabilitiesPanel from './capabilities-panel.svelte';

  interface Props {
    paths: HostPaths | undefined;
    capabilities: StorageCapabilities | undefined;
    loading: boolean;
    error: unknown;
    onRetry?: (() => void) | undefined;
  }

  let { paths, capabilities, loading, error, onRetry = undefined }: Props = $props();

  const copy = STORAGE_COPY.backend;
  let open = $state(false);

  const line = $derived.by(() => {
    if (paths === undefined) return copy.unknown;
    return paths.database.kind === 'sqlite'
      ? copy.line(copy.sqlite, paths.database.path)
      : copy.line(copy.postgres, paths.database.location);
  });
</script>

<div class="ib-storage-backend" data-testid="storage-backend">
  <Popover bind:open label={copy.popoverLabel} placement="bottom-start">
    {#snippet trigger()}
      <!-- A plain button, not Cinder's: a database path is one long word, and this one wraps it. -->
      <button
        type="button"
        class="ib-storage-backend__trigger"
        aria-label={`${line}. ${copy.popoverHint}`}
        onclick={() => (open = !open)}
      >
        <span class="ib-storage-backend__line">{line}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
    {/snippet}
    <div class="ib-storage-backend__facts">
      <CapabilitiesPanel {capabilities} {loading} {error} {onRetry} />
    </div>
  </Popover>
</div>

<style>
  .ib-storage-backend {
    display: flex;
    min-width: 0;
    max-inline-size: 100%;
  }

  .ib-storage-backend__trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    max-inline-size: 100%;
    padding: var(--cinder-space-1) var(--cinder-space-2);
    color: var(--cinder-text-muted);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    text-align: start;
    background: transparent;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    cursor: pointer;
  }

  .ib-storage-backend__line {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .ib-storage-backend__facts {
    min-inline-size: 16rem;
    max-inline-size: min(26rem, 80vw);
  }
</style>
