<script lang="ts">
  import { default as DataList } from '@lostgradient/data-list/components/data-list/index.ts';
  import { default as StackedListItem } from '@lostgradient/data-list/components/stacked-list-item/index.ts';

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
