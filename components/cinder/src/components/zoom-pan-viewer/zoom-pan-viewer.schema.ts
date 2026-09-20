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
        'Starting zoom scale. Bindable, but clamping is render-only: an\nout-of-range or non-finite value is clamped to `0.25`–`8` (or\nnormalized to `1` if non-finite) only in the transform actually\nrendered—the bound `scale` value itself is left as the caller set it\nand is not written back, so a parent observes its own out-of-range or\nnon-finite value until an internal pointer/keyboard/control\ninteraction calls `update()` and overwrites it. A programmatic\nexternal change to this prop does not itself fire `onTransformChange`\n(see that prop). Defaults to `1`.',
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
