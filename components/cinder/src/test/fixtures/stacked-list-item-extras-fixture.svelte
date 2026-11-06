<script lang="ts" module>
  /**
   * Test-only fixture: a StackedListItem that is a collapsed group row (`details`), or carries
   * trailing `actions`, so the disclosure and the phone menu can be asserted through the real
   * component.
   */
  import type { StackedListItemAction } from '../../components/stacked-list-item/stacked-list-item.types.ts';

  export type StackedListItemExtrasFixtureProps = {
    mode: 'group' | 'actions';
    actions?: StackedListItemAction[];
    expanded?: boolean;
    /** What the actions become on a phone; the component's own default when omitted. */
    phoneActions?: 'menu' | 'buttons';
  };
</script>

<script lang="ts">
  import StackedListItem from '../../components/stacked-list-item/stacked-list-item.svelte';
  import StatusDot from '../../components/status-dot/status-dot.svelte';

  let {
    mode,
    actions = [],
    expanded = $bindable(false),
    phoneActions,
  }: StackedListItemExtrasFixtureProps = $props();
</script>

<ul role="list">
  {#if mode === 'group'}
    <StackedListItem bind:expanded href="/ignored">
      {#snippet status()}<StatusDot word="Missed runs · 4" />{/snippet}
      {#snippet title()}Daily summary missed 4 times since Oct 30{/snippet}
      {#snippet meta()}Schedule · Assistant{/snippet}
      {#snippet details()}<div data-testid="missed">Mon, Nov 2 · 3:00 AM</div>{/snippet}
    </StackedListItem>
  {:else}
    <StackedListItem {actions} {...phoneActions === undefined ? {} : { phoneActions }}>
      {#snippet title()}Assistant{/snippet}
    </StackedListItem>
  {/if}
</ul>
