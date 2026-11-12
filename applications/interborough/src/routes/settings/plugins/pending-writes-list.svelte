<script lang="ts">
  /**
   * The other switches a plugin's confirmation writes with its own, because Restart writes every
   * switch the page holds: the plugins already switched on or off and waiting. Shown under the
   * confirmation's own words, and not at all when nothing else waits.
   */
  import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
  import type { PluginWrite } from './plugin-drafts.svelte.ts';

  interface Props {
    /** The other changes the restart writes. */
    changes: readonly PluginWrite[];
  }

  let { changes }: Props = $props();

  const copy = PLUGINS_COPY.disable;
</script>

{#if changes.length > 0}
  <div class="ib-pending-writes" data-testid="plugin-pending-writes">
    <p class="ib-pending-writes__lead">{copy.alsoWrites}</p>
    <ul class="ib-pending-writes__list">
      {#each changes as change (change.name)}
        <li class="ib-pending-writes__item" data-pending-change={change.name}>
          <strong>{change.name}</strong>
          <span>{change.enabled ? copy.alsoSwitchedOn : copy.alsoSwitchedOff}</span>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .ib-pending-writes {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
  }

  .ib-pending-writes__lead {
    margin: 0;
  }

  .ib-pending-writes__list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-pending-writes__item {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1);
    padding: var(--cinder-space-2) 0;
    border-top: 1px solid var(--cinder-border-muted);
    overflow-wrap: anywhere;
  }
</style>
