<script lang="ts">
  import { default as DescriptionList } from '@lostgradient/description-list/components/description-list/index.ts';
  import { type DescriptionListItem } from '@lostgradient/description-list/components/description-list/index.ts';

  const items: DescriptionListItem[] = [
    { term: 'Component', definition: 'DescriptionList' },
    { term: 'Status', definition: 'Stable' },
    { term: 'Version', definition: '1.0.0' },
    { term: 'License', definition: 'MIT' },
    { term: 'Maintainer', definition: 'Cinder team' },
  ];
</script>

<DescriptionList {items} />
