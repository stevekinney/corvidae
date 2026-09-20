import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      type: 'string',
      description: 'Current query text. Bindable.',
    },
    activeIndex: {
      type: 'number',
      description: 'Index of the active match within the host-provided results. Bindable.',
    },
    matchCount: {
      anyOf: [
        {
          type: 'number',
        },
        {
          type: 'null',
        },
      ],
      description:
        'Number of matches for the current query, or `null` when the host has not searched yet.',
    },
    minQueryLength: {
      type: 'number',
      description: 'Minimum query length before the host should search.',
    },
    debounceMs: {
      type: 'number',
      description: 'Debounce interval, in milliseconds, before `onQueryChange` fires.',
    },
    label: {
      type: 'string',
      description: 'Accessible label for the find controls.',
    },
    class: {
      type: 'string',
      description: "Additional class merged with the component's root class.",
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'onDismiss',
        reason: 'function-or-snippet',
        description: 'Called when the user dismisses the find bar.',
      },
      {
        name: 'onNext',
        reason: 'function-or-snippet',
        description: 'Called when the user requests the next match.',
      },
      {
        name: 'onPrevious',
        reason: 'function-or-snippet',
        description: 'Called when the user requests the previous match.',
      },
      {
        name: 'onQueryChange',
        reason: 'function-or-snippet',
        description: 'Called with the debounced query text as the user types.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
