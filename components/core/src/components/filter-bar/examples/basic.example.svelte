<script lang="ts" module>
  export const title = 'Runs filter bar';
  export const description =
    'Status segments with counts, a multiple choice "Started by" chip that matches any selected origin, a single choice "Agent" chip, and a search field. Narrow the window to see the segments fold into a select, then into a Filter menu.';
</script>

<script lang="ts">
  import { type AppliedFilter, type FacetDefinition, FilterBar } from '@lostgradient/cinder';

  const segments = [
    { value: 'all', label: 'All', count: 19 },
    { value: 'waiting', label: 'Waiting on you', count: 2 },
    { value: 'running', label: 'Running', count: 0 },
    { value: 'done', label: 'Done', count: 15 },
    { value: 'failed', label: 'Failed', count: 1 },
    { value: 'canceled', label: 'Canceled', count: 1 },
  ];

  const facets: FacetDefinition[] = [
    {
      type: 'choice',
      key: 'startedBy',
      label: 'Started by',
      options: [
        { value: 'you', label: 'You', count: 0 },
        { value: 'chats', label: 'Chats', count: 5 },
        { value: 'schedules', label: 'Schedules', count: 4 },
        { value: 'goals', label: 'Goals', count: 8 },
        { value: 'interborough', label: 'Interborough', count: 2 },
        { value: 'workflows', label: 'Workflows', count: 0 },
        { value: 'agents', label: 'Agents', count: 0 },
      ],
    },
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
  ];

  let segmentValue = $state('all');
  let appliedFilters = $state<AppliedFilter[]>([
    { key: 'agent', value: 'tool-runner', label: 'Agent' },
  ]);
  let searchQuery = $state('');

  function setFilter(key: string, values: readonly string[]) {
    const facet = facets.find((candidate) => candidate.key === key);
    const rest = appliedFilters.filter((filter) => filter.key !== key);
    appliedFilters =
      values.length === 0
        ? rest
        : [...rest, { key, value: values.join(','), label: facet?.label ?? key, values }];
  }
</script>

<FilterBar
  aria-label="Run filters"
  {segments}
  {segmentValue}
  {facets}
  {appliedFilters}
  {searchQuery}
  searchPlaceholder="Search runs"
  onSegmentChange={(value) => (segmentValue = value)}
  onSearchChange={(query) => (searchQuery = query)}
  onFacetChange={(key, value) => setFilter(key, value === '' ? [] : [value])}
  onFacetValuesChange={setFilter}
  onFilterRemove={(key) => setFilter(key, [])}
/>
