import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      type: 'string',
      description: 'Submitted value; surfaced through the registration record.',
    },
    disabled: {
      type: 'boolean',
      description: 'When true, the item is skipped by arrow keys and cannot be activated.',
    },
    description: {
      type: 'string',
      description: 'Optional secondary text shown below the main label.',
    },
    accessibleLabel: {
      type: 'string',
      description:
        'Accessible name for the option when the rendered row contains secondary text or rich content.',
    },
    keyboardShortcut: {
      type: 'string',
      description: 'Keyboard shortcut exposed through `aria-keyshortcuts`, e.g. `Meta+N`.',
    },
    keys: {
      type: 'array',
      items: {
        type: 'string',
      },
      description:
        'A key sequence shown at the end of the row, read as "G then H": each key in a `Kbd`, with "then"\nbetween them. One key shows alone ("C"). It is text in the row, so it joins the option\'s\naccessible name unless `accessibleLabel` is set; it does not set `aria-keyshortcuts`, which\ndescribes a chord, not a sequence. Pass `keyboardShortcut` as well for a chord.',
    },
    leadingTone: {
      enum: ['neutral', 'warning'],
      description:
        'How the leading content is drawn. `neutral` is a bare glyph in muted ink; `warning` is the\nglyph on a small amber tile, for a row that is waiting on the person.',
      default: 'neutral',
    },
    class: {
      type: 'string',
      description: 'Class merged with `.cinder-command-item`.',
    },
    selectionMode: {
      enum: ['item', 'parent'],
      description:
        "`selectionMode` is a compile-time discriminant that only controls whether\n`onSelect` is required; it has no runtime effect on activation dispatch.\n`'item'` is the default CommandPalette mode, in which this component's\nown `onSelect` is required.",
    },
  },
  additionalProperties: false,
  required: ['value'],
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Main label content.',
      },
      {
        name: 'leading',
        reason: 'function-or-snippet',
        description: 'Leading content (icon, avatar). Rendered with aria-hidden.',
      },
      {
        name: 'meta',
        reason: 'function-or-snippet',
        description:
          'Secondary text on the label\'s own line, after it and muted ("Refund order 4471 for $42.00?\n· Approval · waiting"). The label and the meta truncate together as one line. Rendered with\naria-hidden, so name the row with `accessibleLabel` when the meta carries meaning.',
      },
      {
        name: 'onSelect',
        reason: 'function-or-snippet',
        description: 'Invoked when the item is activated inside CommandPalette.',
      },
      {
        name: 'trailing',
        reason: 'function-or-snippet',
        description: 'Trailing content (kbd hint, badge). Rendered with aria-hidden.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
