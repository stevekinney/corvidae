import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    open: { type: 'boolean', description: 'Whether the controlled region is open.' },
    controls: { type: 'string', description: 'The controlled region id.' },
    class: { type: 'string', description: 'Custom trigger class.' },
  },
  required: ['open'],
  additionalProperties: false,
  metadata: {
    unsupportedProps: [{ name: 'children', reason: 'function-or-snippet', required: true }],
  },
} satisfies ComponentSchema;

export default schema;
