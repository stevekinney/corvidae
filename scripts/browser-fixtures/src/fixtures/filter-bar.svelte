<script lang="ts">
  import { type AppliedFilter, type FacetDefinition, FilterBar } from '@lostgradient/cinder';

  const choiceContainment =
    new URLSearchParams(globalThis.location.search).get('choice-containment') === '1';

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

  const longFacet: FacetDefinition = {
    type: 'choice',
    key: 'outcome',
    label: 'Outcome',
    multiple: false,
    options: Array.from({ length: 20 }, (_, index) => ({
      value: `outcome-${String(index + 1)}`,
      label: `Outcome ${String(index + 1)}`,
    })),
  };

  let segmentValue = $state('all');
  let appliedFilters = $state<AppliedFilter[]>([
    { key: 'agent', value: 'tool-runner', label: 'Agent' },
  ]);
  let searchQuery = $state('');

  function setFilter(key: string, values: readonly string[]) {
    const facet = [...facets, longFacet].find((candidate) => candidate.key === key);
    const rest = appliedFilters.filter((filter) => filter.key !== key);
    appliedFilters =
      values.length === 0
        ? rest
        : [...rest, { key, value: values.join(','), label: facet?.label ?? key, values }];
  }
</script>

<FilterBar
  aria-label="Workflow filters"
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

<!-- The same bar in a column too narrow for the wide form and wide enough to keep its segments
     (COR-2449): the search folds into an icon button first. The wide form of this content needs
     about 945px (the controls run about 760px, a gap, then the search field at its 11rem basis);
     with the search as a 32px icon button it needs about 800px. 880px sits in the middle of the
     two, so a font that measures a little wider or narrower leaves the bar in the same form. -->
<div
  data-testid="filter-bar-search-folded"
  class="filter-bar-search-folded-layout margin-block-start-8"
>
  <FilterBar
    aria-label="Run filters in a narrower column"
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
</div>

{#if choiceContainment}
  <FilterBar
    aria-label="Choice facet containment"
    facets={[longFacet, facets[1] as FacetDefinition]}
    {appliedFilters}
    onFacetChange={(key, value) => setFilter(key, value === '' ? [] : [value])}
    onFilterRemove={(key) => setFilter(key, [])}
  />
{/if}

<!-- The tablet form of the Runs page (row 52x): three chips, two of them applied, in a column the
     medium form cannot hold (its controls need about 640px with every chip in the row, and about
     580px with Workflow folded). The unapplied Workflow chip moves into the Filter menu
     (`foldOrder`, least used first) and the applied Started by and Agent chips stay in the row,
     removable. -->
<div data-testid="filter-bar-fold-order" class="filter-bar-fold-order-layout margin-block-start-8">
  <FilterBar
    aria-label="Run filters with chips folded in order"
    {segments}
    segmentValue="all"
    facets={[
      facets[0] as FacetDefinition,
      {
        type: 'choice',
        key: 'workflow',
        label: 'Workflow',
        multiple: false,
        options: [{ value: 'release-notes', label: 'Release notes' }],
      },
      facets[1] as FacetDefinition,
    ]}
    appliedFilters={[
      { key: 'startedBy', value: 'chats', label: 'Started by' },
      { key: 'agent', value: 'tool-runner', label: 'Agent' },
    ]}
    foldOrder={['workflow', 'agent', 'startedBy']}
    searchPlaceholder="Search runs"
    onSegmentChange={() => undefined}
    onSearchChange={() => undefined}
    onFacetChange={() => undefined}
    onFilterRemove={() => undefined}
  />
</div>

<style>
  .filter-bar-search-folded-layout {
    inline-size: 880px;
  }

  .filter-bar-fold-order-layout {
    inline-size: 600px;
  }
</style>
