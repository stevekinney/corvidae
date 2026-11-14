<script lang="ts">
  /**
   * The other switches a plugin's confirmation writes with its own, because Restart writes every
   * switch the page holds: the plugins already switched on or off and waiting. Shown under the
   * confirmation's own words, and not at all when nothing else waits. It renders a lead and a list
   * with no wrapper, so the dialog's options draw them with Cinder's list and note treatment.
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
  <p data-testid="plugin-pending-writes">{copy.alsoWrites}</p>
  <ul>
    {#each changes as change (change.name)}
      <li data-pending-change={change.name}>
        <strong>{change.name}</strong>
        {change.enabled ? copy.alsoSwitchedOn : copy.alsoSwitchedOff}
      </li>
    {/each}
  </ul>
{/if}
