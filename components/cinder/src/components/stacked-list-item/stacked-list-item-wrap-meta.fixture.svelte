<script lang="ts">
  import { DataList } from '../data-list/index.ts';
  import { StatusDot } from '../status-dot/index.ts';
  import { StackedListItem } from './index.ts';

  const rows = [
    {
      id: 'attempt-5',
      title: 'Attempt 5',
      line: 'Assistant, took 6 s, the notes didn’t mention the staging fix the release depends on',
    },
  ];
</script>

<!-- A goal attempt's row at a phone's 320px: `wrapMeta` makes line two one run of text (the dot,
     the word, then the meta), so its wrapped line starts at the row's text edge, not in a narrow
     column beside the word. -->
<div class="stacked-list-item-wrap-meta-fixture" data-testid="wrap-meta">
  <DataList items={rows} key={(row) => row.id}>
    {#snippet children(row)}
      <StackedListItem href="#attempt" wrapMeta metaTooltip={row.line}>
        {#snippet status()}<StatusDot word="Check not met" size="sm" />{/snippet}
        {#snippet title()}{row.title}{/snippet}
        {#snippet time()}8:21 AM{/snippet}
        {#snippet meta()}{row.line}{/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
</div>

<style>
  .stacked-list-item-wrap-meta-fixture {
    inline-size: 20rem;
  }
</style>
