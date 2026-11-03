# FilterBar

A single-row filtering toolbar for list views: status segments with counts, facets drawn as selects or chips, and a search field. It never wraps. It folds by width instead: the segments become a "Status: All 19" select, the search becomes an icon button, and on a phone only the select and a Filter menu remain.

## Overview

`FilterBar` composes `SegmentedControl`, `Select`, `Popover`, `Chip` and `SearchField` into one accessible filtering surface. It owns no routing, persistence or data fetching: it emits change events, and the consumer owns the filter state and the data.

The bar has four kinds of facet, and every one is a single control in the row:

- **`select`**: an always-visible single-choice select that reads "Kind: All". The value is on the control, so it never becomes a chip. Use it for a short list the person switches between, such as a memory list's kind and writer.
- **`choice`**: an add-facet chip ("+ Started by") that opens a popover. With `multiple` (the default) the popover is a titled list of checkboxes with a count at the end of each row and a footer that reads "Matches any selected" beside a Clear link. With `multiple: false` it is a list of radio rows. A facet with a value becomes a tinted chip that reads "Started by: Chats, Goals" with an x that removes it.
- **`toggle`**: a chip that is on or off, with a dot and a count ("Missed runs 1"). It sits beside the segments for a warning filter that is not a segment, because a row can be both in a segment and in the filter.
- **`custom`**: a consumer-supplied snippet for a control that cannot be expressed as a list, such as a date-range picker.

## Layouts

The layout is chosen in script, because the controls that disappear move into a menu.

| Layout | When | What it draws |
| --- | --- | --- |
| `wide` | Viewport 1024px and wider, and the bar is wide enough | The segments, the facet controls, and the search field at the end of the row. |
| `medium` | Viewport 640px to 1023px | The segments folded into a "Status: All 19" select, the facet chips unchanged, and the search as an icon button that opens a popover. |
| `narrow` | Viewport under 640px | Only the Status select and a Filter button. The Filter menu lists every facet and Search, and a row opens its options in place. |

The bar also measures its own width, so a wide viewport beside a wide sidebar steps down instead of overflowing: it takes the narrower of what the viewport asks for and what its controls need. Pass `layout` to force one. A bar with no segments, chips or toggles (selects and a search field alone) has nothing to fold, so it keeps one form and stacks its controls in one column inside a narrow container, as a list pane's filters do.

An applied chip sits after the chips still waiting for a value, whatever order the facets are listed in, so a chip never jumps while its own popover is open.

## Usage

```svelte
<script lang="ts">
  import { FilterBar } from '@lostgradient/cinder';
  import type { AppliedFilter, FacetDefinition } from '@lostgradient/cinder';

  const segments = [
    { value: 'all', label: 'All', count: 19 },
    { value: 'waiting', label: 'Waiting on you', count: 2 },
    { value: 'done', label: 'Done', count: 15 },
    { value: 'failed', label: 'Failed', count: 1 },
  ];

  const facets: FacetDefinition[] = [
    {
      type: 'choice',
      key: 'startedBy',
      label: 'Started by',
      options: [
        { value: 'chats', label: 'Chats', count: 5 },
        { value: 'goals', label: 'Goals', count: 8 },
      ],
    },
    {
      type: 'choice',
      key: 'agent',
      label: 'Agent',
      multiple: false,
      options: [{ value: 'tool-runner', label: 'Tool runner' }],
    },
  ];

  let segmentValue = $state('all');
  let appliedFilters = $state<AppliedFilter[]>([]);
  let searchQuery = $state('');

  function setFilter(key: string, values: readonly string[]) {
    const rest = appliedFilters.filter((filter) => filter.key !== key);
    appliedFilters =
      values.length === 0 ? rest : [...rest, { key, label: key, value: values.join(','), values }];
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
```

Segment values must not be empty, and a segment's `count` is part of its accessible name ("Waiting on you, 2"). Zero is shown ("Running 0"); `'pending'` draws a dash.

### Search position

A bar with segments, chips or toggles puts its search field at the end of the row. A bar of selects alone starts with it. Pass `searchPosition` to choose.

### Custom facet

Use `type: 'custom'` with a `control` snippet for any facet that cannot be expressed as a list. In the narrow layout it is drawn inside the Filter menu, under its label.

```svelte
<script lang="ts">
  import { FilterBar } from '@lostgradient/cinder';
</script>

{#snippet dateRangeControl({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (v: string) => void;
  disabled: boolean;
})}
  <!-- render your date-range control here; call onValueChange(value) on selection -->
{/snippet}

<FilterBar
  aria-label="Order filters"
  facets={[
    {
      type: 'custom',
      key: 'dateRange',
      label: 'Date range',
      control: dateRangeControl,
    },
  ]}
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `aria-label` | `string` | no | — | Defines a string value that labels the current element. |
| `class` | `string` | no | — | Additional CSS classes applied to the root element. |
| `disabled` | `boolean` | no | — | When true, all filter controls and chips are disabled. |
| `layout` | `"auto"` \| `"wide"` \| `"medium"` \| `"narrow"` | no | — | Force a layout. By default the bar follows the viewport (phone under 640px, tablet under 1024px) and narrows further when its own width cannot hold the wider form. |
| `searchAriaLabel` | `string` | no | — | Accessible label for the search input. Defaults to 'Search'. |
| `searchPlaceholder` | `string` | no | — | Placeholder text shown in the search field. |
| `searchPosition` | `"start"` \| `"end"` | no | — | Which end of the row the search field sits at. A bar with segments or chips puts it at the `end`; a bar of selects alone puts it at the `start`. |
| `searchQuery` | `string` | no | — | Current text search query. When provided, the search field is controlled. |
| `searchVisible` | `boolean` | no | — | Whether to render the search field. Defaults to `true`. |
| `segmentsLabel` | `string` | no | — | Accessible name of the segments and the prefix before the value in the collapsed select. Defaults to `Status`. |
| `segmentValue` | `string` | no | — | The chosen segment's value. Defaults to the first segment. |
| `appliedFilters` | `(opaque)` | no | — | The facets that have a value. A select facet reads its value here, a choice facet draws a tinted chip for its entry, and a toggle facet is on while it has an entry. Controlled by the consumer; each entry is a key/value/label triple. Not expressible in JSON Schema; see the component types for the signature. |
| `facets` | `(opaque)` | no | — | Facet definitions rendered as filter controls. Each entry is a select, a choice, a toggle or a custom snippet-driven facet. Not expressible in JSON Schema; see the component types for the signature. |
| `onFacetChange` | `(opaque)` | no | — | Fires when a select, single choice, toggle or custom facet changes, with the facet key and the new value. A cleared facet reports an empty string. Not expressible in JSON Schema; see the component types for the signature. |
| `onFacetValuesChange` | `(opaque)` | no | — | Fires when a multiple choice facet changes, with the facet key and every chosen value. Not expressible in JSON Schema; see the component types for the signature. |
| `onFilterRemove` | `(opaque)` | no | — | Fires when an applied filter chip is removed. Not expressible in JSON Schema; see the component types for the signature. |
| `onSearchChange` | `(opaque)` | no | — | Fires when the search query changes. Not expressible in JSON Schema; see the component types for the signature. |
| `onSegmentChange` | `(opaque)` | no | — | Fires when a segment is chosen. Not expressible in JSON Schema; see the component types for the signature. |
| `segments` | `(opaque)` | no | — | Status segments drawn first in the row ("All 19", "Waiting on you 2"). The first is the default. Below the wide layout they collapse to one select reading "Status: All 19". Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

<!-- generated:subcomponents:end -->

## Types

```ts
import type { Snippet } from 'svelte';

type FacetOption = { value: string; label: string; disabled?: boolean; count?: number };

// "Kind: All": an always-visible single-choice select.
type SelectFacet = {
  type: 'select';
  key: string;
  label: string;
  placeholder?: string; // the row that clears it; defaults to "All"
  options: readonly FacetOption[];
  disabled?: boolean;
};

// "+ Started by": an add-facet chip that opens a popover of options.
type ChoiceFacet = {
  type: 'choice';
  key: string;
  label: string;
  title?: string;
  options: readonly FacetOption[];
  multiple?: boolean; // default true: checkboxes, reported through onFacetValuesChange
  matchLabel?: string; // default "Matches any selected"
  disabled?: boolean;
};

// "Missed runs 1": a chip that is on or off.
type ToggleFacet = {
  type: 'toggle';
  key: string;
  label: string;
  count?: number;
  tone?: 'warning' | 'danger' | 'info' | 'success' | 'neutral';
  disabled?: boolean;
};

type CustomFacet = {
  type: 'custom';
  key: string;
  label: string;
  control: Snippet<[{ value: string; onValueChange: (value: string) => void; disabled: boolean }]>;
};

type AppliedFilter = {
  key: string; // matches a facet key
  value: string; // the chosen value; a multiple choice facet joins its values with a comma
  label: string; // the facet's label
  values?: readonly string[]; // the chosen values of a multiple choice facet; wins over `value`
};

type FilterSegment = {
  value: string;
  label: string;
  count?: number | 'pending';
  disabled?: boolean;
};
```

## Accessibility

`FilterBar` uses `role="search"` on the root element to expose the filtering surface as a landmark. Consumers should provide a meaningful `aria-label` prop (for example `"Run filters"`) so screen reader users can navigate to it by landmark.

The segments are a radio group named by `segmentsLabel`, and each count is part of its segment's name. A chip's label button opens a dialog named by the facet's title; its x is a separate button named "Remove filter: Started by: Chats, Goals". The Filter button names how many filters are applied. A `role="status"` live region (polite) always stays in the DOM and announces the active filter count and each value whenever `appliedFilters` changes.

See `filter-bar.a11y.md` for the full keyboard and pointer interaction model.
