<script lang="ts" module>
  export const title = 'Search and select facets';
  export const description =
    'Two separate single-choice selects beside a search field, as a memory list uses them: "Kind: All" and "Written by: Anyone". A bar of selects has nothing to collapse, so it stacks in a narrow container instead.';
</script>

<script lang="ts">
  import { type AppliedFilter, type FacetDefinition, FilterBar } from '@lostgradient/cinder';

  const facets: FacetDefinition[] = [
    {
      type: 'select',
      key: 'kind',
      label: 'Kind',
      options: [
        { value: 'fact', label: 'Fact' },
        { value: 'how-to', label: 'How-to' },
      ],
    },
    {
      type: 'select',
      key: 'writer',
      label: 'Written by',
      placeholder: 'Anyone',
      options: [
        { value: 'you', label: 'You' },
        { value: 'tool-runner', label: 'Tool runner' },
      ],
    },
  ];

  let appliedFilters = $state<AppliedFilter[]>([]);
  let searchQuery = $state('');

  function setFilter(key: string, value: string) {
    const facet = facets.find((candidate) => candidate.key === key);
    const rest = appliedFilters.filter((filter) => filter.key !== key);
    appliedFilters = value === '' ? rest : [...rest, { key, value, label: facet?.label ?? key }];
  }
</script>

<FilterBar
  aria-label="Memory filters"
  {facets}
  {appliedFilters}
  {searchQuery}
  searchPlaceholder="Search memories"
  onSearchChange={(query) => (searchQuery = query)}
  onFacetChange={setFilter}
/>
