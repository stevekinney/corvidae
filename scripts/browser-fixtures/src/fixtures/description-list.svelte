<script lang="ts">
  import { Button, DescriptionList } from '@lostgradient/cinder';
  import type { DescriptionListItem } from '@lostgradient/cinder';

  const items: DescriptionListItem[] = [
    { term: 'Component', definition: 'DescriptionList' },
    { term: 'Status', definition: 'Stable' },
    { term: 'Version', definition: '1.0.0' },
    { term: 'License', definition: 'MIT' },
    { term: 'Maintainer', definition: 'Cinder team' },
  ];

  const wrapping = new URLSearchParams(globalThis.location.search).has('wrapping');
  const builds: DescriptionListItem[] = [
    {
      term: 'Builds',
      definition: '2026.11.06 for 3 runs, then 2026.11.13 for 4 runs, then 2026.11.20 for 2 runs',
      href: '#builds',
    },
  ];
  const identifier: DescriptionListItem[] = [
    { term: 'Run ID', definition: { type: 'identifier', value: 'run-41b29cf' } },
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

{#if wrapping}
  <div data-testid="wrap-with-link">
    <DescriptionList items={builds} stack />
  </div>
  <div data-testid="wrap-with-actions">
    <DescriptionList items={builds} stack>
      {#snippet actions()}<Button size="xs" variant="ghost">Edit</Button>{/snippet}
    </DescriptionList>
  </div>
  <DescriptionList items={identifier} />
{/if}

<style>
  .description-list-fields-layout {
    display: flex;
    flex-wrap: wrap;
  }

  .field-column {
    flex: 1 1 16rem;
  }
</style>
