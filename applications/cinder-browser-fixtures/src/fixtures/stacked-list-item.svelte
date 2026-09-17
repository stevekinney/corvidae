<script lang="ts">
  import { DataList, StackedListItem } from '@repo/cinder';

  const docs = [
    { id: 'getting-started', name: 'Getting started', href: '#getting-started' },
    { id: 'theming', name: 'Theming', href: '#theming' },
    { id: 'accessibility', name: 'Accessibility', href: '#accessibility' },
  ];
</script>

<DataList items={docs} key={(doc) => doc.id}>
  {#snippet children(doc)}
    <StackedListItem href={doc.href}>
      {#snippet title()}{doc.name}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
