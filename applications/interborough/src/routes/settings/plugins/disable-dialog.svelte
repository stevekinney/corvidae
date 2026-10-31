<script lang="ts">
  /**
   * The question before a plugin is turned off: Interborough restarts to unload it, so the dialog
   * lists what depends on it now, from the counts the host reports for each thing the plugin adds
   * (`disableImpacts`). Confirming writes the choice and restarts in one step; Cancel changes nothing.
   */
  import { Button, Modal } from '@lostgradient/cinder';

  import { PLUGINS_COPY } from '../../../app/copy.ts';
  import type { PluginStanding } from '../../../lib/host-plugins.ts';
  import { disableImpacts } from './plugin-presentation.ts';

  interface Props {
    /** The plugin the question is about, or `null` while it is closed. */
    plugin: PluginStanding | null;
    /** The other changes the restart writes with this one. */
    otherChanges: readonly {
      readonly name: string;
      readonly enabled: boolean | undefined;
      readonly configuration: boolean;
    }[];
    /** Whether configuration text the page holds cannot be applied, so nothing can be written yet. */
    invalid: boolean;
    onConfirm: (plugin: PluginStanding) => void;
    onCancel: () => void;
  }

  let { plugin, otherChanges, invalid, onConfirm, onCancel }: Props = $props();

  const copy = PLUGINS_COPY.disable;
  const impacts = $derived(plugin === null ? [] : disableImpacts(plugin));
</script>

{#if plugin !== null}
  <Modal open title={copy.title(plugin.descriptor.name)} onDismiss={onCancel}>
    {#snippet children()}
      <div class="ib-disable">
        {#if impacts.length === 0}
          <p class="ib-disable__lead">{copy.nothing}</p>
        {:else}
          <p class="ib-disable__lead">{copy.intro}</p>
          <ul class="ib-disable__list">
            {#each impacts as impact (impact.key)}
              <li class="ib-disable__item" data-impact={impact.key}>
                <strong>{impact.count}</strong>
                <span>{impact.sentence}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if otherChanges.length > 0}
          <p class="ib-disable__lead">{copy.alsoWrites}</p>
          <ul class="ib-disable__list">
            {#each otherChanges as change (change.name)}
              <li class="ib-disable__item" data-pending-change={change.name}>
                <strong>{change.name}</strong>
                <span
                  >{[
                    change.enabled === undefined
                      ? ''
                      : change.enabled
                        ? copy.alsoSwitchedOn
                        : copy.alsoSwitchedOff,
                    change.configuration ? copy.alsoConfiguration : '',
                  ]
                    .filter((part) => part !== '')
                    .join(', ')}</span
                >
              </li>
            {/each}
          </ul>
        {/if}
        {#if invalid}
          <p class="ib-disable__note">{PLUGINS_COPY.banner.invalid}</p>
        {/if}
        <p class="ib-disable__note">{copy.reassurance}</p>
      </div>
    {/snippet}
    {#snippet footer()}
      <Button variant="secondary" onclick={onCancel}>{copy.cancel}</Button>
      <Button data-changes variant="danger" disabled={invalid} onclick={() => onConfirm(plugin)}
        >{copy.confirm}</Button
      >
    {/snippet}
  </Modal>
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
