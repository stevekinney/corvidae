<script lang="ts">
  import { default as DataList } from '@lostgradient/data-list/components/data-list/index.ts';
  import { default as StackedListItem } from '@lostgradient/data-list/components/stacked-list-item/index.ts';

  const members = [
    { id: 'alice', name: 'Alice Chen', role: 'Engineer', status: 'Active' },
    { id: 'bob', name: 'Bob Osei', role: 'Designer', status: 'Active' },
    { id: 'carol', name: 'Carol Mwangi', role: 'Product', status: 'Invited' },
  ];
</script>

<DataList items={members} key={(m) => m.id}>
  {#snippet children(member)}
    <StackedListItem>
      {#snippet title()}{member.name}{/snippet}
      {#snippet meta()}{member.role} · {member.status}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
