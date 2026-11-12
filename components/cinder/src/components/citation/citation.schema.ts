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
        name: 'sources',
        reason: 'unknown-shape',
        required: true,
        description:
          'The sources behind the claim, in the order to show them. Up to five are listed together; more are paged one at a time.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
