<script lang="ts" module>
  export const title = 'Workflows filter bar';
  export const description =
    'Three segments, one "Starts" add-facet chip and a search field on one row. With "Problems" chosen the segments read "Status: Problems 1" below the wide layout.';
</script>

<script lang="ts">
  import { type AppliedFilter, type FacetDefinition, FilterBar } from '@lostgradient/cinder';

  const segments = [
    { value: 'all', label: 'All', count: 3 },
    { value: 'paused', label: 'Paused', count: 1 },
    { value: 'problems', label: 'Problems', count: 1 },
  ];

  const facets: FacetDefinition[] = [
    {
      type: 'choice',
      key: 'starts',
      label: 'Starts',
      multiple: false,
      options: [
        { value: 'schedule', label: 'On a schedule' },
        { value: 'manual', label: 'When you start it' },
      ],
    },
  ];

  let segmentValue = $state('all');
  let appliedFilters = $state<AppliedFilter[]>([]);
  let searchQuery = $state('');

  function setStarts(value: string) {
    appliedFilters = value === '' ? [] : [{ key: 'starts', value, label: 'Starts' }];
  }
</script>

<FilterBar
  aria-label="Workflow filters"
  {segments}
  {segmentValue}
  {facets}
  {appliedFilters}
  {searchQuery}
  searchPlaceholder="Search workflows"
  searchAriaLabel="Search workflows"
  onSegmentChange={(value) => (segmentValue = value)}
  onSearchChange={(query) => (searchQuery = query)}
  onFacetChange={(_key, value) => setStarts(value)}
  onFilterRemove={() => setStarts('')}
/>
