import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      type: 'string',
      description: 'Bound active tab value.',
    },
    orientation: {
      enum: ['horizontal', 'vertical'],
      description: 'Layout orientation. Affects which arrow keys move between tabs.',
      default: 'horizontal',
    },
    fill: {
      type: 'boolean',
      description:
        'Fill the available space when Tabs is placed inside a bounded flex parent,\nletting the active TabPanel occupy the remaining height.',
      default: false,
    },
    collapseBelow: {
      anyOf: [
        {
          type: 'string',
        },
        {
          const: false,
        },
      ],
      description:
        "Viewport width below which a horizontal tab bar collapses to a select reading \"Tab: Access\",\nso a phone shows one full-width control instead of a bar that scrolls sideways. The tabs stay\nin the page, hidden, and the panels keep their names. A simple CSS length such as `'640px'`,\nor `false` to always show the tab bar. Vertical tabs never collapse. Default `'640px'`.",
    },
    collapseLabel: {
      type: 'string',
      description:
        'The select\'s accessible name and the prefix before the current tab\'s label in its trigger.\nDefault `"Tab"`.',
    },
    activateOnFocus: {
      type: 'boolean',
      description:
        'When true (default for horizontal), focusing a tab also activates it\n(the panel updates immediately). Vertical defaults to manual activation\n— the user moves focus with arrows, then presses Enter or Space.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-tabs`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Tab and TabPanel children.',
      },
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
        description: 'Notify after the bindable value has been committed.',
      },
      {
        name: 'onValueChangeRequest',
        reason: 'function-or-snippet',
        description:
          'Intercept a proposed tab value before the bindable value is written. Return a replacement value to transform it.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
