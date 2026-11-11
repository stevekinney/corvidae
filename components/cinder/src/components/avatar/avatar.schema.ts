import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    src: {
      type: 'string',
      description: 'Image source. When omitted, the initials fallback renders.',
    },
    alt: {
      type: 'string',
      description: 'Alternative text for the image. Defaults to `name` when present.',
    },
    name: {
      type: 'string',
      description:
        'Display name used to compute initials when no image is available: the first letters of its\nfirst two words, split on whitespace, hyphens, underscores, dots and colons, after a leading\n`namespace:` part is dropped (`demo:tool-runner` reads "TR"). Also used as the default `alt`\nfor the image.',
    },
    size: {
      enum: ['xs', 'sm', 'md', 'lg', 'xl'],
      description: 'Size token. Default `md`.',
    },
    shape: {
      enum: ['circle', 'square'],
      description: 'Shape. Default `circle`.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-avatar`.',
    },
  },
  additionalProperties: false,
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
