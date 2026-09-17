<script lang="ts">
  import { DescriptionList } from '@repo/cinder';
  import type { DescriptionListItem } from '@repo/cinder';

  const items: DescriptionListItem[] = [
    { term: 'Component', definition: 'DescriptionList' },
    { term: 'Status', definition: 'Stable' },
    { term: 'Version', definition: '1.0.0' },
    { term: 'License', definition: 'MIT' },
    { term: 'Maintainer', definition: 'Cinder team' },
  ];
</script>

<DescriptionList {items} />
