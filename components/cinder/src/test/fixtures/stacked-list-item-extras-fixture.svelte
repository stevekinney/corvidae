<script lang="ts" module>
  /**
   * Test-only fixture: a StackedListItem that is a collapsed group row (`details`), carries
   * trailing `actions`, or has a third line (`detail`), so the disclosure, the phone menu and the third line can be asserted through the real
   * component.
   */
  import type { StackedListItemAction } from '../../components/stacked-list-item/stacked-list-item.types.ts';

  export type StackedListItemExtrasFixtureProps = {
    mode: 'group' | 'actions' | 'detail';
    actions?: StackedListItemAction[];
    expanded?: boolean;
  };
</script>

<script lang="ts">
  import StackedListItem from '../../components/stacked-list-item/stacked-list-item.svelte';
  import StatusDot from '../../components/status-dot/status-dot.svelte';

  let {
    mode,
    actions = [],
    expanded = $bindable(false),
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
  {:else if mode === 'detail'}
    <StackedListItem href="/schedules/refunds">
      {#snippet status()}<StatusDot word="Active" />{/snippet}
      {#snippet title()}Weekly refund audit{/snippet}
      {#snippet time()}Next today 11:00 AM{/snippet}
      {#snippet meta()}Workflow · Order refund · Tool runner{/snippet}
      {#snippet detail()}<span data-testid="detail"
          >Order refund can’t load · won’t run until a provider is connected · Mondays at 11:00 AM</span
        >{/snippet}
    </StackedListItem>
  {:else}
    <StackedListItem {actions}>
      {#snippet title()}Assistant{/snippet}
    </StackedListItem>
  {/if}
</ul>
