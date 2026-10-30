import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description:
        'Accessible name of the view, for example "Workflow input". It is the\n`aria-label` of the region, so name what the schema describes.',
      default: 'Schema',
    },
    maxDepth: {
      type: 'number',
      description:
        'How many levels of nested objects are expanded. Deeper objects show their\nline without their fields, and the raw document still holds them.',
      default: 8,
    },
    rawLabel: {
      type: 'string',
      description: 'Label of the disclosure that reveals the raw schema document.',
      default: 'View JSON Schema',
    },
    emptyLabel: {
      type: 'string',
      description: 'Text shown when the schema declares no fields.',
      default: 'This schema declares no fields.',
    },
    class: {
      type: 'string',
      description: 'Additional class merged onto the `.cinder-schema-view` root element.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'schema',
        reason: 'unknown-shape',
        required: true,
        description:
          'The JSON Schema to show, as a parsed object. Local `$ref`s into `$defs` or\n`definitions` are followed and `allOf` members are merged. A schema that is\nnot an object with properties shows one `Value` line naming its type.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
