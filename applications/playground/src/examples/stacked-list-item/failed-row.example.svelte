<script lang="ts" module>
  export const title = 'A row that fails to load';
  export const description =
    'One failing row keeps its status, title and time on line one, and its `error` puts the message on line two beside a warning glyph with its own secondary Try again button. The rest of the list stays live; there is no banner.';
</script>

<script lang="ts">
  import {
    DataList,
    StackedListItem,
    StatusDot,
    type StatusDotWordLabel,
  } from '@lostgradient/cinder';

  type Row = { id: string; title: string; status: StatusDotWordLabel; time: string };

  let attempts = $state(0);
  const rows: Row[] = [
    { id: 'refund', title: 'Refund order 4471', status: 'Waiting on you', time: '10:42 AM' },
    { id: 'hello', title: 'Say hello', status: 'Done', time: '4:12 PM' },
  ];
</script>

<DataList items={rows} key={(row) => row.id}>
  {#snippet children(row)}
    {#if row.id === 'refund'}
      <StackedListItem
        error="Couldn’t load this run’s details."
        onRetryClick={() => (attempts += 1)}
      >
        {#snippet status()}<StatusDot word={row.status} />{/snippet}
        {#snippet title()}{row.title}{/snippet}
        {#snippet time()}{row.time}{/snippet}
      </StackedListItem>
    {:else}
      <StackedListItem href={`#${row.id}`}>
        {#snippet status()}<StatusDot word={row.status} />{/snippet}
        {#snippet title()}{row.title}{/snippet}
        {#snippet time()}{row.time}{/snippet}
        {#snippet meta()}Chat · Assistant · 8 s{/snippet}
      </StackedListItem>
    {/if}
  {/snippet}
</DataList>
<p style="margin-top: 0.5rem; color: var(--cinder-text-muted);">Retries so far: {attempts}</p>
