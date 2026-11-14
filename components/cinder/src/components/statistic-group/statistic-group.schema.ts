import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description:
        'Optional accessible label for the whole stat set. When provided, the\ncontainer becomes `role="group"` and uses this value as its accessible name.',
    },
    columns: {
      enum: [1, 2, 3, 4, 'auto'],
      description: "Grid column count. `'auto'` uses auto-fit with minmax for responsive layout.",
      default: 'auto',
    },
    variant: {
      enum: ['default', 'cards', 'shared-borders', 'plain'],
      description:
        "Visual variant; surfaced as `data-cinder-variant` for CSS styling.\n- `'default'` — a bordered resting surface, with dividers between stats when\n  `columns` is a fixed count. `columns='auto'` has no dividers: an auto-fit grid's\n  column count is unbounded, so CSS cannot tell which cells end a row.\n- `'cards'` — each stat gets a card of its own, with the one edge `edge` names.\n- `'shared-borders'` — single outer border with 1px gap dividers between stats.\n- `'plain'` — no surface, border, padding or divider, and values a step smaller, for a\n  stat or two set in the page flow under a `Spotlight` without competing with it.",
      default: 'default',
    },
    edge: {
      enum: ['border', 'shadow'],
      description:
        "With `variant=\"cards\"`, the one edge each stat's card draws: a flat `'border'`, or a `'shadow'`\nwith no visible border, as a raised card has. The other variants have their own borders and\nignore it.",
      default: 'border',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-statistic-group`.',
    },
    style: {
      type: 'string',
      description: 'Inline style string applied to the `.cinder-statistic-group` root.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Statistic children, typically one or more `<Statistic>` components.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
