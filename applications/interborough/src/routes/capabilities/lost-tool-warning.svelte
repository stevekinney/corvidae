<script lang="ts">
  /**
   * The warning row under a tool's chips when the tool cannot run (board SchemaAndJson, frames "g A
   * tool whose source is disconnected" and "h A tool whose plugin is disabled", COR-2435): one
   * warning-tone sentence with its one action at the inline end. A source's tool offers Reconnect,
   * which opens the source on the Sources tab, where it is tested or signed in to. A plugin's tool
   * offers Enable and restart, which asks first with the shared restart question (it names the
   * effect on running work), then turns the plugin on and restarts the host through the shared
   * restart flow, whose dialog shows the restart.
   */
  import { Button, Callout } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy } from 'svelte';

  import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
  import RestartConfirmDialog from '../../app/restart/restart-confirm-dialog.svelte';
  import RestartDialog from '../../app/restart/restart-dialog.svelte';
  import { showToast } from '../../app/toast-host.svelte';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { RestartFlow } from '../settings/plugins/restart-flow.svelte.ts';
  import { lostToolWarning, type LostCause } from './capability-presentation.ts';

  interface Props {
    cause: LostCause;
  }

  let { cause }: Props = $props();

  const copy = CAPABILITIES_COPY.tool.lost;
  const queryClient = useQueryClient();

  const restart = new RestartFlow();
  onDestroy(() => restart.dispose());
  let confirming = $state(false);

  // Once the host is back, everything the page read before the restart is read again.
  $effect(() => {
    if (restart.phase !== 'back') return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.catalog() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
  });

  $effect(() => {
    if (restart.refusal === undefined) return;
    showToast(copy.enableFailed, { variant: 'danger' });
  });

  const sourcePath = $derived(
    cause.kind === 'source'
      ? `/capabilities?tab=sources&source=${encodeURIComponent(cause.id)}`
      : '/capabilities',
  );

  function enable(): void {
    if (cause.kind !== 'plugin') return;
    void restart.run([{ name: cause.name, enabled: true }], false, { changes: [cause.title] });
  }
</script>

<Callout variant="warning" semantic="note" data-testid="tool-lost">
  <span data-testid="tool-lost-text">{lostToolWarning(cause)}</span>
  {#snippet action()}
    {#if cause.kind === 'source'}
      <Button
        variant="secondary"
        size="sm"
        href={router.href(sourcePath)}
        data-testid="tool-lost-reconnect"
        label={copy.reconnect}
      />
    {:else}
      <Button
        data-changes
        variant="secondary"
        size="sm"
        loading={restart.running}
        onclick={() => (confirming = true)}
        data-testid="tool-lost-enable"
        label={copy.enable}
      />
    {/if}
  {/snippet}
</Callout>

{#if cause.kind === 'plugin'}
  <RestartConfirmDialog bind:open={confirming} changes={1} onConfirm={enable} />
  <RestartDialog flow={restart} />
{/if}
