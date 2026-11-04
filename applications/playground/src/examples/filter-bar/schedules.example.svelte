<script lang="ts" module>
  export const title = 'Schedules filter bar';
  export const description =
    'Segments that partition the list, a "Missed runs" toggle chip with a warning dot beside them (not a fourth segment, because a schedule can be both active and missed), and "Agent" and "Workflow" chips. No search field.';
</script>

<script lang="ts">
  import { type AppliedFilter, type FacetDefinition, FilterBar } from '@lostgradient/cinder';

  const segments = [
    { value: 'all', label: 'All', count: 4 },
    { value: 'active', label: 'Active', count: 3 },
    { value: 'paused', label: 'Paused', count: 1 },
  ];

  const facets: FacetDefinition[] = [
    { type: 'toggle', key: 'missed', label: 'Missed runs', count: 1 },
    {
      type: 'choice',
      key: 'agent',
      label: 'Agent',
      multiple: false,
      options: [
        { value: 'assistant', label: 'Assistant' },
        { value: 'tool-runner', label: 'Tool runner' },
      ],
    },
    {
      type: 'choice',
      key: 'workflow',
      label: 'Workflow',
      multiple: false,
      options: [
        { value: 'release-notes', label: 'Release notes' },
        { value: 'triage-inbox', label: 'Triage inbox' },
      ],
    },
  ];

  let segmentValue = $state('all');
  let appliedFilters = $state<AppliedFilter[]>([]);

  function setFilter(key: string, value: string) {
    const facet = facets.find((candidate) => candidate.key === key);
    const rest = appliedFilters.filter((filter) => filter.key !== key);
    appliedFilters = value === '' ? rest : [...rest, { key, value, label: facet?.label ?? key }];
  }
</script>

<FilterBar
  aria-label="Schedule filters"
  searchVisible={false}
  {segments}
  {segmentValue}
  {facets}
  {appliedFilters}
  onSegmentChange={(value) => (segmentValue = value)}
  onFacetChange={setFilter}
  onFilterRemove={(key) => setFilter(key, '')}
/>
