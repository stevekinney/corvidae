import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    class: {
      type: 'string',
      description: "Additional class merged with the component's root class.",
    },
    scale: {
      type: 'number',
      description: 'Starting zoom scale. Defaults to `1`.',
      default: 1,
    },
    ariaLabel: {
      type: 'string',
      description: 'Names the viewport. Does not describe the diagram itself.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Content the viewer pans and zooms.',
      },
      {
        name: 'onTransformChange',
        reason: 'function-or-snippet',
        description:
          'Called with `{ scale, x, y }` whenever the pan or zoom transform changes, for hosts that persist or mirror it.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
