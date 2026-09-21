<script lang="ts">
  import { DescriptionList } from '@lostgradient/cinder';
  import type { DescriptionListItem } from '@lostgradient/cinder';

  const items: DescriptionListItem[] = [
    { term: 'Component', definition: 'DescriptionList' },
    { term: 'Status', definition: 'Stable' },
    { term: 'Version', definition: '1.0.0' },
    { term: 'License', definition: 'MIT' },
    { term: 'Maintainer', definition: 'Cinder team' },
  ];
</script>

<DescriptionList {items} />
