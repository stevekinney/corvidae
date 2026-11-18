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

  const fields: DescriptionListItem[] = [
    { term: 'Workflow', definition: 'Order refund', href: '#workflow' },
    { term: 'Schedule', definition: 'Every day at 3:00 AM' },
    { term: 'Agent', definition: 'Assistant' },
  ];
</script>

<DescriptionList {items} />

<!-- The `fields` variant (COR-2449): flat by default, and beside it the `framed` opt-in. -->
<div
  data-testid="description-list-fields"
  style="display: flex; flex-wrap: wrap; gap: 1.5rem; margin-block-start: 1.5rem; padding-inline: 0.75rem;"
>
  <div data-testid="description-list-fields-flat" style="flex: 1 1 16rem;">
    <DescriptionList items={fields} variant="fields" />
  </div>
  <div data-testid="description-list-fields-framed" style="flex: 1 1 16rem;">
    <DescriptionList items={fields} variant="fields" framed />
  </div>
</div>
