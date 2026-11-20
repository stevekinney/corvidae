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
  class="description-list-fields-layout gap-6 margin-block-start-6 padding-inline-3"
>
  <div data-testid="description-list-fields-flat" class="field-column">
    <DescriptionList items={fields} variant="fields" />
  </div>
  <div data-testid="description-list-fields-framed" class="field-column">
    <DescriptionList items={fields} variant="fields" framed />
  </div>
</div>

<style>
  .description-list-fields-layout {
    display: flex;
    flex-wrap: wrap;
  }

  .field-column {
    flex: 1 1 16rem;
  }
</style>
