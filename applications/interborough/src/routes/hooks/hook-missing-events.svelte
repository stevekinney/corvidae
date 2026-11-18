<script lang="ts">
  /**
   * The plugin kinds a saved hook lists that are missing (COR-2226, row R5): each by its name,
   * "Missing" in Cinder's status shape, and the one line that says why, "Plugin not loaded" or
   * "Pinned to 1.0.0, 1.1.0 is loaded". The hook stays on and still saves; the others still fire.
   * Nothing is drawn when no kind is missing.
   */
  import { StatusDot } from '@lostgradient/cinder';

  import { humanizeName } from '../settings/plugins/plugin-presentation.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import { eventChosenLabel, missingEventCause } from './hook-presentation.ts';

  interface Props {
    /** The missing kinds, as the Bureau lists them on the hook. */
    missing: readonly { readonly kind: string; readonly loadedVersion: string | null }[];
    /** A plugin's title by its name; its name in words when the page has none. */
    titleOf?: (plugin: string) => string;
  }

  let { missing, titleOf = humanizeName }: Props = $props();
</script>

{#if missing.length > 0}
  <ul class="ib-hook-missing" data-testid="hook-missing-events">
    {#each missing as entry (entry.kind)}
      <li class="ib-hook-missing__item" data-event={entry.kind}>
        <span class="ib-hook-missing__line">
          <span class="ib-hook-missing__name">{eventChosenLabel(entry.kind, titleOf)}</span>
          <StatusDot word={HOOKS_COPY.editor.event.missing.word} size="sm" />
        </span>
        <span class="ib-hook-missing__cause">{missingEventCause(entry)}</span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .ib-hook-missing {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-hook-missing__item {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
  }

  .ib-hook-missing__line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    min-width: 0;
  }

  .ib-hook-missing__name {
    overflow-wrap: anywhere;
  }

  .ib-hook-missing__cause {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
</style>
