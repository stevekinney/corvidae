import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    class: {
      type: 'string',
      description: "Additional class names merged with the component's root class.",
    },
    caretVisible: {
      type: 'boolean',
      description: 'Render the trailing disclosure caret. Defaults to true.',
    },
    mutating: {
      type: 'boolean',
      description:
        "Marks a menu of actions that change something. Inside a stale `<StaleRegion>` the trigger\ngoes inert: it keeps focus and carries `aria-disabled`, the menu does not open, and the\nregion's reason describes it. It returns by itself when the region stops being stale.",
      default: false,
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
