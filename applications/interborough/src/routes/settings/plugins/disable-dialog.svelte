<script lang="ts">
  /**
   * The question before a plugin is turned off (board PageSettingsSections, "Disabling a plugin"):
   * a Cinder confirm dialog. Interborough restarts to unload the plugin, so it lists what depends on
   * it now, from the counts the host reports for each thing the plugin adds (`disableImpacts`), or
   * says that nothing does. Confirming writes the choice and restarts in one step through the shared
   * restart flow; Cancel changes nothing.
   */
  import { ConfirmDialog } from '@lostgradient/cinder';

  import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
  import type { PluginStanding } from '../../../lib/host-plugins.ts';
  import PendingWritesList from './pending-writes-list.svelte';
  import type { PluginWrite } from './plugin-drafts.svelte.ts';
  import { disableImpacts } from './plugin-presentation.ts';

  interface Props {
    /** The plugin the question is about, or `null` while it is closed. */
    plugin: PluginStanding | null;
    /** The other changes the restart writes with this one. */
    otherChanges: readonly PluginWrite[];
    onConfirm: (plugin: PluginStanding) => void;
    onCancel: () => void;
  }

  let { plugin, otherChanges, onConfirm, onCancel }: Props = $props();

  const copy = PLUGINS_COPY.disable;
  // The plugin stays named while the dialog leaves, after the page has let go of it.
  let last = $state<PluginStanding | null>(null);
  $effect(() => {
    if (plugin !== null) last = plugin;
  });
  const shown = $derived(plugin ?? last);
  const impacts = $derived(shown === null ? [] : disableImpacts(shown));

  function confirm(): void {
    if (plugin !== null) onConfirm(plugin);
  }
</script>

{#if shown !== null}
  <ConfirmDialog
    open={plugin !== null}
    title={copy.title(shown.descriptor.title)}
    description={copy.intro}
    cancelLabel={copy.cancel}
    confirmLabel={copy.confirm}
    onConfirm={confirm}
    {onCancel}
  >
    {#snippet options()}
      <div class="ib-disable">
        {#if impacts.length === 0}
          <p class="ib-disable__lead" data-testid="plugin-disable-nothing">
            <strong>{copy.nothingLead}</strong>{copy.nothing(shown.descriptor.title)}
          </p>
        {:else}
          <ul class="ib-disable__list">
            {#each impacts as impact (impact.key)}
              <li class="ib-disable__item" data-impact={impact.key}>
                <strong>{impact.count}</strong>
                <span>{impact.sentence}</span>
              </li>
            {/each}
          </ul>
        {/if}
        <PendingWritesList changes={otherChanges} />
        <p class="ib-disable__note">{copy.reassurance}</p>
      </div>
    {/snippet}
  </ConfirmDialog>
{/if}

<style>
  .ib-disable {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-disable__lead,
  .ib-disable__note {
    margin: 0;
  }

  .ib-disable__note {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-disable__list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-disable__item {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1);
    padding: var(--cinder-space-2) 0;
    border-top: 1px solid var(--cinder-border-muted);
    overflow-wrap: anywhere;
  }
</style>
