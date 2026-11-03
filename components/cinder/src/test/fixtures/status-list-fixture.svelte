<script lang="ts" module>
  /**
   * Test-only fixture: a DataList of status-first StackedListItem rows, optionally grouped by day
   * and optionally announcing inserted rows, so the status column, the group headers and the live
   * insertion can be asserted through the real components.
   */
  import type { StatusDotWordLabel } from '../../components/status-dot/status-dot.words.ts';

  export type StatusListRow = {
    id: string;
    title: string;
    day: string;
    status?: StatusDotWordLabel;
    time?: string;
    meta?: string;
    href?: string;
  };

  export type StatusListFixtureProps = {
    rows: StatusListRow[];
    statusColumn?: boolean;
    grouped?: boolean;
    announce?: boolean;
    placement?: 'leading' | 'line-two';
  };
</script>

<script lang="ts">
  import DataList from '../../components/data-list/data-list.svelte';
  import StackedListItem from '../../components/stacked-list-item/stacked-list-item.svelte';
  import StatusDot from '../../components/status-dot/status-dot.svelte';

  let {
    rows,
    statusColumn = false,
    grouped = false,
    announce = false,
    placement = 'leading',
  }: StatusListFixtureProps = $props();
</script>

<DataList
  items={rows}
  key={(row) => row.id}
  {...statusColumn ? { statusColumn: true } : {}}
  {...grouped
    ? {
        groupBy: (row: StatusListRow) => ({ key: row.day, label: row.day, detail: 'Central time' }),
      }
    : {}}
  {...announce
    ? { insertionAnnouncement: (count: number) => `${count} new run${count === 1 ? '' : 's'}` }
    : {}}
>
  {#snippet children(row)}
    {#if row.status}
      <StackedListItem
        statusPlacement={placement}
        {...row.href ? { href: row.href } : {}}
        tooltip={row.title}
      >
        {#snippet status()}<StatusDot {...row.status ? { word: row.status } : {}} />{/snippet}
        {#snippet title()}{row.title}{/snippet}
        {#snippet time()}{row.time ?? ''}{/snippet}
        {#snippet meta()}{row.meta ?? ''}{/snippet}
      </StackedListItem>
    {:else}
      <StackedListItem
        statusPlacement={placement}
        {...row.href ? { href: row.href } : {}}
        tooltip={row.title}
      >
        {#snippet title()}{row.title}{/snippet}
        {#snippet time()}{row.time ?? ''}{/snippet}
        {#snippet meta()}{row.meta ?? ''}{/snippet}
      </StackedListItem>
    {/if}
  {/snippet}
</DataList>
