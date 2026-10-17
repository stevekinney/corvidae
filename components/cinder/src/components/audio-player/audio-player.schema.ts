import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    src: {
      type: 'string',
      description:
        'Media source. Only `https:`, `http:`, and `blob:` URLs load; any other scheme renders the unavailable state.',
    },
    label: {
      type: 'string',
      description: 'Accessible name for the player.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-audio-player`.',
    },
  },
  additionalProperties: false,
  required: ['label', 'src'],
} satisfies ComponentSchema;

export default schema as ComponentSchema;
