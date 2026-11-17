import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    placeholder: {
      type: 'string',
      description:
        'Low-resolution image source (typically a base64 data URI) shown as a\npixelated background while the main image loads. Fades out once the\n`<img>` fires `load`.',
    },
    src: {
      type: 'string',
      description: 'Image source URL.',
    },
    alt: {
      type: 'string',
      description:
        'Alternative text. Required with no default — pass `alt=""` explicitly for\ndecorative images so the choice is intentional, not silent.',
    },
    width: {
      type: 'number',
      description: 'Native pixel width.',
    },
    height: {
      type: 'number',
      description: 'Native pixel height.',
    },
    ratio: {
      type: 'string',
      description:
        "CSS aspect-ratio applied to the wrapper (e.g. `'16 / 9'`) so layout is\nstable while the image loads.",
    },
    fit: {
      enum: ['contain', 'cover', 'fill', 'none', 'scale-down'],
      description:
        'How the image fills its box, mapped onto CSS `object-fit`. Omitted, the\nimage covers the box (`cover`).',
    },
    size: {
      enum: ['icon', 'avatar', 'small', 'medium', 'large', 'header'],
      description:
        "Token-based dimensions. `icon` and `avatar` are squares; `small`,\n`medium`, and `large` set the width and let `ratio` or the image's own\nproportions set the height; `header` spans the container at a banner\nheight. Omitted, the image keeps its natural, container-driven size.",
    },
    loading: {
      enum: ['lazy', 'eager'],
      description:
        'Loading strategy. Default `lazy`. Override to `eager` for above-the-fold images.',
    },
    decoding: {
      enum: ['async', 'sync', 'auto'],
      description: 'Decoding hint. Default `async`.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-image`.',
    },
  },
  additionalProperties: false,
  required: ['alt', 'src'],
  metadata: {
    unsupportedProps: [
      {
        name: 'fallback',
        reason: 'function-or-snippet',
        description: 'Rendered in place of the `<img>` when it fails to load.',
      },
      {
        name: 'onError',
        reason: 'function-or-snippet',
        description: 'Forwarded after internal state updates.',
      },
      {
        name: 'onLoad',
        reason: 'function-or-snippet',
        description: 'Forwarded after internal state updates.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
