<script lang="ts">
  import { DataList, StackedListItem } from '@corvidae/cinder';

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
