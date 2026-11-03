import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description:
        'Accessible name of the bar, read as the name of its group: "Run actions", "Decision".',
      default: 'Actions',
    },
    variant: {
      enum: ['strip', 'card'],
      description:
        "How the bar is drawn: a flush strip with only a top border, or a bordered, raised card. The bar\ndocks to the bottom of a short page when its parent is a flex column at least as tall as the\nscrolling area; the parent's `gap` sets the space above the bar.",
      default: 'strip',
    },
    off: {
      type: 'boolean',
      description:
        "Turns the bar's actions off together, for one reason. Controls inside that opted in with\n`mutating` go inert (`aria-disabled`, still focusable, described by `reason`), exactly as under\na `<StaleRegion>`, and the bar draws `reason` under its row. A field in the bar is the page's to\nmake read-only; the bar mutes an `Input` or `Textarea` inside it while it is off. The bar keeps\nits place and its height, so nothing under it moves.",
      default: false,
    },
    reason: {
      type: 'string',
      description:
        'Why the actions are off, drawn under the row and read as the description of every inert\ncontrol: "Reconnecting… Send a message and Cancel run are off until the connection is back."\nIt is announced politely when it appears. Ignored while the bar is not `off`.',
    },
    equalActions: {
      type: 'boolean',
      description:
        'Gives the actions equal widths, so a pair such as Deny and Approve share the row evenly. On a\nnarrow bar the actions take their own row under the content and share it; with no content they\nfill the bar.',
      default: false,
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-docked-action-bar`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'actions',
        reason: 'function-or-snippet',
        required: true,
        description: 'The buttons, kept together at the end of the row.',
      },
      {
        name: 'children',
        reason: 'function-or-snippet',
        description:
          'The leading part of the bar: a field, a consequence line. It takes the room the actions leave.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
