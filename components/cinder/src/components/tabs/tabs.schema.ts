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
    collapseOnOverflow: {
      type: 'boolean',
      description:
        'Collapses a horizontal tab bar into a select reading "Tab: Access" when the bar does not fit\nits container, measured as FilterBar measures its row: the bar\'s content width against the\nwidth it has. Tabs that fit stay a bar at every width, so a phone with three short tabs keeps\nthem. The tabs stay in the page, hidden, and the panels keep their names. Set `false` to keep\na bar that scrolls sideways instead. Vertical tabs never collapse.',
      default: true,
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
        "Viewport width below which a horizontal tab bar always collapses to the select, whether or not\nit fits. A simple CSS length such as `'640px'`, or `false` for no viewport rule. Vertical tabs\nnever collapse. Default `false`.",
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
