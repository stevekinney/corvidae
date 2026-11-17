<script lang="ts">
  import { DataTable } from '@lostgradient/data-table/components/data-table/index.ts';
  import ListDetail from '@lostgradient/list-detail/components/list-detail/list-detail.svelte';
  import type { ListDetailProps } from '@lostgradient/list-detail/components/list-detail/list-detail.types.ts';

  type Entry = { id: string; key: string; group: string };

  type FixtureProps = Partial<
    Omit<ListDetailProps<Entry>, 'items' | 'key' | 'list' | 'listBody' | 'detail'>
  >;

  const entries: Entry[] = [
    { id: 'alpha', key: 'app:alpha', group: 'App data' },
    { id: 'beta', key: 'app:beta', group: 'App data' },
    { id: 'gamma', key: 'chat:gamma', group: 'Chats' },
  ];
  const columns = [
    { key: 'key' as const, label: 'Key', monospace: true },
    { key: 'group' as const, label: 'Group' },
  ];

  let { selectedKey = $bindable(null), ...rest }: FixtureProps = $props();
</script>

<ListDetail items={entries} key={(entry) => entry.id} label="Keys" bind:selectedKey {...rest}>
  {#snippet listBody(body)}
    <DataTable
      caption="Storage keys"
      {columns}
      rows={body.items}
      getRowId={(row) => String(row['id'])}
      openRowId={body.selectedKey}
      onRowOpen={(row) => body.open(String(row['id']))}
    />
  {/snippet}
  {#snippet detail(entry)}
    <h3>{entry.key} value</h3>
  {/snippet}
</ListDetail>
