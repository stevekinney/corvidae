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
      description:
        'Starting zoom scale. Bindable. Clamped to `0.25`–`8`; a non-finite\nvalue normalizes to `1`. A programmatic external change to this prop\ndoes not itself fire `onTransformChange` (see that prop). Defaults to\n`1`.',
      default: 1,
    },
    ariaLabel: {
      type: 'string',
      description:
        "Names the viewport. Does not describe the diagram itself. Defaults to\n`'Zoomable viewer'`.",
      default: 'Zoomable viewer',
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
          'Called with `{ scale, x, y }` after a pointer, keyboard, or control\ninteraction changes the pan or zoom transform. Not called when `scale`\nchanges only because the caller passed a new value externally—hosts\nthat need to react to that must watch `scale` themselves.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
