import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      type: 'string',
      description: "Current query text. Bindable. Defaults to `''`.",
      default: '',
    },
    activeIndex: {
      type: 'number',
      description:
        'Index of the active match within the host-provided results. Bindable.\nDefaults to `0`.',
      default: 0,
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
        'Number of matches for the current query, or `null` when the host has\nnot searched yet. Defaults to `null`.',
      default: null,
    },
    minQueryLength: {
      type: 'number',
      description: 'Minimum query length before the host should search. Defaults to `3`.',
      default: 3,
    },
    debounceMs: {
      type: 'number',
      description:
        'Debounce interval, in milliseconds, before `onQueryChange` fires.\nDefaults to `250`.',
      default: 250,
    },
    label: {
      type: 'string',
      description: "Accessible label for the find controls. Defaults to `'Find'`.",
      default: 'Find',
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
        description:
          "Called with the debounced query text once user typing (the `input`\nevent) reaches `minQueryLength`. Also called immediately with `''`,\nbypassing the debounce, the moment a previously eligible query shrinks\nbelow `minQueryLength`—handle the empty-string case as a synchronous\nreset, not just the debounced value. Only that ineligible-transition\ncase is notified when triggered externally: assigning an eligible\n`value` via `bind:value`, or lowering `minQueryLength` so the current\n`value` becomes eligible, does not itself call this callback—a host\nthat restores or sets `value` programmatically must trigger its own\nsearch rather than rely on this firing.",
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
