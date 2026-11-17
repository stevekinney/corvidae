<script lang="ts" module>
  export const title = 'Disabled state';
  export const description =
    'Every control is disabled when disabled=true: the segments, the chips, the selects and the search field.';
</script>

<script lang="ts">
  import { type FacetDefinition, FilterBar } from '@lostgradient/cinder';

  const facets: FacetDefinition[] = [
    {
      type: 'choice',
      key: 'agent',
      label: 'Agent',
      multiple: false,
      options: [{ value: 'tool-runner', label: 'Tool runner' }],
    },
  ];
</script>

<FilterBar
  aria-label="Disabled filter bar"
  segments={[
    { value: 'all', label: 'All', count: 3 },
    { value: 'failed', label: 'Failed', count: 1 },
  ]}
  {facets}
  appliedFilters={[{ key: 'agent', value: 'tool-runner', label: 'Agent' }]}
  disabled
/>
