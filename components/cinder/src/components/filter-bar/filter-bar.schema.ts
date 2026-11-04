import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    'aria-label': {
      type: 'string',
      description: 'Defines a string value that labels the current element.',
    },
    segmentValue: {
      type: 'string',
      description: "The chosen segment's value. Defaults to the first segment.",
    },
    segmentsLabel: {
      type: 'string',
      description:
        'Accessible name of the segments and the prefix before the value in the collapsed select. Defaults to `Status`.',
    },
    searchQuery: {
      type: 'string',
      description: 'Current text search query. When provided, the search field is controlled.',
    },
    searchVisible: {
      type: 'boolean',
      description: 'Whether to render the search field. Defaults to `true`.',
    },
    searchPlaceholder: {
      type: 'string',
      description: 'Placeholder text shown in the search field.',
    },
    searchAriaLabel: {
      type: 'string',
      description: "Accessible label for the search input. Defaults to 'Search'.",
    },
    searchPosition: {
      enum: ['start', 'end'],
      description:
        'Which end of the row the search field sits at. A bar with segments or chips puts it at the\n`end`; a bar of selects alone puts it at the `start`.',
    },
    layout: {
      enum: ['auto', 'wide', 'medium', 'narrow'],
      description:
        'Force a layout. By default the bar follows the viewport (phone under 640px, tablet under\n1024px) and narrows further when its own width cannot hold the wider form.',
    },
    disabled: {
      type: 'boolean',
      description: 'When true, all filter controls and chips are disabled.',
    },
    class: {
      type: 'string',
      description: 'Additional CSS classes applied to the root element.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'appliedFilters',
        reason: 'unknown-shape',
        description:
          'The facets that have a value. A select facet reads its value here, a choice facet draws a\ntinted chip for its entry, and a toggle facet is on while it has an entry. Controlled by\nthe consumer; each entry is a key/value/label triple.',
      },
      {
        name: 'facets',
        reason: 'unknown-shape',
        description:
          'Facet definitions rendered as filter controls. Each entry is a select, a choice, a toggle\nor a custom snippet-driven facet.',
      },
      {
        name: 'onFacetChange',
        reason: 'function-or-snippet',
        description:
          'Fires when a select, single choice, toggle or custom facet changes, with the facet key and\nthe new value. A cleared facet reports an empty string.',
      },
      {
        name: 'onFacetValuesChange',
        reason: 'function-or-snippet',
        description:
          'Fires when a multiple choice facet changes, with the facet key and every chosen value.',
      },
      {
        name: 'onFilterRemove',
        reason: 'function-or-snippet',
        description: 'Fires when an applied filter chip is removed.',
      },
      {
        name: 'onSearchChange',
        reason: 'function-or-snippet',
        description: 'Fires when the search query changes.',
      },
      {
        name: 'onSegmentChange',
        reason: 'function-or-snippet',
        description: 'Fires when a segment is chosen.',
      },
      {
        name: 'segments',
        reason: 'unknown-shape',
        description:
          'Status segments drawn first in the row ("All 19", "Waiting on you 2"). The first is the\ndefault. Below the wide layout they collapse to one select reading "Status: All 19".',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
