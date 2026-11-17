import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    reorderMode: {
      enum: ['handle', 'buttons', 'both'],
      description:
        "How a row is reordered; see `SortableReorderMode`. With `buttons` or `both` the row's context\ncarries a `moveButtons` snippet, which the row content renders where the buttons belong.",
      default: 'handle',
    },
    label: {
      type: 'string',
      description: 'Accessible name for the list (applied as aria-label on the list root).',
    },
    class: {
      type: 'string',
      description: 'Additional class merged onto the `.cinder-sortable-list` root element.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'announcements',
        reason: 'unknown-shape',
        description: 'Optional overrides for announcement strings.',
      },
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Row content snippet. Receives the item and a per-row context.',
      },
      {
        name: 'formatHandleLabel',
        reason: 'function-or-snippet',
        description:
          'Optional formatter for the drag handle\'s accessible name. Default: "Reorder {itemLabel}".',
      },
      {
        name: 'formatMoveDownLabel',
        reason: 'function-or-snippet',
        description:
          'Optional formatter for the Move down button\'s accessible name. Default: "Move {itemLabel} down".',
      },
      {
        name: 'formatMoveUpLabel',
        reason: 'function-or-snippet',
        description:
          'Optional formatter for the Move up button\'s accessible name. Default: "Move {itemLabel} up".',
      },
      {
        name: 'getItemLabel',
        reason: 'function-or-snippet',
        required: true,
        description:
          'Returns an accessible label for each item (e.g., "Buy milk").\nThe second argument is the item\'s original index in the `items` array\n(not its current visual position during a drag).\nUsed in handle aria-label and announcements.',
      },
      {
        name: 'getKey',
        reason: 'function-or-snippet',
        required: true,
        description: 'Returns a stable key for each item. Must not change across reorders.',
      },
      {
        name: 'handle',
        reason: 'function-or-snippet',
        description:
          'Optional snippet rendered inside the drag-handle button. Receives { pressed, label }.',
      },
      {
        name: 'items',
        reason: 'generic-type-parameter',
        required: true,
        description: 'The list of items to render.',
      },
      {
        name: 'onReorder',
        reason: 'function-or-snippet',
        required: true,
        description: 'Fires with the full reordered array and change metadata on drop.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
