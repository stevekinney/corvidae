import type { ComponentSchema } from '@lostgradient/component-tooling/schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description: "Accessible label applied to the board's `<section>` root via `aria-label`.",
    },
    collapsible: {
      type: 'boolean',
      description:
        'When true, each column renders a collapse/expand button that toggles its card list.',
      default: false,
    },
    reorderColumns: {
      type: 'boolean',
      description:
        'When true (default), columns can be reordered by dragging or keyboard. Set to false to make column order fixed.',
      default: true,
    },
    class: {
      type: 'string',
      description: 'Additional class merged onto the `.cinder-kanban-board` root element.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'card',
        reason: 'function-or-snippet',
        description:
          "Replaces the card's whole body. Leave it out to use the built-in layout: the card's title (its\n`getCardLabel` text) on top, then one quiet row of `cardMeta` with `cardTrailing` at its inline\nend. When `card` is set, `cardMeta` and `cardTrailing` are not drawn.",
      },
      {
        name: 'cardMeta',
        reason: 'function-or-snippet',
        description:
          "The built-in card's quiet row under the title, such as an assignee's avatar and full name. It\ndraws in muted text at the inline start of the row.",
      },
      {
        name: 'cardTrailing',
        reason: 'function-or-snippet',
        description:
          "The built-in card's inline-end item on the meta row, such as a priority badge.",
      },
      {
        name: 'columnActions',
        reason: 'function-or-snippet',
      },
      {
        name: 'columnHeader',
        reason: 'function-or-snippet',
      },
      {
        name: 'columns',
        reason: 'unknown-shape',
        required: true,
      },
      {
        name: 'emptyColumn',
        reason: 'function-or-snippet',
      },
      {
        name: 'getCardKey',
        reason: 'function-or-snippet',
        required: true,
      },
      {
        name: 'getCardLabel',
        reason: 'function-or-snippet',
        required: true,
      },
      {
        name: 'onColumnsChange',
        reason: 'function-or-snippet',
        required: true,
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
