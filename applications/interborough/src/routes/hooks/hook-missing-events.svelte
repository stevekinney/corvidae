<script lang="ts">
  /**
   * The plugin kinds a saved hook lists that are missing (COR-2226, row R5): each a Cinder row, the
   * row the chosen events take, with its name as the title, "Missing" in the row's status, and the
   * one line that says why as its line two, "Plugin not loaded" or "Pinned to 1.0.0, 1.1.0 is
   * loaded". The hook stays on and still saves; the others still fire. Nothing is drawn when no kind
   * is missing.
   */
  import { DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';

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

  const word = HOOKS_COPY.editor.event.missing.word;
</script>

{#if missing.length > 0}
  <DataList
    items={[...missing]}
    key={(entry) => entry.kind}
    class="ib-hook-missing"
    data-testid="hook-missing-events"
  >
    {#snippet children(entry)}
      {@const label = eventChosenLabel(entry.kind, titleOf)}
      {@const cause = missingEventCause(entry)}
      <StackedListItem
        class="ib-hook-missing__item"
        data-event={entry.kind}
        tooltip={label}
        metaTooltip={cause}
      >
        {#snippet status()}<StatusDot {word} size="sm" data-status-word={word} />{/snippet}
        {#snippet title()}{label}{/snippet}
        {#snippet description()}{cause}{/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
{/if}
