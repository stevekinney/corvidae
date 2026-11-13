import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-citation`.',
    },
    label: {
      type: 'string',
      description:
        'Names the marker and the panel, such as `Sources`. The marker reads it with the source count.',
    },
    current: {
      type: 'number',
      description:
        'The index in `sources` of the source the reader followed a marker for. Its row is marked as the current one, and the list opens scrolled to it.',
    },
    inPlace: {
      type: 'boolean',
      description:
        'Opens the sources under the marker instead of in a floating popover, on a viewport at least as wide as a phone. On a phone they still open in the bottom sheet.',
    },
    expanded: {
      type: 'boolean',
      description:
        'With `inPlace`, whether the sources are open under the marker. Bindable; the marker toggles it.',
    },
    shownInPlace: {
      type: 'boolean',
      description:
        'Reports whether the sources are shown under the marker (`inPlace` on a wide viewport) or in the sheet or popover. Bindable, read only.',
    },
    closeOnSourceRemoval: {
      type: 'boolean',
      description:
        'Closes an open panel when a previously displayed source is withdrawn by the host.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
      },
      {
        name: 'labels',
        reason: 'unknown-shape',
        description:
          'The words Citation draws itself, for a host that translates them. Each one left out keeps its English default.',
      },
      {
        name: 'onCloseComplete',
        reason: 'function-or-snippet',
        description: 'Called after an open source panel or sheet has fully closed.',
      },
      {
        name: 'onExpandedChange',
        reason: 'function-or-snippet',
        description:
          'With `inPlace`, called after the marker toggles `expanded`, with the new value.',
      },
      {
        name: 'sources',
        reason: 'unknown-shape',
        required: true,
        description:
          'The sources behind the claim, in the order to show them. Every source is one row of one list, however many there are.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
