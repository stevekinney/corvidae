<script lang="ts" module>
  export const title = 'Selected row';
  export const description =
    'selected marks the row open in the detail beside the list. It takes an accent tint that stays under the pointer, and sets aria-current on the row link.';
</script>

<script lang="ts">
  import { DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';

  const workers = [
    {
      id: 'reports',
      name: 'Reports worker',
      status: 'Disconnected' as const,
      heard: '1 h ago',
      meta: 'reports queue',
    },
    {
      id: 'payments',
      name: 'Payments worker 1',
      status: 'Connected' as const,
      heard: 'just now',
      meta: 'payments · 3 running',
    },
  ];
</script>

<DataList items={workers} key={(worker) => worker.id} statusColumn>
  {#snippet children(worker)}
    <StackedListItem
      href={`#${worker.id}`}
      selected={worker.id === 'reports'}
      tooltip={worker.name}
    >
      {#snippet status()}<StatusDot word={worker.status} />{/snippet}
      {#snippet title()}{worker.name}{/snippet}
      {#snippet time()}{worker.heard}{/snippet}
      {#snippet meta()}{worker.meta}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
